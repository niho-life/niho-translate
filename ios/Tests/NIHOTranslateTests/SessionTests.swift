import XCTest
@testable import NIHOTranslate
import NIHOTranslateCore

private enum SyntheticError: Error {
    case failed
}

private final class FakeTransport: TranslateSessionTransport, @unchecked Sendable {
    var onEvent: (@Sendable (ServerEnvelope) -> Void)?
    var onState: (@Sendable (TranslateProtocolClient.State) -> Void)?
    var connectCount = 0
    var disconnectCount = 0
    var sentTypes: [String] = []
    var connectError: Error?
    var suspendNextSend = false
    var sendContinuation: CheckedContinuation<Void, Error>?

    func connect(url: URL, ticket: String) throws {
        connectCount += 1
        if let connectError { throw connectError }
    }

    func send(_ event: ClientEnvelope) async throws {
        let data = try JSONEncoder().encode(event)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        sentTypes.append(object?["type"] as? String ?? "")
        if suspendNextSend {
            suspendNextSend = false
            try await withCheckedThrowingContinuation { continuation in
                sendContinuation = continuation
            }
        }
    }

    func disconnect() {
        disconnectCount += 1
    }

    func emit(_ state: TranslateProtocolClient.State) {
        onState?(state)
    }

    func emit(_ event: ServerEnvelope) {
        onEvent?(event)
    }

    func failSuspendedSend() {
        let continuation = sendContinuation
        sendContinuation = nil
        continuation?.resume(throwing: SyntheticError.failed)
    }
}

private final class FakeAudio: TranslateSessionAudio, @unchecked Sendable {
    var onAudioBatch: (@Sendable (Data) -> Void)?
    var onSpeechBoundary: (@Sendable (TranslateAudioEngine.SpeechBoundary) -> Void)?
    var onRouteRequiresPause: (@Sendable () -> Void)?
    var onPlaybackOverflow: (@Sendable (Int) -> Void)?
    var prepareCount = 0
    var resumeCount = 0
    var pauseCount = 0
    var stopCount = 0
    var enqueueCount = 0
    var listeningPauseValues: [Bool] = []
    var shouldFailRoute = false
    private var playbackGeneration = 0

    func preparePlayback(generation: Int) throws -> Int {
        prepareCount += 1
        if shouldFailRoute { throw SyntheticError.failed }
        return playbackGeneration
    }

    func resumeCapture(generation: Int) throws -> Int {
        resumeCount += 1
        if shouldFailRoute { throw SyntheticError.failed }
        return playbackGeneration
    }

    func stop(generation: Int) { stopCount += 1 }
    func pauseCapture(generation: Int) { pauseCount += 1 }
    func enqueueTranslatedPCM(_ data: Data, playbackGeneration: Int) { enqueueCount += 1 }

    func invalidatePlayback() -> Int {
        playbackGeneration += 1
        return playbackGeneration
    }

    func setListeningPaused(_ paused: Bool) -> Int {
        listeningPauseValues.append(paused)
        if paused { playbackGeneration += 1 }
        return playbackGeneration
    }

    func loseRoute() {
        onRouteRequiresPause?()
    }

    func overflow(generation: Int? = nil) {
        onPlaybackOverflow?(generation ?? playbackGeneration)
    }
}

@MainActor
private final class FakePermissionProvider: MicrophonePermissionProviding {
    var permission: TranslateSession.MicrophonePermission
    var requestCompletion: (@Sendable (Bool) -> Void)?

    init(_ permission: TranslateSession.MicrophonePermission) {
        self.permission = permission
    }

    func request(_ completion: @escaping @Sendable (Bool) -> Void) {
        requestCompletion = completion
    }
}

@MainActor
final class SessionTests: XCTestCase {
    private func config(role: ParticipantRole = .guest) throws -> TranslateConnectionConfig {
        try TranslateConnectionConfig(
            relayURL: URL(string: "wss://relay.example.invalid/translate")!,
            scopedTicket: "synthetic-ticket",
            roomId: "room",
            participantId: "self",
            role: role,
            sourceLanguage: role == .host ? .ja : .en,
            targetLanguage: role == .host ? .en : .ja
        )
    }

    private func event(_ value: [String: Any]) throws -> ServerEnvelope {
        try ServerEnvelope.decode(JSONSerialization.data(withJSONObject: value))
    }

    private func settle() async {
        for _ in 0..<8 { await Task.yield() }
    }

