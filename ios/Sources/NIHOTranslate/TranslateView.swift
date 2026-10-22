#if os(iOS)
import SwiftUI
import NIHOTranslateCore

public struct TranslateView: View {
    @StateObject private var session: TranslateSession
    @State private var consent = false
    @State private var endConfirmation = false
    @State private var attemptedConnection = false
    @State private var finished = false
    @Environment(\.dismiss) private var dismiss
    private let onExit: (() -> Void)?
    private let accent = Color(red: 0.388, green: 0.631, blue: 0.035)

    public init(config: TranslateConnectionConfig, onExit: (() -> Void)? = nil) {
        _session = StateObject(wrappedValue: TranslateSession(config: config))
        self.onExit = onExit
    }

    /// A host may obtain a fresh scoped ticket after its consent/permission flow.
    public init(session: TranslateSession, onExit: (() -> Void)? = nil) {
        _session = StateObject(wrappedValue: session)
        _consent = State(initialValue: session.explicitConsent)
        _attemptedConnection = State(initialValue:
            session.connectionStatus == .connecting || session.connectionStatus == .connected)
        self.onExit = onExit
    }

    private var english: Bool { session.config.sourceLanguage == .en }
    private func text(_ ja: String, _ en: String) -> String { english ? en : ja }
    private var connected: Bool { session.connectionStatus == .connected }
    private var otherConnected: Bool {
        session.participants.contains { $0.participantId != session.config.participantId }
    }
    private var readyToStart: Bool {
        connected && session.participants.count == 2
            && session.participants.allSatisfy { $0.state != "connecting" && $0.state != "closed" }
    }

    public var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack {
                        Label(statusLabel, systemImage: connected ? "circle.fill" : "circle")
                            .font(.subheadline).foregroundColor(connected ? accent : .secondary)
                        Spacer()
                        Text(text("2人の会話", "Two people")).font(.caption).foregroundColor(.secondary)
                    }
                    HStack(spacing: 14) {
                        person(text("あなた", "You"), language: session.config.sourceLanguage)
                        Spacer()
                        Image(systemName: "arrow.left.arrow.right").foregroundColor(.secondary)
                        Spacer()
                        person(text("相手", "Other person"), language: session.config.targetLanguage)
                    }.padding().background(Color(.secondarySystemGroupedBackground)).cornerRadius(20)

