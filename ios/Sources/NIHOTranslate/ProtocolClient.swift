import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import NIHOTranslateCore

private final class WebSocketDelegate: NSObject, URLSessionWebSocketDelegate {
    var onOpen: ((URLSessionWebSocketTask) -> Void)?
    var onClose: ((URLSessionWebSocketTask) -> Void)?

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        onOpen?(webSocketTask)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        onClose?(webSocketTask)
    }
}

public final class TranslateProtocolClient: @unchecked Sendable {
    public enum State: Sendable {
        case disconnected
        case connecting
        case connected
        case failed
    }

    private let callbackQueue: DispatchQueue
    private let wireQueue = DispatchQueue(label: "NIHOTranslate.websocket")
    private let delegate = WebSocketDelegate()
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var connectionToken = UUID()
    private var taskToken: UUID?
    private var callbackGate = ConnectionCallbackGate()
    private var deliveryGate = DeliverySequenceGate()
    private var opened = false
    private var outgoing = BoundedOutgoingQueue()
    private var pingTimer: DispatchSourceTimer?

    public var onEvent: (@Sendable (ServerEnvelope) -> Void)?
    public var onState: (@Sendable (State) -> Void)?

    public init(callbackQueue: DispatchQueue = .main) {
        self.callbackQueue = callbackQueue
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        delegate.onOpen = { [weak self] task in
            self?.wireQueue.async { self?.opened(task: task) }
        }
        delegate.onClose = { [weak self] task in
            self?.wireQueue.async { self?.closed(task: task) }
        }
        session = URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
    }