    func testRelayURLAndHeaderRejectCredentialLeakage() {
        for address in [
            "wss://user:pass@relay.example.invalid/translate",
            "wss://relay.example.invalid/translate?ticket=synthetic",
            "wss://relay.example.invalid/translate#synthetic",
        ] {
            XCTAssertThrowsError(try TranslateConnectionConfig(
                relayURL: URL(string: address)!, scopedTicket: "synthetic-ticket",
                roomId: "room", participantId: "participant", role: .guest,
                sourceLanguage: .en, targetLanguage: .ja
            ))
        }
        XCTAssertThrowsError(try TranslateConnectionConfig(
            relayURL: URL(string: "wss://relay.example.invalid/translate")!,
            scopedTicket: "synthetic\r\nheader", roomId: "room",
            participantId: "participant", role: .guest,
            sourceLanguage: .en, targetLanguage: .ja
        ))
    }

    func testConsentAndPermissionRemainSeparateAndLanguagesStayFixed() throws {
        let config = try TranslateConnectionConfig(
            relayURL: URL(string: "wss://relay.example.invalid/translate")!,
            scopedTicket: "synthetic-ticket",
            roomId: "room",
            participantId: "participant",
            role: .guest,
            sourceLanguage: .en,
            targetLanguage: .ja
        )
        let session = TranslateSession(config: config)
        XCTAssertFalse(session.explicitConsent)
        XCTAssertEqual(session.microphonePermission, .undetermined)
        session.setExplicitConsent(true)
        XCTAssertTrue(session.explicitConsent)
        XCTAssertEqual(session.microphonePermission, .undetermined)
        XCTAssertEqual(session.config.sourceLanguage, .en)
        XCTAssertEqual(session.config.targetLanguage, .ja)
        session.leave()
        XCTAssertFalse(session.explicitConsent)
        XCTAssertEqual(session.connectionStatus, .disconnected)
        XCTAssertFalse(session.canCapture)
    }

    func testConfigurationRejectsMidRoomEquivalentLanguagePair() {
        XCTAssertThrowsError(try TranslateConnectionConfig(
            relayURL: URL(string: "wss://relay.example.invalid/translate")!,
            scopedTicket: "synthetic-ticket",
            roomId: "room",
            participantId: "participant",
            role: .host,
            sourceLanguage: .ja,
            targetLanguage: .ja
        ))
    }

    func testTicketIsAttemptedOnlyOncePerSessionAndFreshSessionCanConnect() async throws {
        let firstTransport = FakeTransport()
        let permission = FakePermissionProvider(.granted)
        let first = TranslateSession(
            config: try config(),
            transport: firstTransport,
            audio: FakeAudio(),
            permissionProvider: permission
        )
        first.setExplicitConsent(true)
        first.requestPermissionAndConnect()
        XCTAssertEqual(firstTransport.connectCount, 1)
        firstTransport.emit(.failed)
        await settle()
        first.requestPermissionAndConnect()
        XCTAssertEqual(firstTransport.connectCount, 1)
        XCTAssertEqual(first.connectionStatus, .failed)

        let freshTransport = FakeTransport()
        let fresh = TranslateSession(
            config: try config(),
            transport: freshTransport,
            audio: FakeAudio(),
            permissionProvider: FakePermissionProvider(.granted)
        )
        fresh.setExplicitConsent(true)
        fresh.requestPermissionAndConnect()
        XCTAssertEqual(freshTransport.connectCount, 1)
    }

