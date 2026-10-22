import Foundation

public struct PlaybackReservation: Sendable {
    public let token: Int
    public let generation: Int
    public let data: Data
}

public struct PlaybackScheduler: Sendable {
    public let maximumBytes: Int
    public let maximumScheduledBytes: Int
    public private(set) var generation: Int
    public private(set) var paused: Bool
    public private(set) var queuedBytes = 0
    public private(set) var scheduledBytes = 0

    private var queued: [Data] = []
    private var scheduled: [Int: Int] = [:]
    private var nextToken = 1

    public init(
        maximumBytes: Int = 96_000,
        maximumScheduledBytes: Int = 19_200,
        generation: Int = 0,
        paused: Bool = false
    ) {
        precondition(maximumBytes > 0)
        precondition(maximumScheduledBytes > 0 && maximumScheduledBytes <= maximumBytes)
        self.maximumBytes = maximumBytes
        self.maximumScheduledBytes = maximumScheduledBytes
        self.generation = generation
        self.paused = paused
    }

    public var byteCount: Int { queuedBytes + scheduledBytes }
    public var queuedCount: Int { queued.count }
    public var scheduledCount: Int { scheduled.count }

    public mutating func enqueue(_ data: Data, generation candidate: Int) -> [PlaybackReservation] {
        guard candidate == generation,
              !paused,
              !data.isEmpty,
              data.count <= maximumScheduledBytes else {
            return []
        }
        while byteCount + data.count > maximumBytes, !queued.isEmpty {
            queuedBytes -= queued.removeFirst().count
        }
        guard byteCount + data.count <= maximumBytes else { return [] }
        queued.append(data)
        queuedBytes += data.count
        return reserveAvailable()
    }

    public mutating func consumed(token: Int, generation candidate: Int) -> [PlaybackReservation] {
        guard candidate == generation, let byteCount = scheduled.removeValue(forKey: token) else {
            return []
        }
        scheduledBytes -= byteCount
        return reserveAvailable()
    }

    public mutating func schedulingFailed(
        token: Int,
        generation candidate: Int
    ) -> [PlaybackReservation] {
        consumed(token: token, generation: candidate)
    }

    public mutating func reset(generation: Int, paused: Bool) {
        self.generation = generation
        self.paused = paused
        queued.removeAll(keepingCapacity: false)
        scheduled.removeAll(keepingCapacity: false)
        queuedBytes = 0
        scheduledBytes = 0
    }

    public mutating func setPaused(_ paused: Bool, generation candidate: Int) -> [PlaybackReservation] {
        guard candidate == generation else { return [] }
        self.paused = paused
        if paused {
            queued.removeAll(keepingCapacity: false)
            scheduled.removeAll(keepingCapacity: false)
            queuedBytes = 0
            scheduledBytes = 0
            return []
        }
        return reserveAvailable()
    }

    private mutating func reserveAvailable() -> [PlaybackReservation] {
        guard !paused else { return [] }
        var result: [PlaybackReservation] = []
        while let data = queued.first {
            if scheduledBytes + data.count > maximumScheduledBytes {
                break
            }
            queued.removeFirst()
            queuedBytes -= data.count
            let token = nextToken
            nextToken = nextToken == Int.max ? 1 : nextToken + 1
            scheduled[token] = data.count
            scheduledBytes += data.count
            result.append(PlaybackReservation(token: token, generation: generation, data: data))
        }
        return result
    }
}
