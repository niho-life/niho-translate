import Foundation

public struct BoundedPCMQueue: Sendable {
    public let maximumBytes: Int
    private var chunks: [Data] = []
    public private(set) var byteCount = 0

    public init(maximumBytes: Int = pcmSampleRate * 2) {
        self.maximumBytes = maximumBytes
    }

    @discardableResult
    public mutating func append(_ data: Data) -> Bool {
        guard !data.isEmpty, data.count <= maximumBytes else { return false }
        while byteCount + data.count > maximumBytes, !chunks.isEmpty {
            byteCount -= chunks.removeFirst().count
        }
        chunks.append(data)
        byteCount += data.count
        return true
    }

    public mutating func popFirst() -> Data? {
        guard !chunks.isEmpty else { return nil }
        let data = chunks.removeFirst()
        byteCount -= data.count
        return data
    }

    public mutating func removeAll() {
        chunks.removeAll(keepingCapacity: false)
        byteCount = 0
    }

    public var count: Int { chunks.count }
}

public struct BoundedOutgoingQueue: Sendable {
    public let maximumBytes: Int
    private var items: [Data] = []
    public private(set) var queuedBytes = 0
    public private(set) var inFlightBytes = 0

    public init(maximumBytes: Int = maxJSONBytes * 4) {
        self.maximumBytes = maximumBytes
    }

    public mutating func enqueue(_ data: Data) -> Bool {
        guard
            !data.isEmpty,
            data.count <= maxJSONBytes,
            queuedBytes + inFlightBytes + data.count <= maximumBytes
        else {
            return false
        }
        items.append(data)
        queuedBytes += data.count
        return true
    }

    public mutating func beginNext() -> Data? {
        guard inFlightBytes == 0, !items.isEmpty else { return nil }
        let data = items.removeFirst()
        queuedBytes -= data.count
        inFlightBytes = data.count
        return data
    }

    public mutating func completeInFlight() {
        inFlightBytes = 0
    }

    public mutating func removeAll() {
        items.removeAll(keepingCapacity: false)
        queuedBytes = 0
        inFlightBytes = 0
    }
}

public struct GenerationGate: Sendable {
    public private(set) var generation: Int

    public init(generation: Int) {
        self.generation = generation
    }

    public mutating func replace(with next: Int) {
        generation = next
    }

    public func accepts(_ candidate: Int) -> Bool {
        candidate == generation
    }
}

public struct DeliverySequenceGate: Sendable {
    private var lastDeliveryId: Int64 = 0

    public init() {}

    public mutating func reset() {
        lastDeliveryId = 0
    }

    public mutating func accept(_ deliveryId: Int64) -> Bool {
        guard deliveryId > 0, lastDeliveryId < Int64.max, deliveryId == lastDeliveryId + 1 else {
            return false
        }
        lastDeliveryId = deliveryId
        return true
    }
}

public struct ConnectionCallbackGate: Sendable {
    private var connectionToken: UUID
    private var taskToken: UUID?

    public init(connectionToken: UUID = UUID(), taskToken: UUID? = nil) {
        self.connectionToken = connectionToken
        self.taskToken = taskToken
    }

    public mutating func replace(connectionToken: UUID, taskToken: UUID?) {
        self.connectionToken = connectionToken
        self.taskToken = taskToken
    }

    public func accepts(connectionToken: UUID, taskToken: UUID?) -> Bool {
        self.connectionToken == connectionToken && self.taskToken == taskToken
    }
}

/// Tracks the single native ping that is allowed to wait for a pong on a connection.
/// Dispatch deadlines remain responsible for elapsed time; this gate only rejects stale
/// connection, pong, and timeout callbacks.
public struct NativePingWatchdogGate: Sendable {
    private var connectionToken: UUID?
    private var pendingPingToken: UUID?

    public init() {}

    public mutating func reset(connectionToken: UUID) {
        self.connectionToken = connectionToken
        pendingPingToken = nil
    }

    public mutating func cancel() {
        connectionToken = nil
        pendingPingToken = nil
    }

    public mutating func beginPing(connectionToken candidate: UUID) -> UUID? {
        guard connectionToken == candidate, pendingPingToken == nil else { return nil }
        let token = UUID()
        pendingPingToken = token
        return token
    }

    public mutating func receivePong(connectionToken candidate: UUID, pingToken: UUID) -> Bool {
        guard connectionToken == candidate, pendingPingToken == pingToken else { return false }
        pendingPingToken = nil
        return true
    }

    public mutating func expire(connectionToken candidate: UUID, pingToken: UUID) -> Bool {
        guard connectionToken == candidate, pendingPingToken == pingToken else { return false }
        pendingPingToken = nil
        return true
    }

    public func isWaiting(connectionToken candidate: UUID) -> Bool {
        connectionToken == candidate && pendingPingToken != nil
    }
}

public struct SpeakerGenerationGate: Sendable {
    private var generations: [String: Int] = [:]

    public init() {}

    public mutating func update(speakerId: String, generation: Int, connected: Bool) {
        if connected {
            generations[speakerId] = generation
        } else if generations[speakerId] == generation {
            generations.removeValue(forKey: speakerId)
        }
    }

    public func accepts(speakerId: String, generation: Int) -> Bool {
        generations[speakerId] == generation
    }

    public mutating func removeAll() {
        generations.removeAll(keepingCapacity: false)
    }
}

public struct ReadinessGate: Sendable {
    private var transportConnected = false
    private var identityGeneration: Int?
    private var explicitConsent = false
    private var microphoneGranted = false
    private var sentGeneration: Int?

    public init() {}

    public mutating func resetConnection() {
        transportConnected = false
        identityGeneration = nil
        sentGeneration = nil
    }

    public mutating func setTransportConnected(_ connected: Bool) {
        transportConnected = connected
    }

    public mutating func setIdentityGeneration(_ generation: Int) {
        identityGeneration = generation
    }

    public mutating func setExplicitConsent(_ consented: Bool) {
        explicitConsent = consented
    }

    public mutating func setMicrophoneGranted(_ granted: Bool) {
        microphoneGranted = granted
    }

    public mutating func takeReadyGeneration() -> Int? {
        guard
            transportConnected,
            explicitConsent,
            microphoneGranted,
            let identityGeneration,
            sentGeneration != identityGeneration
        else {
            return nil
        }
        sentGeneration = identityGeneration
        return identityGeneration
    }
}

public enum PrivateAudioRoute: Equatable, Sendable {
    case bluetoothHFP
    case headphones
    case none
}

public struct RoutePolicy: Sendable {
    public private(set) var route: PrivateAudioRoute = .none
    public private(set) var capturePaused = true

    public init() {}

    @discardableResult
    public mutating func update(_ next: PrivateAudioRoute) -> Bool {
        route = next
        if next == .none {
            capturePaused = true
            return true
        }
        // A private route reconnect never resumes capture without an explicit user action.
        return false
    }

    public mutating func consentToResume() -> Bool {
        guard route != .none else { return false }
        capturePaused = false
        return true
    }
}
