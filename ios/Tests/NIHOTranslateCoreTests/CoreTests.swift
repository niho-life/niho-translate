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
        var scheduler = PlaybackScheduler(softLimitBytes: 20, hardLimitBytes: 20, maximumScheduledBytes: 8)
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

    func testPlaybackSchedulerDropsQueuedSilenceThenOldestVoicedAndKeepsPlaying() {
        var scheduler = PlaybackScheduler(softLimitBytes: 12, hardLimitBytes: 20, maximumScheduledBytes: 4)
        let playing = scheduler.enqueue(voiced(1), generation: 0)
        XCTAssertEqual(playing.count, 1)
        XCTAssertTrue(scheduler.enqueueResult(voiced(2), generation: 0).events.isEmpty)
        XCTAssertTrue(scheduler.enqueueResult(silence(), generation: 0).events.isEmpty)
        XCTAssertEqual(
            scheduler.enqueueResult(voiced(3), generation: 0).events,
            [.backpressure(depthBytes: 16)]
        )
        XCTAssertTrue(scheduler.enqueueResult(silence(), generation: 0).events.isEmpty)
        XCTAssertEqual(scheduler.byteCount, 20)

        let silentDrop = PlaybackPressureEvent.overflow(PlaybackDrop(silentChunks: 1, silentBytes: 4))
        XCTAssertEqual(scheduler.enqueueResult(voiced(4), generation: 0).events, [silentDrop])
        XCTAssertEqual(scheduler.enqueueResult(voiced(5), generation: 0).events, [silentDrop])
        let voicedDrop = scheduler.enqueueResult(voiced(6), generation: 0).events
        XCTAssertEqual(voicedDrop, [.overflow(PlaybackDrop(voicedChunks: 1, voicedBytes: 4))])
        XCTAssertEqual(voicedDrop.map(\.code), ["PLAYBACK_BACKPRESSURE_DROP"])
        XCTAssertEqual(scheduler.byteCount, 20)
        XCTAssertEqual(scheduler.scheduledCount, 1)

        XCTAssertEqual(drain(&scheduler, from: playing), [voiced(1), voiced(3), voiced(4), voiced(5), voiced(6)])
        let statistics = scheduler.statistics
        XCTAssertEqual(statistics.enqueuedChunks, 8)
        XCTAssertEqual(statistics.maxDepthBytes, 20)
        XCTAssertEqual(statistics.backpressureCount, 1)
        XCTAssertEqual(statistics.backpressurePlayedBytes, 8)
        XCTAssertEqual(statistics.overflowCount, 3)
        XCTAssertEqual(statistics.droppedSilentChunks, 2)
        XCTAssertEqual(statistics.droppedSilentBytes, 8)
        XCTAssertEqual(statistics.droppedVoicedChunks, 1)
        XCTAssertEqual(statistics.droppedBytes, 12)
        XCTAssertEqual(statistics.underflowCount, 1)
        XCTAssertEqual(statistics.depthBytes, 0)
    }

    func testPlaybackSchedulerDropsIncomingSilenceBeforeVoicedAudioAndKeepsMixedChunks() {
        var scheduler = PlaybackScheduler(softLimitBytes: 12, hardLimitBytes: 12, maximumScheduledBytes: 4)
        var quiet = silence()
        quiet[2] = 1
        let playing = scheduler.enqueue(voiced(1), generation: 0)
        _ = scheduler.enqueue(quiet, generation: 0)
        _ = scheduler.enqueue(silence(), generation: 0)

        XCTAssertEqual(
            scheduler.enqueueResult(voiced(2), generation: 0).events,
            [.overflow(PlaybackDrop(silentChunks: 1, silentBytes: 4))]
        )
        let incomingSilence = scheduler.enqueueResult(silence(), generation: 0)
        XCTAssertEqual(incomingSilence.events, [.overflow(PlaybackDrop(silentChunks: 1, silentBytes: 4))])
        XCTAssertTrue(incomingSilence.reservations.isEmpty)
        XCTAssertEqual(scheduler.byteCount, 12)

        XCTAssertEqual(drain(&scheduler, from: playing), [voiced(1), quiet, voiced(2)])
        XCTAssertEqual(scheduler.statistics.droppedSilentChunks, 2)
        XCTAssertEqual(scheduler.statistics.droppedVoicedChunks, 0)
    }

    func testPlaybackSchedulerReportsBackpressureOncePerIntervalWithoutRejecting() {
        var scheduler = PlaybackScheduler(softLimitBytes: 8, hardLimitBytes: 16, maximumScheduledBytes: 4)
        let first = scheduler.enqueue(voiced(1), generation: 0)
        XCTAssertTrue(scheduler.enqueueResult(voiced(2), generation: 0).events.isEmpty)
        let crossed = scheduler.enqueueResult(voiced(3), generation: 0)
        XCTAssertEqual(crossed.events, [.backpressure(depthBytes: 12)])
        XCTAssertEqual(crossed.events.map(\.code), ["PLAYBACK_BACKPRESSURE_SOFT"])
        XCTAssertTrue(scheduler.enqueueResult(voiced(4), generation: 0).events.isEmpty)
        XCTAssertEqual(scheduler.byteCount, 16)

        // Falling to the soft limit does not end the interval; half of it does.
        let second = scheduler.consumed(token: first[0].token, generation: 0)
        let third = scheduler.consumed(token: second[0].token, generation: 0)
        XCTAssertEqual(scheduler.byteCount, 8)
        XCTAssertTrue(scheduler.enqueueResult(voiced(5), generation: 0).events.isEmpty)
        let fourth = scheduler.consumed(token: third[0].token, generation: 0)
        _ = scheduler.consumed(token: fourth[0].token, generation: 0)
        XCTAssertEqual(scheduler.byteCount, 4)
        XCTAssertTrue(scheduler.enqueueResult(voiced(6), generation: 0).events.isEmpty)
        XCTAssertEqual(
            scheduler.enqueueResult(voiced(7), generation: 0).events,
            [.backpressure(depthBytes: 12)]
        )

        let statistics = scheduler.statistics
        XCTAssertEqual(statistics.backpressureCount, 2)
        XCTAssertEqual(statistics.backpressurePlayedBytes, 12)
        XCTAssertEqual(statistics.maxDepthBytes, 16)
        XCTAssertEqual(statistics.overflowCount, 0)
        XCTAssertEqual(statistics.droppedBytes, 0)
        XCTAssertEqual(statistics.enqueuedBytes, 28)
    }

    func testPlaybackSchedulerCountsDepthAndUnderflowAcrossReset() {
        var scheduler = PlaybackScheduler()
        let first = scheduler.enqueue(voiced(1, count: 4_800), generation: 0)
        let second = scheduler.enqueue(voiced(2, count: 9_600), generation: 0)
        XCTAssertEqual(scheduler.statistics.depthBytes, 14_400)
        XCTAssertEqual(scheduler.statistics.depthMs, 300)

        XCTAssertTrue(scheduler.consumed(token: first[0].token, generation: 0).isEmpty)
        XCTAssertEqual(scheduler.statistics.depthMs, 200)
        XCTAssertEqual(scheduler.statistics.underflowCount, 0)
        _ = scheduler.consumed(token: second[0].token, generation: 0)
        XCTAssertEqual(scheduler.statistics.underflowCount, 1)

        // Discarding pending audio on reset is not an underflow, and counters survive it.
        let discarded = scheduler.enqueue(voiced(3, count: 4_800), generation: 0)
        scheduler.reset(generation: 1, paused: false)
        XCTAssertTrue(scheduler.consumed(token: discarded[0].token, generation: 0).isEmpty)

        let statistics = scheduler.statistics
        XCTAssertEqual(statistics.underflowCount, 1)
        XCTAssertEqual(statistics.depthBytes, 0)
        XCTAssertEqual(statistics.maxDepthMs, 300)
        XCTAssertEqual(statistics.enqueuedChunks, 3)
        XCTAssertEqual(statistics.enqueuedMs, 400)
        XCTAssertEqual(statistics.backpressureCount, 0)
    }

    func testPlaybackQueueLimitsDefaultsValidationAndApplication() throws {
        let defaults = PlaybackQueueLimits.default
        XCTAssertEqual(defaults.softLimitBytes, 96_000)
        XCTAssertEqual(defaults.softLimitMs, 2_000)
        XCTAssertEqual(defaults.hardLimitBytes, 240_000)
        XCTAssertEqual(defaults.hardLimitMs, 5_000)
        XCTAssertEqual(try PlaybackQueueLimits(), defaults)
        let scheduler = PlaybackScheduler()
        XCTAssertEqual(scheduler.softLimitBytes, 96_000)
        XCTAssertEqual(scheduler.hardLimitBytes, 240_000)
        XCTAssertEqual(scheduler.maximumScheduledBytes, 19_200)
        XCTAssertEqual(scheduler.statistics, PlaybackQueueStatistics())

        XCTAssertNoThrow(try PlaybackQueueLimits(softLimitBytes: 19_200, hardLimitBytes: 38_400))
        XCTAssertNoThrow(try PlaybackQueueLimits(softLimitBytes: 96_000, hardLimitBytes: 480_000))
        for (soft, hard) in [(19_199, 240_000), (96_000, 95_999), (19_200, 38_399), (96_000, 480_001)] {
            XCTAssertThrowsError(try PlaybackQueueLimits(softLimitBytes: soft, hardLimitBytes: hard)) {
                XCTAssertEqual($0 as? TranslateProtocolError, .invalidField)
            }
        }

        let tight = try PlaybackQueueLimits(softLimitBytes: 48_000, hardLimitBytes: 96_000)
        var configured = PlaybackScheduler(limits: tight)
        var events: [PlaybackPressureEvent] = []
        for index in 0..<11 {
            events += configured.enqueueResult(voiced(UInt8(index + 1), count: 9_600), generation: 0).events
        }
        XCTAssertEqual(events, [
            .backpressure(depthBytes: 57_600),
            .overflow(PlaybackDrop(voicedChunks: 1, voicedBytes: 9_600)),
        ])
        XCTAssertEqual(configured.statistics.hardLimitBytes, 96_000)

        configured.setLimits(defaults)
        XCTAssertTrue(configured.enqueueResult(voiced(12, count: 9_600), generation: 0).events.isEmpty)
        XCTAssertEqual(configured.byteCount, 105_600)
        XCTAssertEqual(configured.statistics.softLimitBytes, 96_000)
        XCTAssertEqual(configured.statistics.hardLimitBytes, 240_000)
        XCTAssertEqual(configured.statistics.overflowCount, 1)
    }

    func testDefaultLimitsAbsorbMeasuredPhraseBoundaryBurstWithoutDrops() {
        // Synthetic shape of the 2026-10-28 offline run: 3.1 s + 0.2 s silence + 2.0 s of
        // translated speech delivered within 2 s, played back in real time.
        let chunks = (0..<31).map { indexed($0) } + [silence(count: 4_800), silence(count: 4_800)]
            + (31..<51).map { indexed($0) }
        let arrivals = chunks.enumerated().map { (atMs: $0.offset * 2_000 / chunks.count, data: $0.element) }
        var scheduler = PlaybackScheduler()

        let replayed = replay(arrivals, through: &scheduler)

        XCTAssertEqual(replayed.events.map(\.code), ["PLAYBACK_BACKPRESSURE_SOFT"])
        XCTAssertEqual(replayed.played, chunks)
        let statistics = scheduler.statistics
        XCTAssertGreaterThan(statistics.maxDepthMs, 3_000)
        XCTAssertLessThan(statistics.maxDepthMs, 5_000)
        XCTAssertEqual(statistics.overflowCount, 0)
        XCTAssertEqual(statistics.droppedBytes, 0)
        XCTAssertGreaterThan(statistics.backpressureMs, 0)
        XCTAssertEqual(statistics.depthBytes, 0)
    }

    func testDefaultLimitsBoundSustainedOverproductionByDroppingOldestAudio() {
        // 30 s of translated speech delivered within 3 s: the backlog stays at 5 s and the newest
        // audio is kept instead of stopping playback.
        let arrivals = (0..<300).map { (atMs: $0 * 10, data: indexed($0)) }
        var scheduler = PlaybackScheduler()

        let replayed = replay(arrivals, through: &scheduler)

        let order = replayed.played.map { chunkIndex($0) }
        XCTAssertEqual(order, order.sorted())
        XCTAssertEqual(Set(order).count, order.count)
        XCTAssertEqual(order.last, 299)
        let statistics = scheduler.statistics
        XCTAssertEqual(statistics.maxDepthBytes, 240_000)
        XCTAssertEqual(statistics.backpressureCount, 1)
        XCTAssertEqual(statistics.droppedSilentChunks, 0)
        XCTAssertEqual(statistics.droppedVoicedChunks + order.count, 300)
        XCTAssertEqual(statistics.droppedVoicedMs, statistics.droppedVoicedChunks * 100)
        XCTAssertEqual(
            replayed.events.filter { $0.code == PlaybackPressureEvent.overflowCode }.count,
            statistics.overflowCount
        )
        XCTAssertGreaterThan(statistics.overflowCount, 0)
        XCTAssertEqual(statistics.depthBytes, 0)
    }

    func testPlaybackSchedulerDistinguishesPausedAndStaleEnqueue() {
        var scheduler = PlaybackScheduler(softLimitBytes: 16, hardLimitBytes: 16, maximumScheduledBytes: 8, paused: true)
        guard case .paused = scheduler.enqueueResult(Data(repeating: 1, count: 4), generation: 0) else {
            return XCTFail("expected paused")
        }
        guard case .staleGeneration = scheduler.enqueueResult(Data(repeating: 2, count: 4), generation: 1) else {
            return XCTFail("expected stale generation")
        }
        XCTAssertEqual(scheduler.byteCount, 0)
    }

    func testPlaybackSchedulerRejectsChunkLargerThanScheduledLimit() {
        var scheduler = PlaybackScheduler(softLimitBytes: 16, hardLimitBytes: 16, maximumScheduledBytes: 8)

        XCTAssertTrue(scheduler.enqueue(Data(repeating: 1, count: 9), generation: 0).isEmpty)
        XCTAssertEqual(scheduler.scheduledBytes, 0)
        XCTAssertEqual(scheduler.queuedBytes, 0)
        XCTAssertEqual(scheduler.byteCount, 0)
    }

    func testPlaybackSchedulerRejectsStaleCompletionAfterResetAndPause() {
        var scheduler = PlaybackScheduler(softLimitBytes: 16, hardLimitBytes: 16, maximumScheduledBytes: 8)
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

    func testNativePingWatchdogAllowsOneInflightAndAcceptsCurrentPong() {
        let connection = UUID()
        var gate = NativePingWatchdogGate()
        gate.reset(connectionToken: connection)

        let ping = gate.beginPing(connectionToken: connection)
        XCTAssertNotNil(ping)
        XCTAssertNil(gate.beginPing(connectionToken: connection))
        XCTAssertTrue(gate.isWaiting(connectionToken: connection))
        XCTAssertTrue(gate.receivePong(connectionToken: connection, pingToken: ping!))
        XCTAssertFalse(gate.isWaiting(connectionToken: connection))
        XCTAssertFalse(gate.receivePong(connectionToken: connection, pingToken: ping!))
        XCTAssertNotNil(gate.beginPing(connectionToken: connection))
    }

    func testNativePingWatchdogRejectsOldPongAndOldDeadlineAfterReconnect() {
        let oldConnection = UUID()
        let currentConnection = UUID()
        var gate = NativePingWatchdogGate()
        gate.reset(connectionToken: oldConnection)
        let oldPing = gate.beginPing(connectionToken: oldConnection)!

        gate.reset(connectionToken: currentConnection)
        let currentPing = gate.beginPing(connectionToken: currentConnection)!
        XCTAssertFalse(gate.receivePong(connectionToken: oldConnection, pingToken: oldPing))
        XCTAssertFalse(gate.expire(connectionToken: oldConnection, pingToken: oldPing))
        XCTAssertTrue(gate.isWaiting(connectionToken: currentConnection))
        XCTAssertTrue(gate.expire(connectionToken: currentConnection, pingToken: currentPing))
        XCTAssertFalse(gate.isWaiting(connectionToken: currentConnection))

        gate.cancel()
        XCTAssertFalse(gate.receivePong(connectionToken: currentConnection, pingToken: currentPing))
        XCTAssertFalse(gate.expire(connectionToken: currentConnection, pingToken: currentPing))
        XCTAssertNil(gate.beginPing(connectionToken: currentConnection))
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

    private func voiced(_ value: UInt8, count: Int = 4) -> Data {
        Data(repeating: value, count: count)
    }

    private func silence(count: Int = 4) -> Data {
        Data(count: count)
    }

    /// A 100 ms chunk that is never complete silence and carries `index` in its first two bytes.
    private func indexed(_ index: Int) -> Data {
        var data = Data(repeating: 1, count: 4_800)
        data[0] = UInt8(index >> 8)
        data[1] = UInt8(index & 0xFF)
        return data
    }

    private func chunkIndex(_ data: Data) -> Int {
        Int(data[0]) << 8 | Int(data[1])
    }

    /// Plays reservations back to back and returns the chunks in playback order.
    private func drain(
        _ scheduler: inout PlaybackScheduler,
        from reservations: [PlaybackReservation]
    ) -> [Data] {
        var pending = reservations
        var played: [Data] = []
        while !pending.isEmpty {
            let reservation = pending.removeFirst()
            played.append(reservation.data)
            pending += scheduler.consumed(token: reservation.token, generation: reservation.generation)
        }
        return played
    }

    /// Ideal player: chunks arrive at `atMs` and play back to back in real time; each chunk is
    /// reported as consumed when it finishes.
    private func replay(
        _ arrivals: [(atMs: Int, data: Data)],
        through scheduler: inout PlaybackScheduler
    ) -> (events: [PlaybackPressureEvent], played: [Data]) {
        var events: [PlaybackPressureEvent] = []
        var played: [Data] = []
        var playing: [PlaybackReservation] = []
        var remainingMs = 0
        var next = 0
        var now = 0
        while next < arrivals.count || !playing.isEmpty {
            while next < arrivals.count, arrivals[next].atMs <= now {
                let result = scheduler.enqueueResult(arrivals[next].data, generation: 0)
                events += result.events
                playing += result.reservations
                next += 1
            }
            var budget = 10
            while budget > 0, let head = playing.first {
                if remainingMs == 0 {
                    remainingMs = head.data.count / PlaybackQueueLimits.bytesPerMillisecond
                }
                let step = min(budget, remainingMs)
                remainingMs -= step
                budget -= step
                if remainingMs == 0 {
                    playing.removeFirst()
                    played.append(head.data)
                    playing += scheduler.consumed(token: head.token, generation: head.generation)
                }
            }
            now += 10
        }
        return (events, played)
    }
}
