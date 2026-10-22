import Foundation
import NIHOTranslateCore
#if canImport(Combine)
import Combine
#endif
#if os(iOS)
import AVFoundation
#endif

public struct TranslateConnectionConfig: Sendable {
    public let relayURL: URL
    public let scopedTicket: String
    public let roomId: String
    public let participantId: String
    public let role: ParticipantRole
    public let sourceLanguage: TranslateLanguage
    public let targetLanguage: TranslateLanguage

    public init(
        relayURL: URL,
        scopedTicket: String,
        roomId: String,
        participantId: String,
        role: ParticipantRole,
        sourceLanguage: TranslateLanguage,
        targetLanguage: TranslateLanguage
    ) throws {
        guard
            relayURL.scheme == "wss",
            relayURL.host?.isEmpty == false,
            relayURL.user == nil, relayURL.password == nil,
            relayURL.query == nil, relayURL.fragment == nil,
            !scopedTicket.isEmpty,
            scopedTicket.utf8.count <= 8_192,
            scopedTicket.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
            !roomId.isEmpty,
            roomId.count <= 128,
            !participantId.isEmpty,
            participantId.count <= 128,
            sourceLanguage != targetLanguage
        else {
            throw TranslateProtocolError.invalidField
        }
        self.relayURL = relayURL
        self.scopedTicket = scopedTicket
        self.roomId = roomId
        self.participantId = participantId
        self.role = role
        self.sourceLanguage = sourceLanguage
        self.targetLanguage = targetLanguage
    }
}

public struct TranslateCaption: Identifiable, Sendable {
    public let id: UUID
    public let speakerId: String
    public let generation: Int
    public let language: TranslateLanguage
    public let captionOnly: Bool
    public let text: String
    public let receivedAt: Date
}

protocol TranslateSessionTransport: AnyObject, Sendable {
    var onEvent: (@Sendable (ServerEnvelope) -> Void)? { get set }
    var onState: (@Sendable (TranslateProtocolClient.State) -> Void)? { get set }
    func connect(url: URL, ticket: String) throws
    func send(_ event: ClientEnvelope) async throws
    func disconnect()
}

extension TranslateProtocolClient: TranslateSessionTransport {}

protocol TranslateSessionAudio: AnyObject, Sendable {
    var onAudioBatch: (@Sendable (Data) -> Void)? { get set }
    var onSpeechBoundary: (@Sendable (TranslateAudioEngine.SpeechBoundary) -> Void)? { get set }
    var onRouteRequiresPause: (@Sendable () -> Void)? { get set }
    var onPlaybackOverflow: (@Sendable (Int) -> Void)? { get set }
    func preparePlayback(generation: Int) throws -> Int
    func resumeCapture(generation: Int) throws -> Int
    func stop(generation: Int)
    func pauseCapture(generation: Int)
    func enqueueTranslatedPCM(_ data: Data, playbackGeneration: Int)
    func invalidatePlayback() -> Int
    func setListeningPaused(_ paused: Bool) -> Int
}

extension TranslateAudioEngine: TranslateSessionAudio {}

@MainActor
protocol MicrophonePermissionProviding: AnyObject {
    var permission: TranslateSession.MicrophonePermission { get }
    func request(_ completion: @escaping @Sendable (Bool) -> Void)
}

@MainActor
private final class SystemMicrophonePermissionProvider: MicrophonePermissionProviding {
    var permission: TranslateSession.MicrophonePermission {
        #if os(iOS)
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        case .undetermined: return .undetermined
        @unknown default: return .denied
        }
        #else
        return .denied
        #endif
    }

    func request(_ completion: @escaping @Sendable (Bool) -> Void) {
        #if os(iOS)
        AVAudioSession.sharedInstance().requestRecordPermission(completion)
        #else
        completion(false)
        #endif
    }
}

@MainActor
public final class TranslateSession: ObservableObject {
    public enum ConnectionStatus: Sendable, Equatable {
        case disconnected
        case connecting
        case connected
        case failed
    }

    public enum MicrophonePermission: Sendable, Equatable {
        case undetermined
        case denied
        case granted
    }

