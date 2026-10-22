import XCTest
@testable import NIHOTranslate
import NIHOTranslateCore

@MainActor
final class SessionTests: XCTestCase {
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
}
