import Foundation

public struct PlaybackReservation: Sendable {
    public let token: Int
    public let generation: Int
    public let data: Data
}

/// Limits for translated audio that has arrived but has not been played yet
/// (24 kHz mono PCM16, 48 bytes per millisecond).
///
/// - `softLimitBytes` (default 96,000 bytes = 2.0 s): exceeding it reports
///   `PlaybackPressureEvent.backpressure` once per interval. Playback continues unchanged.
/// - `hardLimitBytes` (default 240,000 bytes = 5.0 s): a chunk that would exceed it makes room by
///   dropping chunks that are not scheduled on the player yet — complete silence first, then the
///   oldest voiced chunk — and reports `PlaybackPressureEvent.overflow`. Nothing is terminal.
///
/// The defaults are provisional. Soft keeps the former 2.0 s retention limit as the point where
/// added delay is observed. Hard leaves headroom over the largest ideal-playback queue measured
/// offline on 2026-10-28 (3.3 s, when the current provider delivered about 5 s of translated speech
/// within 2 s at a phrase boundary) while bounding the added delay. Neither value has been measured
/// on an iPhone yet: re-tune both from real-device runs, and do not raise them to hide latency.
public struct PlaybackQueueLimits: Sendable, Equatable {
    /// 24 kHz mono PCM16.
    public static let bytesPerMillisecond = 48
    /// Audio handed to `AVAudioPlayerNode` ahead of playback (0.4 s). It is never dropped.
    public static let scheduledWindowBytes = 19_200
    /// 2.0 s.
    public static let defaultSoftLimitBytes = 96_000
    /// 5.0 s.
    public static let defaultHardLimitBytes = 240_000
    /// 10 s: a deeper backlog alone would exceed the real-device 10-second acceptance target.
    public static let maximumHardLimitBytes = 480_000
    public static let `default` = PlaybackQueueLimits(
        validatedSoftLimitBytes: defaultSoftLimitBytes,
        hardLimitBytes: defaultHardLimitBytes
    )

    public let softLimitBytes: Int
    public let hardLimitBytes: Int

    /// Throws `TranslateProtocolError.invalidField` unless
    /// `scheduledWindowBytes <= softLimitBytes <= hardLimitBytes <= maximumHardLimitBytes`
    /// and `hardLimitBytes >= 2 * scheduledWindowBytes`.
    public init(
        softLimitBytes: Int = PlaybackQueueLimits.defaultSoftLimitBytes,
        hardLimitBytes: Int = PlaybackQueueLimits.defaultHardLimitBytes
    ) throws {
        guard
            softLimitBytes >= Self.scheduledWindowBytes,
            hardLimitBytes >= softLimitBytes,
            hardLimitBytes >= 2 * Self.scheduledWindowBytes,
            hardLimitBytes <= Self.maximumHardLimitBytes
        else {
            throw TranslateProtocolError.invalidField
        }
        self.init(validatedSoftLimitBytes: softLimitBytes, hardLimitBytes: hardLimitBytes)
    }

    private init(validatedSoftLimitBytes: Int, hardLimitBytes: Int) {
        self.softLimitBytes = validatedSoftLimitBytes
        self.hardLimitBytes = hardLimitBytes
    }

    public var softLimitMs: Int { softLimitBytes / Self.bytesPerMillisecond }
    public var hardLimitMs: Int { hardLimitBytes / Self.bytesPerMillisecond }
}

/// Chunks that one enqueue dropped at the hard limit. None of them had reached the player.
public struct PlaybackDrop: Sendable, Equatable {
    /// Complete-silence (all-zero) chunks: the backlog shrank without losing speech.
    public var silentChunks: Int
    public var silentBytes: Int
    /// Chunks with at least one non-zero sample: translated audio the listener never hears.
    public var voicedChunks: Int
    public var voicedBytes: Int

    public init(silentChunks: Int = 0, silentBytes: Int = 0, voicedChunks: Int = 0, voicedBytes: Int = 0) {
        self.silentChunks = silentChunks
        self.silentBytes = silentBytes
        self.voicedChunks = voicedChunks
        self.voicedBytes = voicedBytes
    }

