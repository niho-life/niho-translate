import XCTest
@testable import NIHOTranslateCore

final class CoreTests: XCTestCase {
    func testProtocolValidationSeparatesInputAndOutputAlignment() throws {
        let shortOutput = Data(repeating: 0, count: 2)
        let data = try JSONSerialization.data(withJSONObject: [
            "v": 1,
            "type": "audio",
            "deliveryId": 1,
            "speakerId": "p",
            "generation": 2,
            "language": "en",
            "audio": shortOutput.base64EncodedString(),
        ])
        XCTAssertEqual(try ServerEnvelope.decode(data).generation, 2)
        XCTAssertEqual(try validateOutputPCM(shortOutput.base64EncodedString()), shortOutput)
        XCTAssertThrowsError(try validateInputPCM(shortOutput.base64EncodedString()))
    }

    func testIdentityAndControlEncoding() throws {
        let identity = try JSONSerialization.data(withJSONObject: [
            "v": 1,
            "type": "session.identity",
            "deliveryId": 1,
            "participantId": "self",
            "generation": 3,
        ])
        XCTAssertEqual(try ServerEnvelope.decode(identity).participantId, "self")
        let start = try JSONEncoder().encode(ClientEnvelope.roomStart)
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: start) as? NSDictionary,
            ["v": 1, "type": "room.start"]
        )
        let ping = try JSONEncoder().encode(ClientEnvelope.ping)
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: ping) as? NSDictionary,
            ["v": 1, "type": "client.ping"]
        )
        let acknowledgement = try JSONEncoder().encode(ClientEnvelope.acknowledge(7))
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: acknowledgement) as? NSDictionary,
            ["v": 1, "type": "client.ack", "deliveryId": 7]
        )
    }

    func testCaptionOnlyIsRequired() throws {
        let value: [String: Any] = [
            "v": 1,
            "type": "caption.delta",
            "deliveryId": 1,
            "speakerId": "speaker",
            "generation": 1,
            "language": "en",
            "captionOnly": false,
            "delta": "hello",
            "atMs": 1,
        ]
        XCTAssertFalse(try ServerEnvelope.decode(JSONSerialization.data(withJSONObject: value)).captionOnly ?? true)
        var missing = value
        missing.removeValue(forKey: "captionOnly")
        XCTAssertThrowsError(try ServerEnvelope.decode(JSONSerialization.data(withJSONObject: missing)))
    }

    func testReadinessGateAcceptsIdentityAndTransportInEitherOrderExactlyOnce() {
        var identityFirst = ReadinessGate()
        identityFirst.setExplicitConsent(true)
        identityFirst.setMicrophoneGranted(true)
        identityFirst.setIdentityGeneration(3)
        XCTAssertNil(identityFirst.takeReadyGeneration())
        identityFirst.setTransportConnected(true)
        XCTAssertEqual(identityFirst.takeReadyGeneration(), 3)
        XCTAssertNil(identityFirst.takeReadyGeneration())

        var transportFirst = ReadinessGate()
        transportFirst.setTransportConnected(true)
        transportFirst.setExplicitConsent(true)
        transportFirst.setMicrophoneGranted(true)
        XCTAssertNil(transportFirst.takeReadyGeneration())
        transportFirst.setIdentityGeneration(4)
        XCTAssertEqual(transportFirst.takeReadyGeneration(), 4)
        XCTAssertNil(transportFirst.takeReadyGeneration())
    }

    func testBoundedPCMQueueDropsOldest() {
        var queue = BoundedPCMQueue(maximumBytes: 6)
        XCTAssertTrue(queue.append(Data([1, 2, 3, 4])))
        XCTAssertTrue(queue.append(Data([5, 6, 7, 8])))
        XCTAssertEqual(queue.count, 1)
        XCTAssertEqual(queue.popFirst(), Data([5, 6, 7, 8]))
    }

    func testOutgoingQueueCountsInflightBytes() {
        var queue = BoundedOutgoingQueue(maximumBytes: 8)
        XCTAssertTrue(queue.enqueue(Data([1, 2, 3, 4])))
        XCTAssertEqual(queue.beginNext(), Data([1, 2, 3, 4]))
        XCTAssertFalse(queue.enqueue(Data([5, 6, 7, 8, 9])))
        queue.completeInFlight()
        XCTAssertTrue(queue.enqueue(Data([5, 6, 7, 8, 9])))
    }

    func testPlaybackSchedulerPrerollsBeforeAnyCompletion() {
        var scheduler = PlaybackScheduler(maximumBytes: 20, maximumScheduledBytes: 8)
        let first = scheduler.enqueue(Data(repeating: 1, count: 4), generation: 0)
        let second = scheduler.enqueue(Data(repeating: 2, count: 4), generation: 0)
        let queued = scheduler.enqueue(Data(repeating: 3, count: 4), generation: 0)

        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(second.count, 1)
        XCTAssertTrue(queued.isEmpty)
        XCTAssertEqual(scheduler.scheduledCount, 2)
        XCTAssertEqual(scheduler.queuedCount, 1)

        let replenished = scheduler.consumed(token: first[0].token, generation: 0)
        XCTAssertEqual(replenished.map(\.data), [Data(repeating: 3, count: 4)])
        XCTAssertEqual(scheduler.scheduledCount, 2)
    }

    func testPlaybackSchedulerBoundsMemoryAndDropsOnlyQueuedAudio() {
        var scheduler = PlaybackScheduler(maximumBytes: 12, maximumScheduledBytes: 4)
        let scheduled = scheduler.enqueue(Data(repeating: 1, count: 4), generation: 0)
        XCTAssertEqual(scheduled.count, 1)
        XCTAssertTrue(scheduler.enqueue(Data(repeating: 2, count: 4), generation: 0).isEmpty)
        XCTAssertTrue(scheduler.enqueue(Data(repeating: 3, count: 4), generation: 0).isEmpty)
        XCTAssertTrue(scheduler.enqueue(Data(repeating: 4, count: 4), generation: 0).isEmpty)
        XCTAssertEqual(scheduler.byteCount, 12)
        XCTAssertEqual(scheduler.queuedCount, 2)

        let next = scheduler.consumed(token: scheduled[0].token, generation: 0)
        XCTAssertEqual(next.map(\.data), [Data(repeating: 3, count: 4)])
        XCTAssertLessThanOrEqual(scheduler.byteCount, scheduler.maximumBytes)
    }

    func testPlaybackSchedulerRejectsChunkLargerThanScheduledLimit() {
        var scheduler = PlaybackScheduler(maximumBytes: 16, maximumScheduledBytes: 8)

        XCTAssertTrue(scheduler.enqueue(Data(repeating: 1, count: 9), generation: 0).isEmpty)
        XCTAssertEqual(scheduler.scheduledBytes, 0)
        XCTAssertEqual(scheduler.queuedBytes, 0)
        XCTAssertEqual(scheduler.byteCount, 0)
    }

    func testPlaybackSchedulerRejectsStaleCompletionAfterResetAndPause() {
        var scheduler = PlaybackScheduler(maximumBytes: 16, maximumScheduledBytes: 8)
        let old = scheduler.enqueue(Data(repeating: 1, count: 4), generation: 0)
        scheduler.reset(generation: 1, paused: false)
        let current = scheduler.enqueue(Data(repeating: 2, count: 4), generation: 1)
        XCTAssertTrue(scheduler.consumed(token: old[0].token, generation: 0).isEmpty)
        XCTAssertEqual(scheduler.scheduledBytes, 4)

        XCTAssertTrue(scheduler.setPaused(true, generation: 1).isEmpty)
        XCTAssertEqual(scheduler.byteCount, 0)
        XCTAssertTrue(scheduler.consumed(token: current[0].token, generation: 1).isEmpty)
        XCTAssertTrue(scheduler.enqueue(Data(repeating: 3, count: 4), generation: 1).isEmpty)
    }

    func testRoutePolicyNeverAutoSpeakerOrResume() {
        var policy = RoutePolicy()
        XCTAssertTrue(policy.update(.none))
        XCTAssertTrue(policy.capturePaused)
        XCTAssertFalse(policy.update(.bluetoothHFP))
        XCTAssertTrue(policy.capturePaused)
        XCTAssertTrue(policy.consentToResume())
        XCTAssertTrue(policy.update(.none))
        XCTAssertFalse(policy.consentToResume())
    }

    func testGenerationGatesRejectOldSelfAndSpeakerEvents() {
        var gate = GenerationGate(generation: 1)
        gate.replace(with: 2)
        XCTAssertFalse(gate.accepts(1))
        XCTAssertTrue(gate.accepts(2))

        var speakers = SpeakerGenerationGate()
        speakers.update(speakerId: "speaker", generation: 3, connected: true)
        XCTAssertTrue(speakers.accepts(speakerId: "speaker", generation: 3))
        speakers.update(speakerId: "speaker", generation: 4, connected: true)
        XCTAssertFalse(speakers.accepts(speakerId: "speaker", generation: 3))
        speakers.update(speakerId: "speaker", generation: 4, connected: false)
        XCTAssertFalse(speakers.accepts(speakerId: "speaker", generation: 4))
    }

    func testDeliverySequenceResetsAndRejectsGapsOrOldValues() {
        var gate = DeliverySequenceGate()
        XCTAssertTrue(gate.accept(1))
        XCTAssertTrue(gate.accept(2))
        XCTAssertFalse(gate.accept(2))
        XCTAssertFalse(gate.accept(4))
        gate.reset()
        XCTAssertTrue(gate.accept(1))
    }

    func testCallbackGateRejectsOldConnectionAndTaskTokens() {
        let oldConnection = UUID()
        let oldTask = UUID()
        let newConnection = UUID()
        let newTask = UUID()
        var gate = ConnectionCallbackGate(connectionToken: oldConnection, taskToken: oldTask)
        XCTAssertTrue(gate.accepts(connectionToken: oldConnection, taskToken: oldTask))
        gate.replace(connectionToken: newConnection, taskToken: newTask)
        XCTAssertFalse(gate.accepts(connectionToken: oldConnection, taskToken: oldTask))
        XCTAssertFalse(gate.accepts(connectionToken: newConnection, taskToken: oldTask))
        XCTAssertTrue(gate.accepts(connectionToken: newConnection, taskToken: newTask))
    }

    func testOnlyInitialUnauthorizedMayOmitDeliveryId() throws {
        let unauthorized = try JSONSerialization.data(withJSONObject: [
            "v": 1,
            "type": "error",
            "code": "UNAUTHORIZED",
            "fatal": true,
        ])
        XCTAssertNil(try ServerEnvelope.decode(unauthorized).deliveryId)
        let route = try JSONSerialization.data(withJSONObject: [
            "v": 1,
            "type": "route",
            "canCapture": false,
            "reason": "blocked",
        ])
        XCTAssertThrowsError(try ServerEnvelope.decode(route))
    }
}
