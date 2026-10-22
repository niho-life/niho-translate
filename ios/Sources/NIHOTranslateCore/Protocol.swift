import Foundation

public enum TranslateLanguage: String, Codable, Sendable {
    case ja
    case en

    public var opposite: Self { self == .ja ? .en : .ja }
}

public enum ParticipantRole: String, Codable, Sendable {
    case host
    case guest
}

public enum TranslateProtocolError: Error, Equatable {
    case invalidVersion
    case invalidField
    case invalidAudio
    case tooLarge
    case staleGeneration
}

public let translateProtocolVersion = 1
public let pcmSampleRate = 24_000
public let pcmFrameBytes = 960
public let pcmBatchBytes = 4_800
public let maxPcmBatchBytes = 9_600
public let maxJSONBytes = 32_768

public struct ParticipantEnvelope: Decodable, Sendable {
    public let participantId: String
    public let sourceLanguage: TranslateLanguage
    public let targetLanguage: TranslateLanguage
    public let role: ParticipantRole
    public let generation: Int
    public let state: String
}

public struct ServerEnvelope: Decodable, Sendable {
    public let v: Int
    public let type: String
    public let deliveryId: Int64?
    public let speakerId: String?
    public let participantId: String?
    public let generation: Int?
    public let language: TranslateLanguage?
    public let audio: String?
    public let delta: String?
    public let captionOnly: Bool?
    public let canCapture: Bool?
    public let reason: String?
    public let code: String?
    public let fatal: Bool?
    public let speechEndedAtMs: Int64?
    public let atMs: Int64?
    public let roomId: String?
    public let roomEpoch: String?
    public let active: Bool?
    public let paused: Bool?
    public let ended: Bool?
    public let participant: ParticipantEnvelope?
    public let connected: Bool?
    public let status: String?
    public let milliseconds: Int64?

    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= maxJSONBytes else { throw TranslateProtocolError.tooLarge }
        guard
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = object["type"] as? String
        else {
            throw TranslateProtocolError.invalidField
        }
        let common: Set<String> = ["v", "type", "deliveryId"]
        let allowed: Set<String>
        switch type {
        case "session.identity":
            allowed = common.union(["participantId", "generation"])
        case "room.state":
            allowed = common.union(["roomId", "roomEpoch", "active", "paused", "ended"])
        case "participant.state":
            allowed = common.union(["participant", "connected"])
        case "caption.delta":
            allowed = common.union(["speakerId", "generation", "language", "captionOnly", "delta", "atMs"])
        case "audio":
            allowed = common.union(["speakerId", "generation", "language", "audio", "speechEndedAtMs"])
        case "route":
            allowed = common.union(["canCapture", "reason"])
        case "latency.status":
            allowed = common.union(["status", "milliseconds"])
        case "error":
            allowed = common.union(["code", "fatal"])
        default:
            throw TranslateProtocolError.invalidField
        }
        guard Set(object.keys).isSubset(of: allowed) else { throw TranslateProtocolError.invalidField }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.v == translateProtocolVersion else { throw TranslateProtocolError.invalidVersion }
        let initialUnauthorized = value.type == "error"
            && value.code == "UNAUTHORIZED"
            && value.fatal == true
            && value.deliveryId == nil
        if !initialUnauthorized {
            guard let deliveryId = value.deliveryId, deliveryId > 0 else {
                throw TranslateProtocolError.invalidField
            }
        }
        try value.validate(object: object)
        return value
    }

    private func validate(object: [String: Any]) throws {
        switch type {
        case "session.identity":
            guard validIdentifier(participantId), let generation, generation > 0 else {
                throw TranslateProtocolError.invalidField
            }
        case "audio":
            guard
                validIdentifier(speakerId),
                let generation,
                generation > 0,
                language != nil,
                let encoded = audio
            else {
                throw TranslateProtocolError.invalidField
            }
            _ = try validateOutputPCM(encoded)
            if let speechEndedAtMs, speechEndedAtMs < 0 { throw TranslateProtocolError.invalidField }
        case "caption.delta":
            guard
                validIdentifier(speakerId),
                let generation,
                generation > 0,
                language != nil,
                captionOnly != nil,
                let delta,
                validCaption(delta),
                let atMs,
                atMs >= 0
            else {
                throw TranslateProtocolError.invalidField
            }
        case "route":
            guard
                canCapture != nil,
                ["active", "host-not-ready", "paused", "ended", "no-listener", "blocked"].contains(reason ?? "")
            else {
                throw TranslateProtocolError.invalidField
            }
        case "room.state":
            guard
                validIdentifier(roomId),
                validIdentifier(roomEpoch),
                active != nil,
                paused != nil,
                ended != nil
            else {
                throw TranslateProtocolError.invalidField
            }
        case "participant.state":
            guard
                let participant,
                validIdentifier(participant.participantId),
                participant.sourceLanguage != participant.targetLanguage,
                participant.generation > 0,
                ["connecting", "ready", "paused", "closed"].contains(participant.state),
                connected != nil,
                let raw = object["participant"] as? [String: Any],
                Set(raw.keys) == Set([
                    "participantId", "sourceLanguage", "targetLanguage",
                    "role", "generation", "state",
                ])
            else {
                throw TranslateProtocolError.invalidField
            }
        case "latency.status":
            guard
                ["unknown", "estimated"].contains(status ?? ""),
                (milliseconds ?? 0) >= 0
            else {
                throw TranslateProtocolError.invalidField
            }
        case "error":
            let codes = [
                "INVALID_MESSAGE", "UNAUTHORIZED", "ROOM_FULL", "ROOM_ENDED",
                "STALE_GENERATION", "NOT_READY", "LEASE_DENIED", "LEASE_EXPIRED",
                "AUDIO_LIMIT", "PROVIDER_ERROR", "BACKPRESSURE", "INTERNAL",
            ]
            guard codes.contains(code ?? ""), fatal != nil else {
                throw TranslateProtocolError.invalidField
            }
        default:
            throw TranslateProtocolError.invalidField
        }
    }
}