    @Published public private(set) var connectionStatus: ConnectionStatus = .disconnected
    @Published public private(set) var microphonePermission: MicrophonePermission = .undetermined
    @Published public private(set) var roomActive = false
    @Published public private(set) var roomPaused = false
    @Published public private(set) var roomEnded = false
    @Published public private(set) var canCapture = false
    @Published public private(set) var micMuted = true
    @Published public private(set) var listeningPaused = false
    @Published public private(set) var participants: [ParticipantEnvelope] = []
    @Published public private(set) var captions: [TranslateCaption] = []
    @Published public private(set) var errorCode: String?
    @Published public private(set) var explicitConsent = false

    public let config: TranslateConnectionConfig

    private let client: any TranslateSessionTransport
    private let audio: any TranslateSessionAudio
    private let permissionProvider: any MicrophonePermissionProviding
    private var selfGeneration: Int?
    private var participantById: [String: ParticipantEnvelope] = [:]
    private var speakerGate = SpeakerGenerationGate()
    private var readinessGate = ReadinessGate()
    private var playbackGeneration = 0
    private var captureRunning = false
    private var relayCanCapture = false
    private var privateRoutePaused = false
    private var ticketAttempted = false
    private var terminal = false
    private var lifecycleGeneration = 0
    private var captionTimer: Timer?

    public init(
        config: TranslateConnectionConfig,
        client: TranslateProtocolClient = TranslateProtocolClient(),
        audio: TranslateAudioEngine = TranslateAudioEngine()
    ) {
        self.config = config
        self.client = client
        self.audio = audio
        self.permissionProvider = SystemMicrophonePermissionProvider()
        finishInitialization()
    }

    init(
        config: TranslateConnectionConfig,
        transport: any TranslateSessionTransport,
        audio: any TranslateSessionAudio,
        permissionProvider: any MicrophonePermissionProviding
    ) {
        self.config = config
        self.client = transport
        self.audio = audio
        self.permissionProvider = permissionProvider
        finishInitialization()
    }

