import SwiftUI
import NIHOTranslate
import NIHOTranslateCore

/// The host app obtains the scoped ticket and fixed admitted languages from its private API.
/// Login and invitation APIs intentionally stay outside the public SDK.
struct HostTranslateScreen: View {
    let relayURL: URL
    let scopedTicket: String
    let roomId: String
    let participantId: String
    let role: ParticipantRole
    let sourceLanguage: TranslateLanguage
    let targetLanguage: TranslateLanguage

    var body: some View {
        Group {
            if let config = try? TranslateConnectionConfig(
                relayURL: relayURL,
                scopedTicket: scopedTicket,
                roomId: roomId,
                participantId: participantId,
                role: role,
                sourceLanguage: sourceLanguage,
                targetLanguage: targetLanguage
            ) {
                TranslateView(config: config)
            } else {
                Text("通訳設定が無効です / Invalid translation configuration")
            }
        }
    }
}