@discardableResult
public func validateInputPCM(_ encoded: String) throws -> Data {
    let data = try decodeCanonicalPCM(encoded)
    guard data.count % pcmFrameBytes == 0 else { throw TranslateProtocolError.invalidAudio }
    return data
}

@discardableResult
public func validateOutputPCM(_ encoded: String) throws -> Data {
    let data = try decodeCanonicalPCM(encoded)
    guard data.count % 2 == 0 else { throw TranslateProtocolError.invalidAudio }
    return data
}

@discardableResult
public func validatePCM(_ encoded: String) throws -> Data {
    try validateInputPCM(encoded)
}

private func decodeCanonicalPCM(_ encoded: String) throws -> Data {
    guard
        !encoded.isEmpty,
        encoded.utf8.count <= ((maxPcmBatchBytes + 2) / 3) * 4,
        let data = Data(base64Encoded: encoded),
        !data.isEmpty,
        data.count <= maxPcmBatchBytes,
        data.base64EncodedString() == encoded
    else {
        throw TranslateProtocolError.invalidAudio
    }
    return data
}

public enum ClientEnvelope: Encodable, Sendable {
    case ready
    case ping
    case acknowledge(Int64)
    case capturePause
    case captureResume
    case roomStart
    case roomPause
    case roomResume
    case roomEnd
    case speechStart(Int64)
    case speechEnd(Int64)
    case audio(Data, atMs: Int64)

    enum CodingKeys: String, CodingKey {
        case v
        case type
        case atMs
        case audio
        case deliveryId
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(translateProtocolVersion, forKey: .v)
        switch self {
        case .ready:
            try container.encode("client.ready", forKey: .type)
        case .ping:
            try container.encode("client.ping", forKey: .type)
        case .acknowledge(let deliveryId):
            guard deliveryId > 0 else { throw TranslateProtocolError.invalidField }
            try container.encode("client.ack", forKey: .type)
            try container.encode(deliveryId, forKey: .deliveryId)
        case .capturePause:
            try container.encode("capture.pause", forKey: .type)
        case .captureResume:
            try container.encode("capture.resume", forKey: .type)
        case .roomStart:
            try container.encode("room.start", forKey: .type)
        case .roomPause:
            try container.encode("room.pause", forKey: .type)
        case .roomResume:
            try container.encode("room.resume", forKey: .type)
        case .roomEnd:
            try container.encode("room.end", forKey: .type)
        case .speechStart(let atMs):
            try container.encode("speech.start", forKey: .type)
            try container.encode(atMs, forKey: .atMs)
        case .speechEnd(let atMs):
            try container.encode("speech.end", forKey: .type)
            try container.encode(atMs, forKey: .atMs)
        case .audio(let data, let atMs):
            guard
                !data.isEmpty,
                data.count <= maxPcmBatchBytes,
                data.count % pcmFrameBytes == 0
            else {
                throw TranslateProtocolError.invalidAudio
            }
            try container.encode("audio.append", forKey: .type)
            try container.encode(data.base64EncodedString(), forKey: .audio)
            try container.encode(atMs, forKey: .atMs)
        }
    }
}

private func validIdentifier(_ value: String?) -> Bool {
    guard let value, !value.isEmpty, value.count <= 128 else { return false }
    return value.unicodeScalars.allSatisfy { $0.value > 31 }
}

private func validCaption(_ value: String) -> Bool {
    guard !value.isEmpty, value.count <= 4_096 else { return false }
    return value.unicodeScalars.allSatisfy {
        $0.value == 9 || $0.value == 10 || $0.value == 13 || $0.value > 31
    }
}