    private func finishInitialization() {
        bindCallbacks()
        captionTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, !self.terminal else { return }
                self.pruneCaptions()
            }
        }
    }

    deinit {
        captionTimer?.invalidate()
    }

    public func setExplicitConsent(_ consented: Bool) {
        guard !terminal else { return }
        if !consented && ticketAttempted {
            leave()
            return
        }
        explicitConsent = consented
        readinessGate.setExplicitConsent(consented)
        if !consented {
            micMuted = true
            stopCapture()
            if connectionStatus == .connected { send(.capturePause) }
        }
        sendReadyIfEligible()
    }

    public func requestPermissionAndConnect() {
        guard explicitConsent, !roomEnded, !terminal, !ticketAttempted else { return }
        switch permissionProvider.permission {
        case .granted:
            microphonePermission = .granted
            readinessGate.setMicrophoneGranted(true)
            connect()
        case .denied:
            microphonePermission = .denied
            readinessGate.setMicrophoneGranted(false)
        case .undetermined:
            let generation = lifecycleGeneration
            permissionProvider.request { [weak self] allowed in
                Task { @MainActor in
                    guard let self, self.isActive(generation) else { return }
                    self.microphonePermission = allowed ? .granted : .denied
                    self.readinessGate.setMicrophoneGranted(allowed)
                    if allowed { self.connect() }
                }
            }
        }
    }

    public func startRoom() {
        guard !terminal, connectionStatus == .connected else { return }
        guard config.role == .host else {
            errorCode = "HOST_ONLY"
            return
        }
        send(.roomStart)
    }

    public func pauseRoom() {
        guard !terminal, connectionStatus == .connected else { return }
        guard config.role == .host else {
            errorCode = "HOST_ONLY"
            return
        }
        send(.roomPause)
    }

    public func resumeRoom() {
        guard !terminal, connectionStatus == .connected else { return }
        guard config.role == .host else {
            errorCode = "HOST_ONLY"
            return
        }
        send(.roomResume)
    }

    public func endRoom() {
        guard !terminal, connectionStatus == .connected else { return }
        guard config.role == .host else {
            errorCode = "HOST_ONLY"
            return
        }
        send(.roomEnd)
    }

    public func setMicMuted(_ muted: Bool) {
        guard !terminal, connectionStatus == .connected else { return }
        if muted {
            micMuted = true
            captureRunning = false
            if let selfGeneration { audio.pauseCapture(generation: selfGeneration) }
            send(.capturePause)
        } else {
            guard
                explicitConsent,
                microphonePermission == .granted,
                let selfGeneration,
                !roomPaused,
                !roomEnded
            else {
                micMuted = true
                return
            }
            do {
                playbackGeneration = try audio.preparePlayback(generation: selfGeneration)
                if relayCanCapture {
                    playbackGeneration = try audio.resumeCapture(generation: selfGeneration)
                    captureRunning = true
                }
                privateRoutePaused = false
                canCapture = relayCanCapture
                micMuted = false
                clearPrivateRouteError()
                send(.captureResume)
            } catch {
                pauseForPrivateRouteLoss(sendPause: true)
            }
        }
    }

    public func setListeningPaused(_ paused: Bool) {
        guard !terminal, connectionStatus == .connected else { return }
        listeningPaused = paused
        if paused {
            playbackGeneration = audio.setListeningPaused(true)
            return
        }
        guard
            explicitConsent,
            microphonePermission == .granted,
            let selfGeneration
        else {
            listeningPaused = true
            playbackGeneration = audio.setListeningPaused(true)
            return
        }
        do {
            playbackGeneration = try audio.preparePlayback(generation: selfGeneration)
            playbackGeneration = audio.setListeningPaused(false)
            listeningPaused = false
            privateRoutePaused = false
            canCapture = relayCanCapture
            clearPrivateRouteError()
            if relayCanCapture && !micMuted { startCaptureIfPossible() }
        } catch {
            pauseForPrivateRouteLoss(sendPause: true)
        }
    }

    public func leave() {
        guard !terminal else { return }
        terminal = true
        lifecycleGeneration &+= 1
        captionTimer?.invalidate()
        captionTimer = nil
        explicitConsent = false
        readinessGate.setExplicitConsent(false)
        if let selfGeneration { audio.stop(generation: selfGeneration) }
        playbackGeneration = audio.invalidatePlayback()
        client.disconnect()
        resetTransientState()
    }

    private func connect() {
        guard
            explicitConsent,
            microphonePermission == .granted,
            connectionStatus == .disconnected,
            !roomEnded,
            !terminal,
            !ticketAttempted
        else {
            return
        }
        ticketAttempted = true
        do {
            readinessGate.resetConnection()
            readinessGate.setExplicitConsent(explicitConsent)
            readinessGate.setMicrophoneGranted(microphonePermission == .granted)
            micMuted = false
            connectionStatus = .connecting
            try client.connect(url: config.relayURL, ticket: config.scopedTicket)
        } catch {
            failConnection(code: "CONNECT_FAILED")
        }
    }

    private func bindCallbacks() {
        let callbackLifecycleGeneration = lifecycleGeneration
        client.onState = { [weak self] state in
            Task { @MainActor in
                guard let self, !self.terminal else { return }
                switch state {
                case .disconnected:
                    if self.ticketAttempted { self.failConnection(code: "CONNECTION_LOST") }
                case .connecting:
                    self.connectionStatus = .connecting
                    self.readinessGate.setTransportConnected(false)
                case .connected:
                    self.connectionStatus = .connected
                    self.readinessGate.setTransportConnected(true)
                    self.sendReadyIfEligible()
                case .failed:
                    self.failConnection(code: "CONNECTION_LOST")
                }
            }
        }
        client.onEvent = { [weak self] event in
            Task { @MainActor in
                guard
                    let self,
                    !self.terminal,
                    self.connectionStatus == .connecting || self.connectionStatus == .connected
                else { return }
                self.handle(event)
            }
        }
        audio.onAudioBatch = { [weak self] data in
            Task { @MainActor in
                guard
                    let self,
                    !self.terminal,
                    self.connectionStatus == .connected,
                    self.canCapture,
                    !self.micMuted
                else { return }
                self.send(.audio(data, atMs: Self.nowMs()))
            }
        }
        audio.onSpeechBoundary = { [weak self] boundary in
            Task { @MainActor in
                guard
                    let self,
                    !self.terminal,
                    self.connectionStatus == .connected,
                    self.canCapture,
                    !self.micMuted
                else { return }
                switch boundary {
                case .start(let atMs):
                    self.send(.speechStart(atMs))
                case .end(let atMs):
                    self.send(.speechEnd(atMs))
                }
            }
        }
        audio.onRouteRequiresPause = { [weak self] in
            Task { @MainActor in
                guard let self, !self.terminal else { return }
                self.pauseForPrivateRouteLoss(sendPause: true)
            }
        }
        audio.onPlaybackOverflow = { [weak self] generation in
            Task { @MainActor in
                guard
                    let self,
                    self.isActive(callbackLifecycleGeneration),
                    self.playbackGeneration == generation
                else { return }
                self.failPlaybackBackpressure()
            }
        }
    }

    private func handle(_ event: ServerEnvelope) {
        pruneCaptions()
        switch event.type {
        case "session.identity":
            guard
                event.participantId == config.participantId,
                let generation = event.generation
            else {
                failProtocol()
                return
            }
            if let previous = selfGeneration, previous != generation {
                audio.stop(generation: previous)
                playbackGeneration = audio.invalidatePlayback()
            }
            selfGeneration = generation
            readinessGate.setIdentityGeneration(generation)
            sendReadyIfEligible()
        case "room.state":
            guard event.roomId == config.roomId else {
                failProtocol()
                return
            }
            roomActive = event.active == true
            roomPaused = event.paused == true
            roomEnded = event.ended == true
            if roomPaused || roomEnded { stopCapture() }
            if roomEnded { leave() }
        case "participant.state":
            guard let participant = event.participant, let connected = event.connected else { return }
            let oldGeneration = participantById[participant.participantId]?.generation
            if connected {
                participantById[participant.participantId] = participant
            } else {
                participantById.removeValue(forKey: participant.participantId)
            }
            speakerGate.update(
                speakerId: participant.participantId,
                generation: participant.generation,
                connected: connected
            )
            if !connected || (oldGeneration != nil && oldGeneration != participant.generation) {
                playbackGeneration = audio.invalidatePlayback()
            }
            participants = participantById.values.sorted { $0.participantId < $1.participantId }
        case "route":
            relayCanCapture = event.canCapture == true
            canCapture = relayCanCapture && !privateRoutePaused
            if canCapture && !micMuted {
                startCaptureIfPossible()
            } else {
                stopCapture()
            }
        case "audio":
            guard
                !listeningPaused,
                let speakerId = event.speakerId,
                let generation = event.generation,
                speakerGate.accepts(speakerId: speakerId, generation: generation),
                let encoded = event.audio,
                let data = try? validateOutputPCM(encoded)
            else {
                return
            }
            audio.enqueueTranslatedPCM(data, playbackGeneration: playbackGeneration)
        case "caption.delta":
            guard
                let speakerId = event.speakerId,
                let generation = event.generation,
                speakerGate.accepts(speakerId: speakerId, generation: generation),
                let language = event.language,
                let captionOnly = event.captionOnly,
                let delta = event.delta
            else {
                return
            }
            appendCaption(
                speakerId: speakerId,
                generation: generation,
                language: language,
                captionOnly: captionOnly,
                delta: delta
            )
        case "error":
            errorCode = event.code
            if event.fatal == true { leave() }
        case "latency.status":
            return
        default:
            failProtocol()
        }
    }

    private func startCaptureIfPossible() {
        guard
            let selfGeneration,
            connectionStatus == .connected,
            explicitConsent,
            microphonePermission == .granted,
            !micMuted,
            !roomPaused,
            !roomEnded,
            !captureRunning,
            relayCanCapture,
            !privateRoutePaused,
            !terminal
        else {
            return
        }
        do {
            playbackGeneration = try audio.resumeCapture(generation: selfGeneration)
            captureRunning = true
            canCapture = true
            clearPrivateRouteError()
        } catch {
            pauseForPrivateRouteLoss(sendPause: true)
        }
    }

    private func stopCapture() {
        if let selfGeneration { audio.pauseCapture(generation: selfGeneration) }
        captureRunning = false
    }

    private func sendReadyIfEligible() {
        guard let generation = readinessGate.takeReadyGeneration() else { return }
        send(.ready)
        do {
            playbackGeneration = try audio.preparePlayback(generation: generation)
        } catch {
            pauseForPrivateRouteLoss(sendPause: true)
        }
    }

    private func appendCaption(
        speakerId: String,
        generation: Int,
        language: TranslateLanguage,
        captionOnly: Bool,
        delta: String
    ) {
        let now = Date()
        if
            let last = captions.last,
            last.speakerId == speakerId,
            last.generation == generation,
            last.language == language,
            last.captionOnly == captionOnly,
            now.timeIntervalSince(last.receivedAt) <= 2,
            last.text.count + delta.count <= 4_096
        {
            captions[captions.count - 1] = TranslateCaption(
                id: last.id,
                speakerId: speakerId,
                generation: generation,
                language: language,
                captionOnly: captionOnly,
                text: last.text + delta,
                receivedAt: now
            )
        } else {
            captions.append(TranslateCaption(
                id: UUID(),
                speakerId: speakerId,
                generation: generation,
                language: language,
                captionOnly: captionOnly,
                text: delta,
                receivedAt: now
            ))
        }
        if captions.count > 100 {
            captions.removeFirst(captions.count - 100)
        }
    }

    private func send(_ event: ClientEnvelope) {
        guard !terminal, connectionStatus == .connected else { return }
        let generation = lifecycleGeneration
        Task { [weak self] in
            guard let self, self.isActive(generation), self.connectionStatus == .connected else {
                return
            }
            do {
                try await self.client.send(event)
            } catch {
                guard self.isActive(generation), self.connectionStatus == .connected else {
                    return
                }
                if self.errorCode == nil {
                    self.errorCode = "SEND_FAILED"
                }
                self.stopCapture()
            }
        }
    }

    private func failProtocol() {
        errorCode = "INVALID_MESSAGE"
        leave()
    }

    private func failConnection(code: String) {
        let reason = errorCode == "PRIVATE_AUDIO_ROUTE_REQUIRED" ? code : (errorCode ?? code)
        leave()
        connectionStatus = .failed
        errorCode = reason
    }

    private func failPlaybackBackpressure() {
        let reason = errorCode ?? "PLAYBACK_BACKPRESSURE"
        leave()
        connectionStatus = .failed
        errorCode = reason
    }

    private func pruneCaptions() {
        let cutoff = Date().addingTimeInterval(-120)
        captions.removeAll { $0.receivedAt < cutoff }
    }

    private func resetTransientState() {
        connectionStatus = .disconnected
        roomActive = false
        roomPaused = false
        canCapture = false
        micMuted = true
        listeningPaused = true
        captureRunning = false
        relayCanCapture = false
        privateRoutePaused = true
        readinessGate.resetConnection()
        selfGeneration = nil
        participantById.removeAll(keepingCapacity: false)
        speakerGate.removeAll()
        participants = []
        captions = []
    }

    private func pauseForPrivateRouteLoss(sendPause: Bool) {
        if let selfGeneration {
            audio.stop(generation: selfGeneration)
        }
        captureRunning = false
        privateRoutePaused = true
        micMuted = true
        listeningPaused = true
        canCapture = false
        playbackGeneration = audio.setListeningPaused(true)
        if errorCode == nil || errorCode == "PRIVATE_AUDIO_ROUTE_REQUIRED" {
            errorCode = "PRIVATE_AUDIO_ROUTE_REQUIRED"
        }
        if sendPause { send(.capturePause) }
    }

    private func clearPrivateRouteError() {
        if errorCode == "PRIVATE_AUDIO_ROUTE_REQUIRED" {
            errorCode = nil
        }
    }

    private func isActive(_ generation: Int) -> Bool {
        !terminal && lifecycleGeneration == generation
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }
}