    func testPermissionCompletionAfterLeaveCannotReconnectOrReviveState() async throws {
        let transport = FakeTransport()
        let permission = FakePermissionProvider(.undetermined)
        let session = TranslateSession(
            config: try config(),
            transport: transport,
            audio: FakeAudio(),
            permissionProvider: permission
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        session.leave()
        permission.requestCompletion?(true)
        await settle()

        XCTAssertEqual(transport.connectCount, 0)
        XCTAssertEqual(session.microphonePermission, .undetermined)
        XCTAssertEqual(session.connectionStatus, .disconnected)
        XCTAssertFalse(session.explicitConsent)
        session.setExplicitConsent(true)
        XCTAssertFalse(session.explicitConsent)
    }

    func testQueuedEventAndAudioAfterLeaveCannotRestoreCaptionOrPlayback() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(),
            transport: transport,
            audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "participant.state", "deliveryId": 1,
            "participant": [
                "participantId": "other", "sourceLanguage": "ja", "targetLanguage": "en",
                "role": "host", "generation": 1, "state": "ready",
            ],
            "connected": true,
        ]))
        await settle()

        transport.emit(try event([
            "v": 1, "type": "caption.delta", "deliveryId": 2,
            "speakerId": "other", "generation": 1, "language": "en",
            "captionOnly": false, "delta": "synthetic", "atMs": 1,
        ]))
        transport.emit(try event([
            "v": 1, "type": "audio", "deliveryId": 3,
            "speakerId": "other", "generation": 1, "language": "en",
            "audio": Data([0, 0]).base64EncodedString(),
        ]))
        session.leave()
        let sentBeforeLateCapture = transport.sentTypes.count
        audio.onAudioBatch?(Data(repeating: 0, count: pcmBatchBytes))
        transport.emit(.connected)
        await settle()

        XCTAssertTrue(session.captions.isEmpty)
        XCTAssertEqual(audio.enqueueCount, 0)
        XCTAssertEqual(transport.sentTypes.count, sentBeforeLateCapture)
        XCTAssertEqual(session.connectionStatus, .disconnected)
    }

    func testSendFailureCompletingAfterLeaveCannotPublishError() async throws {
        let transport = FakeTransport()
        transport.suspendNextSend = true
        let session = TranslateSession(
            config: try config(role: .host),
            transport: transport,
            audio: FakeAudio(),
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        await settle()
        session.startRoom()
        await settle()
        XCTAssertNotNil(transport.sendContinuation)

        session.leave()
        transport.failSuspendedSend()
        await settle()

        XCTAssertNil(session.errorCode)
        XCTAssertEqual(session.connectionStatus, .disconnected)
    }

    func testRouteLossRequiresExplicitResumeAndCaptureRestarts() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(),
            transport: transport,
            audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "session.identity", "deliveryId": 1,
            "participantId": "self", "generation": 1,
        ]))
        transport.emit(try event([
            "v": 1, "type": "route", "deliveryId": 2,
            "canCapture": true, "reason": "active",
        ]))
        await settle()
        XCTAssertEqual(audio.resumeCount, 1)

        audio.loseRoute()
        await settle()
        XCTAssertEqual(audio.resumeCount, 1)
        XCTAssertTrue(session.micMuted)
        XCTAssertTrue(session.listeningPaused)
        XCTAssertFalse(session.canCapture)
        XCTAssertGreaterThan(audio.stopCount, 0)

        transport.emit(try event([
            "v": 1, "type": "route", "deliveryId": 3,
            "canCapture": false, "reason": "paused",
        ]))
        await settle()
        session.setMicMuted(false)
        XCTAssertEqual(audio.resumeCount, 1)
        XCTAssertFalse(session.canCapture)
        transport.emit(try event([
            "v": 1, "type": "route", "deliveryId": 4,
            "canCapture": true, "reason": "active",
        ]))
        await settle()
        XCTAssertEqual(audio.resumeCount, 2)
        XCTAssertFalse(session.micMuted)
        XCTAssertTrue(session.canCapture)
        XCTAssertNil(session.errorCode)
    }

    func testPrivateRouteRecoveryDoesNotEraseBudgetError() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(),
            transport: transport,
            audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "session.identity", "deliveryId": 1,
            "participantId": "self", "generation": 1,
        ]))
        transport.emit(try event([
            "v": 1, "type": "route", "deliveryId": 2,
            "canCapture": true, "reason": "active",
        ]))
        transport.emit(try event([
            "v": 1, "type": "error", "deliveryId": 3,
            "code": "LEASE_EXPIRED", "fatal": false,
        ]))
        await settle()

        audio.loseRoute()
        await settle()
        session.setMicMuted(false)

        XCTAssertEqual(session.errorCode, "LEASE_EXPIRED")
        XCTAssertEqual(audio.resumeCount, 2)
    }

    func testCurrentPlaybackOverflowStopsOnceAndRequiresFreshSession() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(), transport: transport, audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "session.identity", "deliveryId": 1,
            "participantId": "self", "generation": 1,
        ]))
        await settle()

        audio.overflow()
        audio.overflow()
        await settle()

        XCTAssertEqual(session.connectionStatus, .failed)
        XCTAssertEqual(session.errorCode, "PLAYBACK_BACKPRESSURE")
        XCTAssertFalse(session.explicitConsent)
        XCTAssertTrue(session.micMuted)
        XCTAssertTrue(session.listeningPaused)
        XCTAssertEqual(transport.disconnectCount, 1)
        XCTAssertEqual(audio.stopCount, 1)
        XCTAssertEqual(transport.connectCount, 1)
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        XCTAssertEqual(transport.connectCount, 1)

        let freshTransport = FakeTransport()
        let fresh = TranslateSession(
            config: try config(), transport: freshTransport, audio: FakeAudio(),
            permissionProvider: FakePermissionProvider(.granted)
        )
        fresh.setExplicitConsent(true)
        fresh.requestPermissionAndConnect()
        XCTAssertEqual(freshTransport.connectCount, 1)
    }

    func testStalePlaybackOverflowAndCallbackAfterLeaveAreIgnored() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(), transport: transport, audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        await settle()

        audio.overflow(generation: -1)
        await settle()
        XCTAssertEqual(session.connectionStatus, .connected)
        XCTAssertNil(session.errorCode)

        session.leave()
        let disconnectCount = transport.disconnectCount
        let stopCount = audio.stopCount
        audio.overflow()
        await settle()
        XCTAssertEqual(session.connectionStatus, .disconnected)
        XCTAssertNil(session.errorCode)
        XCTAssertEqual(transport.disconnectCount, disconnectCount)
        XCTAssertEqual(audio.stopCount, stopCount)
    }

    func testPlaybackOverflowDoesNotOverwriteExistingBudgetError() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(), transport: transport, audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "error", "deliveryId": 1,
            "code": "LEASE_EXPIRED", "fatal": false,
        ]))
        await settle()

        audio.overflow()
        await settle()

        XCTAssertEqual(session.connectionStatus, .failed)
        XCTAssertEqual(session.errorCode, "LEASE_EXPIRED")
        XCTAssertEqual(transport.disconnectCount, 1)
    }

    func testLatePlaybackOverflowDoesNotOverwriteFatalRelayError() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(), transport: transport, audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "error", "deliveryId": 1,
            "code": "PROVIDER_ERROR", "fatal": true,
        ]))
        await settle()
        let disconnectCount = transport.disconnectCount

        audio.overflow()
        await settle()

        XCTAssertEqual(session.connectionStatus, .disconnected)
        XCTAssertEqual(session.errorCode, "PROVIDER_ERROR")
        XCTAssertEqual(transport.disconnectCount, disconnectCount)
    }

    func testTransportFailureCannotBeRevivedByLateConnectedOrMediaCallbacks() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(), transport: transport, audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "session.identity", "deliveryId": 1,
            "participantId": "self", "generation": 1,
        ]))
        transport.emit(try event([
            "v": 1, "type": "route", "deliveryId": 2,
            "canCapture": true, "reason": "active",
        ]))
        await settle()
        XCTAssertEqual(audio.resumeCount, 1)
        transport.emit(.failed)
        await settle()
        let sentCount = transport.sentTypes.count
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "route", "deliveryId": 3,
            "canCapture": true, "reason": "active",
        ]))
        audio.onAudioBatch?(Data(repeating: 0, count: 960))
        await settle()
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()

        XCTAssertEqual(session.connectionStatus, .failed)
        XCTAssertEqual(session.errorCode, "CONNECTION_LOST")
        XCTAssertFalse(session.explicitConsent)
        XCTAssertFalse(session.canCapture)
        XCTAssertTrue(session.captions.isEmpty)
        XCTAssertEqual(audio.resumeCount, 1)
        XCTAssertEqual(transport.sentTypes.count, sentCount)
        XCTAssertEqual(transport.connectCount, 1)
        XCTAssertEqual(transport.disconnectCount, 1)
    }

    func testConsentRevocationDisconnectsAndStopsBothDirectionsPermanently() async throws {
        let transport = FakeTransport()
        let audio = FakeAudio()
        let session = TranslateSession(
            config: try config(), transport: transport, audio: audio,
            permissionProvider: FakePermissionProvider(.granted)
        )
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        transport.emit(.connected)
        transport.emit(try event([
            "v": 1, "type": "session.identity", "deliveryId": 1,
            "participantId": "self", "generation": 1,
        ]))
        await settle()
        session.setExplicitConsent(false)
        let stopped = audio.stopCount
        session.setExplicitConsent(true)
        session.requestPermissionAndConnect()
        session.leave()
        transport.emit(.connected)
        await settle()

        XCTAssertGreaterThan(stopped, 0)
        XCTAssertEqual(audio.stopCount, stopped)
        XCTAssertFalse(session.explicitConsent)
        XCTAssertEqual(session.connectionStatus, .disconnected)
        XCTAssertEqual(transport.disconnectCount, 1)
        XCTAssertEqual(transport.connectCount, 1)
    }
}