    public var chunks: Int { silentChunks + voicedChunks }
    public var bytes: Int { silentBytes + voicedBytes }
    public var droppedMs: Int { bytes / PlaybackQueueLimits.bytesPerMillisecond }
    public var silentMs: Int { silentBytes / PlaybackQueueLimits.bytesPerMillisecond }
    public var voicedMs: Int { voicedBytes / PlaybackQueueLimits.bytesPerMillisecond }
}

/// Content-free playback pressure observations. Neither case stops playback or the session.
public enum PlaybackPressureEvent: Sendable, Equatable {
    /// Unplayed audio exceeded the soft limit. Reported once per interval.
    case backpressure(depthBytes: Int)
    /// The hard limit dropped chunks that were not scheduled yet; playback continues.
    case overflow(PlaybackDrop)

    public static let backpressureCode = "PLAYBACK_BACKPRESSURE_SOFT"
    public static let overflowCode = "PLAYBACK_BACKPRESSURE_DROP"

    /// Diagnostic classification. It is never a `TranslateSession.errorCode`.
    public var code: String {
        switch self {
        case .backpressure: return Self.backpressureCode
        case .overflow: return Self.overflowCode
        }
    }
}

/// Content-free playback queue counters: no audio, caption text, or identifiers.
///
/// Counters accumulate across `PlaybackScheduler.reset` and `setPaused`; `depthBytes` is the
/// backlog at the time of the snapshot. Millisecond values are derived from bytes (48 per ms).
public struct PlaybackQueueStatistics: Sendable, Equatable {
    public var softLimitBytes: Int
    public var hardLimitBytes: Int
    /// Queued plus scheduled audio that the player has not consumed yet.
    public var depthBytes = 0
    public var maxDepthBytes = 0
    /// Valid chunks offered to the queue, including chunks dropped later.
    public var enqueuedChunks = 0
    public var enqueuedBytes = 0
    /// Intervals in which unplayed audio exceeded the soft limit.
    public var backpressureCount = 0
    /// Audio handed to the player while the backlog was above the soft limit: how long the
    /// listener heard audio delayed by more than the soft limit, measured in played audio.
    public var backpressurePlayedBytes = 0
    /// Enqueues that dropped chunks at the hard limit.
    public var overflowCount = 0
    public var droppedSilentChunks = 0
    public var droppedSilentBytes = 0
    public var droppedVoicedChunks = 0
    public var droppedVoicedBytes = 0
    /// Times playback ran out of audio (the backlog drained to zero) after a chunk was consumed.
    /// This includes the natural end of translated speech.
    public var underflowCount = 0

    public init(
        softLimitBytes: Int = PlaybackQueueLimits.defaultSoftLimitBytes,
        hardLimitBytes: Int = PlaybackQueueLimits.defaultHardLimitBytes
    ) {
        self.softLimitBytes = softLimitBytes
        self.hardLimitBytes = hardLimitBytes
    }

    public var depthMs: Int { Self.ms(depthBytes) }
    public var maxDepthMs: Int { Self.ms(maxDepthBytes) }
    public var enqueuedMs: Int { Self.ms(enqueuedBytes) }
    public var backpressureMs: Int { Self.ms(backpressurePlayedBytes) }
    public var droppedChunks: Int { droppedSilentChunks + droppedVoicedChunks }
    public var droppedBytes: Int { droppedSilentBytes + droppedVoicedBytes }
    public var droppedMs: Int { Self.ms(droppedBytes) }
    public var droppedSilentMs: Int { Self.ms(droppedSilentBytes) }
    public var droppedVoicedMs: Int { Self.ms(droppedVoicedBytes) }

    private static func ms(_ bytes: Int) -> Int { bytes / PlaybackQueueLimits.bytesPerMillisecond }
}

public enum PlaybackEnqueueResult: Sendable {
    /// The scheduler took the chunk. At the hard limit an incoming complete-silence chunk may be
    /// dropped instead of queued; `events` reports every drop.
    case accepted([PlaybackReservation], events: [PlaybackPressureEvent])
    case staleGeneration
    case paused
    case invalid

    public var reservations: [PlaybackReservation] {
        if case .accepted(let reservations, _) = self { return reservations }
        return []
    }

    public var events: [PlaybackPressureEvent] {
        if case .accepted(_, let events) = self { return events }
        return []
    }
}