    deinit {
        pingTimer?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    public func connect(url: URL, ticket: String) throws {
        guard
            url.scheme == "wss",
            url.host?.isEmpty == false,
            url.user == nil, url.password == nil,
            url.query == nil, url.fragment == nil,
            !ticket.isEmpty,
            ticket.utf8.count <= 8_192,
            ticket.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
        else {
            throw TranslateProtocolError.invalidField
        }
        wireQueue.sync {
            cancelCurrent(state: .disconnected)
            connectionToken = UUID()
            taskToken = UUID()
            callbackGate.replace(connectionToken: connectionToken, taskToken: taskToken)
            deliveryGate.reset()
            opened = false
            outgoing.removeAll()
            var request = URLRequest(url: url)
            request.setValue("Bearer \(ticket)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 15
            let next = session.webSocketTask(with: request)
            next.maximumMessageSize = maxJSONBytes
            task = next
            emitState(.connecting, token: connectionToken, taskToken: taskToken)
            next.resume()
            receive(from: next, token: connectionToken, taskToken: taskToken!)
        }
    }

    public func send(_ event: ClientEnvelope) async throws {
        let data = try JSONEncoder().encode(event)
        guard data.count <= maxJSONBytes else { throw TranslateProtocolError.tooLarge }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            wireQueue.async { [weak self] in
                guard let self, self.opened, self.task != nil, let taskToken = self.taskToken else {
                    continuation.resume(throwing: URLError(.notConnectedToInternet))
                    return
                }
                guard self.outgoing.enqueue(data) else {
                    continuation.resume(throwing: TranslateProtocolError.tooLarge)
                    return
                }
                continuation.resume(returning: ())
                self.drainOutgoing(token: self.connectionToken, taskToken: taskToken)
            }
        }
    }

    public func disconnect() {
        wireQueue.async { [weak self] in
            self?.cancelCurrent(state: .disconnected)
        }
    }

    private func opened(task expected: URLSessionWebSocketTask) {
        guard task === expected else { return }
        guard let taskToken else { return }
        opened = true
        startPing(token: connectionToken)
        emitState(.connected, token: connectionToken, taskToken: taskToken)
        drainOutgoing(token: connectionToken, taskToken: taskToken)
    }

    private func closed(task expected: URLSessionWebSocketTask) {
        guard task === expected else { return }
        cancelCurrent(state: .disconnected)
    }

    private func receive(from expected: URLSessionWebSocketTask, token: UUID, taskToken expectedTaskToken: UUID) {
        expected.receive { [weak self] result in
            guard let self else { return }
            self.wireQueue.async {
                guard
                    self.task === expected,
                    self.connectionToken == token,
                    self.taskToken == expectedTaskToken
                else { return }
                do {
                    let message = try result.get()
                    let data: Data
                    switch message {
                    case .string(let value):
                        data = Data(value.utf8)
                    case .data:
                        throw TranslateProtocolError.invalidField
                    @unknown default:
                        throw TranslateProtocolError.invalidField
                    }
                    let event = try ServerEnvelope.decode(data)
                    if let deliveryId = event.deliveryId {
                        guard self.deliveryGate.accept(deliveryId) else {
                            throw TranslateProtocolError.invalidField
                        }
                        let acknowledgement = try JSONEncoder().encode(ClientEnvelope.acknowledge(deliveryId))
                        guard self.outgoing.enqueue(acknowledgement) else {
                            throw TranslateProtocolError.tooLarge
                        }
                        self.drainOutgoing(token: token, taskToken: expectedTaskToken)
                    }
                    if event.type == "room.state", !self.opened {
                        self.opened = true
                        self.startPing(token: token)
                        self.emitState(.connected, token: token, taskToken: expectedTaskToken)
                    }
                    self.emitEvent(event, token: token, taskToken: expectedTaskToken)
                    self.receive(from: expected, token: token, taskToken: expectedTaskToken)
                } catch {
                    expected.cancel(with: .invalid, reason: nil)
                    self.task = nil
                    self.taskToken = nil
                    self.callbackGate.replace(connectionToken: token, taskToken: nil)
                    self.opened = false
                    self.outgoing.removeAll()
                    self.emitState(.failed, token: token, taskToken: nil)
                }
            }
        }
    }

    private func drainOutgoing(token: UUID, taskToken expectedTaskToken: UUID) {
        guard
            opened,
            let expected = task,
            connectionToken == token,
            taskToken == expectedTaskToken,
            let data = outgoing.beginNext(),
            let string = String(data: data, encoding: .utf8)
        else {
            return
        }
        Task {
            do {
                try await expected.send(.string(string))
                wireQueue.async { [weak self] in
                    guard
                        let self,
                        self.task === expected,
                        self.connectionToken == token,
                        self.taskToken == expectedTaskToken
                    else { return }
                    self.outgoing.completeInFlight()
                    self.drainOutgoing(token: token, taskToken: expectedTaskToken)
                }
            } catch {
                wireQueue.async { [weak self] in
                    guard
                        let self,
                        self.task === expected,
                        self.connectionToken == token,
                        self.taskToken == expectedTaskToken
                    else { return }
                    expected.cancel(with: .invalid, reason: nil)
                    self.task = nil
                    self.taskToken = nil
                    self.callbackGate.replace(connectionToken: token, taskToken: nil)
                    self.opened = false
                    self.outgoing.removeAll()
                    self.emitState(.failed, token: token, taskToken: nil)
                }
            }
        }
    }

    private func cancelCurrent(state: State) {
        connectionToken = UUID()
        taskToken = nil
        callbackGate.replace(connectionToken: connectionToken, taskToken: nil)
        deliveryGate.reset()
        opened = false
        pingTimer?.cancel()
        pingTimer = nil
        outgoing.removeAll()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        emitState(state, token: connectionToken, taskToken: nil)
    }

    private func startPing(token: UUID) {
        pingTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: wireQueue)
        timer.schedule(deadline: .now() + .seconds(5), repeating: .seconds(5))
        timer.setEventHandler { [weak self] in
            guard
                let self,
                self.opened,
                self.connectionToken == token,
                let taskToken = self.taskToken,
                let data = try? JSONEncoder().encode(ClientEnvelope.ping),
                self.outgoing.enqueue(data)
            else {
                return
            }
            self.drainOutgoing(token: token, taskToken: taskToken)
        }
        pingTimer = timer
        timer.resume()
    }

    private func emitEvent(_ event: ServerEnvelope, token: UUID, taskToken: UUID) {
        callbackQueue.async { [weak self] in
            guard let self else { return }
            let accepted = self.wireQueue.sync {
                self.callbackGate.accepts(connectionToken: token, taskToken: taskToken)
            }
            guard accepted else { return }
            self.onEvent?(event)
        }
    }

    private func emitState(_ state: State, token: UUID, taskToken: UUID?) {
        callbackQueue.async { [weak self] in
            guard let self else { return }
            let accepted = self.wireQueue.sync {
                self.callbackGate.accepts(connectionToken: token, taskToken: taskToken)
            }
            guard accepted else { return }
            self.onState?(state)
        }
    }
}
