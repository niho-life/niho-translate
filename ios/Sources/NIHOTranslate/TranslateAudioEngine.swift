import Foundation
import NIHOTranslateCore

#if os(iOS)
import AVFoundation
import UIKit

public final class TranslateAudioEngine: @unchecked Sendable {
    public enum SpeechBoundary: Sendable {
        case start(Int64)
        case end(Int64)
    }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let pipeline = DispatchQueue(label: "NIHOTranslate.audio")
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 24_000,
        channels: 1,
        interleaved: true
    )!
    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 24_000,
        channels: 1,
        interleaved: false
    )!
    private var captureConverter: AVAudioConverter?
    private var captureBytes = Data()
    private var playbackScheduler = PlaybackScheduler()
    private var sessionGeneration = 0
    private var playbackGeneration = 0
    private var running = false
    private var captureActive = false
    private var listeningPaused = false
    private var speaking = false
    private var silentSinceMs: Int64?

    public var onAudioBatch: (@Sendable (Data) -> Void)?
    public var onSpeechBoundary: (@Sendable (SpeechBoundary) -> Void)?
    public var onRouteRequiresPause: (@Sendable () -> Void)?

    public init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(routeChanged),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(interrupted),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(backgrounded),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        stop(generation: sessionGeneration)
    }

    @discardableResult
    public func preparePlayback(generation: Int) throws -> Int {
        try pipeline.sync {
            try preparePlaybackLocked(generation: generation)
        }
    }

    @discardableResult
    public func resumeCapture(generation: Int) throws -> Int {
        try pipeline.sync {
            let currentPlaybackGeneration = try preparePlaybackLocked(generation: generation)
            guard !captureActive else { return currentPlaybackGeneration }
            let session = AVAudioSession.sharedInstance()
            guard privateRoute(session.currentRoute) != .none else {
                throw TranslateProtocolError.invalidField
            }
            let input = engine.inputNode
            let sourceFormat = input.outputFormat(forBus: 0)
            guard let converter = AVAudioConverter(from: sourceFormat, to: wireFormat) else {
                throw TranslateProtocolError.invalidAudio
            }
            captureConverter = converter
            input.installTap(onBus: 0, bufferSize: 480, format: sourceFormat) { [weak self] buffer, _ in
                guard let copied = Self.copy(buffer) else { return }
                self?.pipeline.async {
                    self?.convertAndBatch(copied, generation: generation)
                }
            }
            captureActive = true
            return currentPlaybackGeneration
        }
    }

    @discardableResult
    public func start(generation: Int) throws -> Int {
        try resumeCapture(generation: generation)
    }

    public func stop(generation: Int) {
        pipeline.sync {
            stopLocked(generation: generation, force: false)
        }
    }

    public func pauseCapture(generation: Int) {
        pipeline.sync {
            guard generation == sessionGeneration, captureActive else { return }
            engine.inputNode.removeTap(onBus: 0)
            captureConverter = nil
            captureBytes.removeAll(keepingCapacity: false)
            captureActive = false
            if speaking {
                speaking = false
                silentSinceMs = nil
                onSpeechBoundary?(.end(Self.nowMs()))
            }
        }
    }

    public func enqueueTranslatedPCM(_ data: Data, playbackGeneration: Int) {
        pipeline.async { [weak self] in
            guard
                let self,
                playbackGeneration == self.playbackGeneration,
                !self.listeningPaused,
                !data.isEmpty,
                data.count <= maxPcmBatchBytes,
                data.count % 2 == 0
            else {
                return
            }
            let reservations = self.playbackScheduler.enqueue(data, generation: playbackGeneration)
            self.schedulePlayback(reservations)
        }
    }

    @discardableResult
    public func invalidatePlayback() -> Int {
        pipeline.sync {
            playbackGeneration += 1
            player.stop()
            playbackScheduler.reset(generation: playbackGeneration, paused: listeningPaused)
            if running && !listeningPaused { player.play() }
            return playbackGeneration
        }
    }

    @discardableResult
    public func setListeningPaused(_ paused: Bool) -> Int {
        pipeline.sync {
            listeningPaused = paused
            if paused {
                playbackGeneration += 1
                player.stop()
                playbackScheduler.reset(generation: playbackGeneration, paused: true)
            } else if running {
                _ = playbackScheduler.setPaused(false, generation: playbackGeneration)
                player.play()
            }
            return playbackGeneration
        }
    }

    @discardableResult
    public func resumeAfterPrivateRouteConsent() throws -> Int {
        guard privateRoute(AVAudioSession.sharedInstance().currentRoute) != .none else {
            throw TranslateProtocolError.invalidField
        }
        return try preparePlayback(generation: sessionGeneration)
    }

    private func preparePlaybackLocked(generation: Int) throws -> Int {
        let session = AVAudioSession.sharedInstance()
        if running && sessionGeneration == generation {
            guard privateRoute(session.currentRoute) != .none else {
                stopLocked(generation: generation, force: true)
                onRouteRequiresPause?()
                throw TranslateProtocolError.invalidField
            }
            if !listeningPaused && !player.isPlaying { player.play() }
            return playbackGeneration
        }

        stopLocked(generation: sessionGeneration, force: true)
        sessionGeneration = generation
        do {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try session.setActive(true)
            guard privateRoute(session.currentRoute) != .none else {
                throw TranslateProtocolError.invalidField
            }
            try engine.inputNode.setVoiceProcessingEnabled(true)
            try engine.start()
            running = true
            if !listeningPaused { player.play() }
            return playbackGeneration
        } catch {
            engine.stop()
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            running = false
            onRouteRequiresPause?()
            throw error
        }
    }

    private func stopLocked(generation: Int, force: Bool) {
        guard force || generation == sessionGeneration else { return }
        if captureActive {
            engine.inputNode.removeTap(onBus: 0)
        }
        player.stop()
        engine.stop()
        captureConverter = nil
        captureBytes.removeAll(keepingCapacity: false)
        playbackGeneration += 1
        playbackScheduler.reset(generation: playbackGeneration, paused: listeningPaused)
        running = false
        captureActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if speaking {
            speaking = false
            silentSinceMs = nil
            onSpeechBoundary?(.end(Self.nowMs()))
        }
    }

    private func convertAndBatch(_ input: AVAudioPCMBuffer, generation: Int) {
        guard
            generation == sessionGeneration,
            running,
            captureActive,
            let converter = captureConverter
        else {
            return
        }
        let capacity = AVAudioFrameCount(
            Double(input.frameLength) * wireFormat.sampleRate / input.format.sampleRate + 1
        )
        guard let output = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var conversionError: NSError?
        converter.convert(to: output, error: &conversionError) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return input
        }
        guard
            conversionError == nil,
            let pointer = output.audioBufferList.pointee.mBuffers.mData
        else {
            return
        }
        captureBytes.append(Data(bytes: pointer, count: Int(output.frameLength) * 2))
        while captureBytes.count >= pcmBatchBytes {
            let batch = Data(captureBytes.prefix(pcmBatchBytes))
            captureBytes.removeFirst(pcmBatchBytes)
            updateSpeechEstimate(batch)
            onAudioBatch?(batch)
        }
    }

    private func updateSpeechEstimate(_ pcm: Data) {
        var squareSum = 0.0
        var samples = 0
        pcm.withUnsafeBytes { raw in
            let values = raw.bindMemory(to: Int16.self)
            samples = values.count
            for value in values {
                let normalized = Double(value) / Double(Int16.max)
                squareSum += normalized * normalized
            }
        }
        guard samples > 0 else { return }
        let rms = sqrt(squareSum / Double(samples))
        let now = Self.nowMs()
        if rms >= 0.015 {
            silentSinceMs = nil
            if !speaking {
                speaking = true
                onSpeechBoundary?(.start(now))
            }
        } else if speaking {
            if silentSinceMs == nil { silentSinceMs = now }
            if let silentSinceMs, now - silentSinceMs >= 500 {
                speaking = false
                self.silentSinceMs = nil
                onSpeechBoundary?(.end(now))
            }
        }
    }

    private func schedulePlayback(_ reservations: [PlaybackReservation]) {
        for reservation in reservations {
            let frames = AVAudioFrameCount(reservation.data.count / 2)
            guard
                let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: frames),
                let destination = buffer.floatChannelData?[0]
            else {
                let next = playbackScheduler.schedulingFailed(
                    token: reservation.token,
                    generation: reservation.generation
                )
                schedulePlayback(next)
                continue
            }
            buffer.frameLength = frames
            reservation.data.withUnsafeBytes { raw in
                let source = raw.bindMemory(to: Int16.self)
                for index in 0..<source.count {
                    destination[index] = Float(source[index]) / Float(Int16.max)
                }
            }
            player.scheduleBuffer(buffer, completionCallbackType: .dataConsumed) { [weak self] _ in
                self?.pipeline.async {
                    guard let self else { return }
                    let next = self.playbackScheduler.consumed(
                        token: reservation.token,
                        generation: reservation.generation
                    )
                    self.schedulePlayback(next)
                }
            }
        }
    }

    @objc private func routeChanged() {
        guard privateRoute(AVAudioSession.sharedInstance().currentRoute) == .none else { return }
        stop(generation: sessionGeneration)
        onRouteRequiresPause?()
    }

    @objc private func interrupted() {
        stop(generation: sessionGeneration)
        onRouteRequiresPause?()
    }

    @objc private func backgrounded() {
        guard privateRoute(AVAudioSession.sharedInstance().currentRoute) == .none else { return }
        stop(generation: sessionGeneration)
        onRouteRequiresPause?()
    }

    private func privateRoute(_ route: AVAudioSessionRouteDescription) -> PrivateAudioRoute {
        let hasBluetoothOutput = route.outputs.contains { $0.portType == .bluetoothHFP }
        let hasHeadphoneOutput = route.outputs.contains { $0.portType == .headphones }
        let hasBluetoothInput = route.inputs.contains { $0.portType == .bluetoothHFP }
        let hasHeadsetInput = route.inputs.contains { $0.portType == .headsetMic }
        if hasBluetoothOutput && hasBluetoothInput { return .bluetoothHFP }
        if hasHeadphoneOutput && hasHeadsetInput { return .headphones }
        return .none
    }

    private static func copy(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(
            pcmFormat: source.format,
            frameCapacity: source.frameCapacity
        ) else {
            return nil
        }
        copy.frameLength = source.frameLength
        let sourceList = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
        let destinationList = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        guard sourceList.count == destinationList.count else { return nil }
        for index in sourceList.indices {
            guard
                let sourceData = sourceList[index].mData,
                let destinationData = destinationList[index].mData
            else {
                return nil
            }
            let byteCount = Int(sourceList[index].mDataByteSize)
            memcpy(destinationData, sourceData, byteCount)
            destinationList[index].mDataByteSize = sourceList[index].mDataByteSize
        }
        return copy
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }
}
#else
public final class TranslateAudioEngine: @unchecked Sendable {
    public enum SpeechBoundary: Sendable {
        case start(Int64)
        case end(Int64)
    }

    public var onAudioBatch: (@Sendable (Data) -> Void)?
    public var onSpeechBoundary: (@Sendable (SpeechBoundary) -> Void)?
    public var onRouteRequiresPause: (@Sendable () -> Void)?

    public init() {}
    public func preparePlayback(generation: Int) throws -> Int { throw TranslateProtocolError.invalidField }
    public func resumeCapture(generation: Int) throws -> Int { throw TranslateProtocolError.invalidField }
    public func start(generation: Int) throws -> Int { throw TranslateProtocolError.invalidField }
    public func stop(generation: Int) {}
    public func pauseCapture(generation: Int) {}
    public func enqueueTranslatedPCM(_ data: Data, playbackGeneration: Int) {}
    public func invalidatePlayback() -> Int { 0 }
    public func setListeningPaused(_ paused: Bool) -> Int { 0 }
    public func resumeAfterPrivateRouteConsent() throws -> Int { throw TranslateProtocolError.invalidField }
}
#endif