/// Orders translated PCM for `AVAudioPlayerNode` within two limits on unplayed audio.
///
/// Unplayed audio is the queued plus scheduled bytes; up to `maximumScheduledBytes` of it is handed
/// to the player ahead of time and is never dropped. Above `softLimitBytes` the scheduler only
/// reports backpressure, once per interval; an interval ends when the backlog falls to half the
/// soft limit or less. A chunk that would push the backlog above `hardLimitBytes` first drops queued
/// complete-silence chunks oldest first, then the incoming chunk if it is complete silence, then the
/// oldest queued chunks, and reports overflow. Playback speed, chunk boundaries, and the order of
/// the remaining chunks never change.
public struct PlaybackScheduler: Sendable {
    public private(set) var softLimitBytes: Int
    public private(set) var hardLimitBytes: Int
    public let maximumScheduledBytes: Int
    public private(set) var generation: Int
    public private(set) var paused: Bool
    public private(set) var queuedBytes = 0
    public private(set) var scheduledBytes = 0

    private struct QueuedChunk: Sendable {
        let data: Data
        let silent: Bool
    }

    private var queued: [QueuedChunk] = []
    private var scheduled: [Int: Int] = [:]
    private var nextToken = 1
    private var counters = PlaybackQueueStatistics()
    private var backpressureInterval = false

    public init(
        softLimitBytes: Int = PlaybackQueueLimits.defaultSoftLimitBytes,
        hardLimitBytes: Int = PlaybackQueueLimits.defaultHardLimitBytes,
        maximumScheduledBytes: Int = PlaybackQueueLimits.scheduledWindowBytes,
        generation: Int = 0,
        paused: Bool = false
    ) {
        precondition(maximumScheduledBytes > 0)
        precondition(softLimitBytes > 0 && softLimitBytes <= hardLimitBytes)
        // Dropping every queued chunk always leaves room for one more valid chunk.
        precondition(hardLimitBytes >= 2 * maximumScheduledBytes)
        self.softLimitBytes = softLimitBytes
        self.hardLimitBytes = hardLimitBytes
        self.maximumScheduledBytes = maximumScheduledBytes
        self.generation = generation
        self.paused = paused
    }

    public init(limits: PlaybackQueueLimits, generation: Int = 0, paused: Bool = false) {
        self.init(
            softLimitBytes: limits.softLimitBytes,
            hardLimitBytes: limits.hardLimitBytes,
            generation: generation,
            paused: paused
        )
    }

    public var byteCount: Int { queuedBytes + scheduledBytes }
    public var queuedCount: Int { queued.count }
    public var scheduledCount: Int { scheduled.count }

    public var statistics: PlaybackQueueStatistics {
        var snapshot = counters
        snapshot.softLimitBytes = softLimitBytes
        snapshot.hardLimitBytes = hardLimitBytes
        snapshot.depthBytes = byteCount
        return snapshot
    }

    /// Applies new limits to later enqueues. Queued audio and counters are kept.
    public mutating func setLimits(_ limits: PlaybackQueueLimits) {
        precondition(limits.hardLimitBytes >= 2 * maximumScheduledBytes)
        softLimitBytes = limits.softLimitBytes
        hardLimitBytes = limits.hardLimitBytes
    }

    public mutating func enqueue(_ data: Data, generation candidate: Int) -> [PlaybackReservation] {
        enqueueResult(data, generation: candidate).reservations
    }

    public mutating func enqueueResult(
        _ data: Data,
        generation candidate: Int
    ) -> PlaybackEnqueueResult {
        guard candidate == generation else { return .staleGeneration }
        guard !paused else { return .paused }
        guard !data.isEmpty, data.count <= maximumScheduledBytes else { return .invalid }
        let silent = Self.isCompleteSilence(data)
        counters.enqueuedChunks += 1
        counters.enqueuedBytes += data.count

        var drop: PlaybackDrop?
        var keepIncoming = true
        if byteCount + data.count > hardLimitBytes {
            let room = makeRoom(incomingBytes: data.count, incomingSilent: silent)
            drop = room.drop
            keepIncoming = !room.droppedIncoming
        }
        if keepIncoming {
            queued.append(QueuedChunk(data: data, silent: silent))
            queuedBytes += data.count
        }
        counters.maxDepthBytes = max(counters.maxDepthBytes, byteCount)

        var events: [PlaybackPressureEvent] = []
        if byteCount > softLimitBytes && !backpressureInterval {
            backpressureInterval = true
            counters.backpressureCount += 1
            events.append(.backpressure(depthBytes: byteCount))
        }
        if let drop {
            counters.overflowCount += 1
            counters.droppedSilentChunks += drop.silentChunks
            counters.droppedSilentBytes += drop.silentBytes
            counters.droppedVoicedChunks += drop.voicedChunks
            counters.droppedVoicedBytes += drop.voicedBytes
            events.append(.overflow(drop))
        }
        return .accepted(reserveAvailable(), events: events)
    }