                    if !attemptedConnection {
                        VStack(alignment: .leading, spacing: 16) {
                            Text(text("それぞれの言葉で、同じ会話を。", "One conversation, in your own language."))
                                .font(.title2.bold())
                            Label(text("マイク付きイヤフォンを接続してください。", "Connect earphones with a microphone."), systemImage: "headphones")
                                .font(.subheadline)
                            Text(text("音声をOpenAIに送信して翻訳します。NIHOに録音や会話履歴を保存しません。", "Audio is sent to OpenAI for interpretation. NIHO does not save recordings or conversation history."))
                                .font(.footnote).foregroundColor(.secondary)
                            Toggle(text("同意して通訳を使う", "I agree to use interpretation"), isOn: $consent)
                                .onChange(of: consent) { session.setExplicitConsent($0) }
                            Button(text("イヤフォンを確認して接続", "Check earphones & connect")) {
                                session.requestPermissionAndConnect()
                            }.buttonStyle(.borderedProminent).disabled(!consent)
                            if session.microphonePermission == .denied {
                                Text(text("iPhoneの設定でマイクの使用を許可してから、お試しください。", "Allow microphone access in iPhone Settings, then try again."))
                                    .font(.footnote).foregroundColor(.secondary)
                            }
                        }
                    } else {
                        if session.config.role == .host && !session.roomActive && !session.roomPaused && !session.roomEnded {
                            Button(text("通訳を始める", "Start interpretation")) { session.startRoom() }
                                .buttonStyle(.borderedProminent).disabled(!readyToStart)
                        }
                        if !session.roomActive || !otherConnected {
                            Text(session.roomPaused
                                ? text("通訳を一時停止しています。", "Interpretation is paused.")
                                : text("相手の接続と、作成者の開始を待っています。", "Waiting for the other person and the host to start."))
                                .font(.subheadline).foregroundColor(.secondary)
                        }
                        Label(text("あなたには日本語で聞こえます", "You hear the English translation"), systemImage: "headphones")
                            .font(.subheadline.bold())
                        if session.captions.isEmpty {
                            Text(text("相手が話すと、ここに翻訳が表示されます。", "The translation appears here when the other person speaks."))
                                .foregroundColor(.secondary).padding(.vertical, 28)
                        }
                        ForEach(session.captions) { caption in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(caption.speakerId == session.config.participantId
                                    ? text("あなた", "You") : text("相手", "Other person"))
                                    .font(.caption).foregroundColor(.secondary)
                                Text(caption.text).font(.title3).fixedSize(horizontal: false, vertical: true)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                                .padding().background(Color(.secondarySystemGroupedBackground)).cornerRadius(18)
                        }
                        Toggle(text("自分のマイクを止める", "Mute my microphone"), isOn: Binding(
                            get: { session.micMuted }, set: { session.setMicMuted($0) }
                        )).disabled(!connected)
                        Toggle(text("聞く音声を一時停止", "Pause listening"), isOn: Binding(
                            get: { session.listeningPaused }, set: { session.setListeningPaused($0) }
                        )).disabled(!connected)
                        if session.config.role == .host && (session.roomActive || session.roomPaused) {
                            Button(session.roomPaused ? text("通訳を再開", "Resume interpretation") : text("通訳を一時停止", "Pause interpretation")) {
                                if session.roomPaused { session.resumeRoom() } else { session.pauseRoom() }
                            }.buttonStyle(.bordered)
                        }
                    }
                    if let code = session.errorCode {
                        Text(errorMessage(code)).font(.subheadline).foregroundColor(.red)
                    }
                }.padding(20)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(text("対面通訳", "Interpretation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(text("終了", "Exit")) { endConfirmation = true }
                }
            }
            .confirmationDialog(text("会話から退出しますか？", "Leave this conversation?"), isPresented: $endConfirmation, titleVisibility: .visible) {
                if session.config.role == .host && connected {
                    Button(text("2人の通訳を終了", "End interpretation for both"), role: .destructive) { session.endRoom() }
                }
                Button(text("退出", "Leave"), role: .destructive) { finish() }
                Button(text("キャンセル", "Cancel"), role: .cancel) {}
            }
        }
        .navigationViewStyle(.stack)
        .tint(accent)
        .onChange(of: session.connectionStatus) { value in
            if value == .connecting || value == .connected { attemptedConnection = true }
        }
        .onChange(of: session.roomEnded) { if $0 { finish() } }
        .onDisappear { session.leave() }
    }

    private func person(_ name: String, language: TranslateLanguage) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "person.fill").font(.title2).foregroundColor(accent)
            Text(name).font(.subheadline.bold())
            Text(language == .ja ? "日本語" : "English").font(.caption).foregroundColor(.secondary)
        }
    }

    private var statusLabel: String {
        if session.roomEnded { return text("通訳を終了しました", "Interpretation ended") }
        if session.roomPaused { return text("一時停止中", "Paused") }
        if connected && !otherConnected { return text("相手の接続待ち", "Waiting for the other person") }
        switch session.connectionStatus {
        case .disconnected: return text("接続前", "Not connected")
        case .connecting: return text("接続しています", "Connecting")
        case .connected: return text("接続済み", "Connected")
        case .failed: return text("接続が切れました", "Connection lost")
        }
    }

    private func errorMessage(_ code: String) -> String {
        switch code {
        case "PRIVATE_AUDIO_ROUTE_REQUIRED":
            return text("マイク付きイヤフォンを接続し、マイクと聞く音声を再開してください。", "Connect earphones with a microphone, then resume the microphone and listening.")
        case "LEASE_DENIED", "LEASE_EXPIRED":
            return text("利用できる通訳の枠がないため、送信を停止しました。", "Audio sending stopped because interpretation is unavailable.")
        default:
            return text("通訳を続けられませんでした。一度退出し、ルームに入り直してください。", "Interpretation could not continue. Leave and rejoin the room.")
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        session.leave()
        onExit?()
        dismiss()
    }
}
#endif