    public mutating func consumed(token: Int, generation candidate: Int) -> [PlaybackReservation] {
        release(token: token, generation: candidate, played: true)
    }

    public mutating func schedulingFailed(
        token: Int,
        generation candidate: Int
    ) -> [PlaybackReservation] {
        release(token: token, generation: candidate, played: false)
    }

    public mutating func reset(generation: Int, paused: Bool) {
        self.generation = generation
        self.paused = paused
        discardAll()
    }

    public mutating func setPaused(_ paused: Bool, generation candidate: Int) -> [PlaybackReservation] {
        guard candidate == generation else { return [] }
        self.paused = paused
        if paused {
            discardAll()
            return []
        }
        return reserveAvailable()
    }

    private mutating func release(
        token: Int,
        generation candidate: Int,
        played: Bool
    ) -> [PlaybackReservation] {
        guard candidate == generation, let released = scheduled.removeValue(forKey: token) else {
            return []
        }
        if played && byteCount > softLimitBytes {
            counters.backpressurePlayedBytes += released
        }
        scheduledBytes -= released
        let next = reserveAvailable()
        if byteCount == 0 {
            counters.underflowCount += 1
        }
        if byteCount * 2 <= softLimitBytes {
            backpressureInterval = false
        }
        return next
    }

    /// Frees room for an incoming chunk without touching scheduled chunks.
    private mutating func makeRoom(
        incomingBytes: Int,
        incomingSilent: Bool
    ) -> (drop: PlaybackDrop, droppedIncoming: Bool) {
        var drop = PlaybackDrop()
        var excess = byteCount + incomingBytes - hardLimitBytes
        var index = 0
        while excess > 0, index < queued.count {
            guard queued[index].silent else {
                index += 1
                continue
            }
            let chunk = queued.remove(at: index)
            queuedBytes -= chunk.data.count
            excess -= chunk.data.count
            drop.silentChunks += 1
            drop.silentBytes += chunk.data.count
        }
        var droppedIncoming = false
        if excess > 0, incomingSilent {
            droppedIncoming = true
            excess -= incomingBytes
            drop.silentChunks += 1
            drop.silentBytes += incomingBytes
        }
        // Every queued complete-silence chunk is gone if room is still short.
        while excess > 0, !queued.isEmpty {
            let chunk = queued.removeFirst()
            queuedBytes -= chunk.data.count
            excess -= chunk.data.count
            drop.voicedChunks += 1
            drop.voicedBytes += chunk.data.count
        }
        assert(excess <= 0)
        return (drop, droppedIncoming)
    }

    private mutating func discardAll() {
        queued.removeAll(keepingCapacity: false)
        scheduled.removeAll(keepingCapacity: false)
        queuedBytes = 0
        scheduledBytes = 0
        backpressureInterval = false
    }

    private mutating func reserveAvailable() -> [PlaybackReservation] {
        guard !paused else { return [] }
        var result: [PlaybackReservation] = []
        while let chunk = queued.first {
            if scheduledBytes + chunk.data.count > maximumScheduledBytes {
                break
            }
            queued.removeFirst()
            queuedBytes -= chunk.data.count
            let token = nextToken
            nextToken = nextToken == Int.max ? 1 : nextToken + 1
            scheduled[token] = chunk.data.count
            scheduledBytes += chunk.data.count
            result.append(PlaybackReservation(token: token, generation: generation, data: chunk.data))
        }
        return result
    }

    private static func isCompleteSilence(_ data: Data) -> Bool {
        data.withUnsafeBytes { bytes in bytes.allSatisfy { $0 == 0 } }
    }
}
