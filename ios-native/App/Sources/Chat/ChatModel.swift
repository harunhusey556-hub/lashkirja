import SwiftUI
import UIKit
import Observation
import LashKirjaCore

@MainActor
@Observable
final class ChatModel {
    /// Unowned: the app model keeps this one (`AppModel.chat`).
    private unowned let app: AppModel
    var conversationId: String?
    var title = "Avustaja"
    private(set) var messages: [ChatMessage] = []
    /// Where the current question stands (see `ChatTurn`); a failed one offers "Yritä uudelleen".
    private(set) var turn: ChatTurn = .idle
    var streaming: Bool { turn.isBusy }
    /// The client id of the last question: a retry repeats it, so the server keeps one user message.
    private var clientId = UUID().uuidString
    /// A reply that came in part before failing: a retry replaces it.
    private var failedReplyId: String?
    var failure: String?
    /// The composer's draft: kept here so closing the sheet does not lose it.
    var input = ""
    /// Bumped by open, startNew and send: a history load that started before them is stale.
    private var loads = LoadGeneration()
    private var task: Task<Void, Never>?
    /// The reply the live stream writes into; a stopped or superseded stream no longer matches.
    private var liveReplyId: String?
    /// `GET /api/ai/status`: nil until known (behave as available, as the web drawer does).
    private(set) var aiAvailable: Bool?
    /// After a 429 ("Liian monta viestiä"), sending stays off until this moment.
    private(set) var cooldownUntil: Date?
    private var cooldownTask: Task<Void, Never>?
    /// Proposal decisions on their way to the server, by assistant message id.
    private(set) var decisions: [String: ChatProposalDecision] = [:]
    /// A decision the server refused, shown in that message's card.
    private(set) var decisionErrors: [String: String] = [:]
    /// Receipts sent in this conversation, by the id of the user message showing them: the
    /// local bubble while it uploads, then the server's message (keeping the thumbnail).
    private(set) var attachments: [String: ChatAttachment] = [:]
    /// The files of receipts not yet stored, kept for "Yritä uudelleen".
    private var pendingReceipts: [String: ChatReceiptUpload] = [:]
    private var uploadTasks: [String: Task<Void, Never>] = [:]
    /// The live bank card's figures (`GET /api/bank-accounts`), loaded when a card first shows.
    private(set) var bank: ChatBankSummary?
    private(set) var bankFailed = false
    private var bankLoading = false
    /// `AppModel.dataVersion` the bank figures were read at: a write since then reloads them.
    private var bankVersion: Int?

    /// One cookie-less session for every streamed reply: a new session per message
    /// leaked the session and paid a TLS handshake each time.
    private static let streamSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }()

    init(app: AppModel) { self.app = app }

    /// Opening the sheet again: the same conversation, refreshed unless it is new or still streaming.
    func reopen() async {
        async let status: Void = loadStatus()
        // A receipt still uploading (or waiting for a retry) lives only here: a reload would drop it.
        if conversationId != nil && !streaming && pendingReceipts.isEmpty { await loadLatest() }
        await status
    }

    /// As in the web drawer, typing stays on when the AI is unavailable (the server still answers
    /// what it can without it); only a rate-limit cooldown turns it off.
    var canType: Bool { cooldownUntil == nil }
    var canSendShortcut: Bool { cooldownUntil == nil && !receiptBusy }
    /// A receipt is being sent or read: its answer is appended last, so no other message goes out meanwhile.
    var receiptBusy: Bool { attachments.values.contains { $0.phase.isBusy } }
    var canAttach: Bool { !streaming && cooldownUntil == nil && !receiptBusy }

    func loadStatus() async {
        do {
            let status: AssistantStatus = try await app.api.get("/api/ai/status")
            aiAvailable = status.available
        } catch {
            // Unknown: behave as available; a failed question still explains itself.
        }
    }

    private func startCooldown(retryAfter: String?) {
        let until = AssistantCooldown.until(retryAfter: retryAfter)
        cooldownUntil = until
        cooldownTask?.cancel()
        cooldownTask = Task { [weak self] in
            let wait = max(0, until.timeIntervalSinceNow)
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            if let current = self.cooldownUntil, current <= Date() {
                self.cooldownUntil = nil
                if self.failure == AssistantCooldown.rateLimitedMessage { self.failure = nil }
            }
        }
    }

    /// A slow answer is dropped when the owner has since sent a message, started a new
    /// conversation or opened another one, and while a reply is streaming.
    func loadLatest() async {
        let generation = loads.current
        do {
            var query: [String: String] = [:]
            if let conversationId { query["conversationId"] = conversationId }
            let history: ChatHistory = try await app.api.get("/api/ai/chat", query: query)
            guard loads.isCurrent(generation), !streaming, pendingReceipts.isEmpty else { return }
            messages = history.messages.uniquedById()
            conversationId = history.conversation?.id
            title = history.conversation?.title ?? "Avustaja"
        } catch is CancellationError {
        } catch {
            guard loads.isCurrent(generation), !streaming else { return }
            failure = error.userMessage
        }
    }

    /// A conversation was renamed in the list: the open one shows its new name.
    func renamed(_ id: String, to newTitle: String) {
        let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard conversationId == id, !trimmed.isEmpty else { return }
        title = trimmed
    }

    func open(_ conversation: Conversation) async {
        stop()
        turn = .idle
        dropPendingReceipts()
        loads.next()
        failure = nil
        conversationId = conversation.id
        title = conversation.title
        messages = []
        await loadLatest()
    }

    func startNew() {
        stop()
        turn = .idle
        dropPendingReceipts()
        loads.next()
        failure = nil
        conversationId = nil
        title = "Uusi keskustelu"
        messages = []
    }

    func send(_ text: String) { send(text, retrying: false) }

    /// Asks the failed question again: its message stays where it is (no second bubble) and
    /// goes out with the same client id.
    func retry() {
        guard let text = turn.retryText else { return }
        send(text, retrying: true)
    }

    private func send(_ text: String, retrying: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !streaming, cooldownUntil == nil, !receiptBusy else { return }
        loads.next()
        failure = nil
        if retrying {
            if let id = failedReplyId { messages.removeAll { $0.id == id } }
        } else {
            clientId = UUID().uuidString
            messages.append(ChatMessage(id: UUID().uuidString, role: "user", content: trimmed))
        }
        failedReplyId = nil
        let replyId = UUID().uuidString
        messages.append(ChatMessage(id: replyId, role: "assistant", content: ""))
        turn = retrying ? turn.retried() : turn.sent()
        liveReplyId = replyId
        task = Task { await stream(trimmed, replyId: replyId) }
    }

    /// The session ended (sign-out or expiry): nothing of this conversation keeps running, and
    /// nothing that was running writes back.
    func shutdown() {
        stop()
        dropPendingReceipts()
        cooldownTask?.cancel()
        cooldownTask = nil
        loads.next()
    }

    func stop() {
        task?.cancel()
        task = nil
        // Stopped before the first word: no empty bubble is left behind.
        if let id = liveReplyId { messages.removeAll { $0.id == id && $0.content.isEmpty } }
        liveReplyId = nil
        turn = turn.stopped()
    }

    private func stream(_ text: String, replyId: String) async {
        defer {
            if liveReplyId == replyId {
                liveReplyId = nil
                turn = turn.finished()
            }
        }
        struct Body: Encodable { let message: String; let stream = true; let clientId: String; let conversationId: String? }
        do {
            var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent("/api/ai/chat"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let token = await app.auth.currentToken()
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            request.httpBody = try JSONEncoder().encode(Body(message: text, clientId: clientId, conversationId: conversationId))
            request.timeoutInterval = 120
            let (bytes, response) = try await Self.streamSession.bytes(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                var data = Data()
                for try await byte in bytes { data.append(byte) }
                if http.statusCode == 429, liveReplyId == replyId {
                    startCooldown(retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
                }
                let failure = APIErrorDecoder.decode(status: http.statusCode, data: data)
                // Not `app.api`, so its sign-out on an ended session is done here.
                if failure.endsSession { await app.unauthorized(sentToken: token) }
                throw failure
            }
            // Pieces are gathered and shown about every 60 ms: one update per token re-rendered
            // the whole reply many times a second.
            var pending = ""
            var lastFlush = ContinuousClock.now
            func flush() {
                if !pending.isEmpty {
                    let piece = pending
                    pending = ""
                    turn = turn.received(piece)
                    update(replyId) { $0.content += piece }
                }
                lastFlush = .now
            }
            defer { if liveReplyId == replyId { flush() } }
            for try await line in bytes.lines {
                guard line.hasPrefix("data:") else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let event = try? ChatEvent.parse(payload) else { continue }
                guard liveReplyId == replyId else { return }
                if case .delta(let piece) = event {
                    pending += piece
                    if ContinuousClock.now - lastFlush > .milliseconds(60) { flush() }
                    continue
                }
                flush()
                switch event {
                case .started(let id):
                    conversationId = id
                case .delta:
                    break
                case .finished(let message):
                    // The stored reply takes the placeholder's place; its id must not be
                    // in the list twice (the lazy stack's rows are keyed by id).
                    messages.removeAll { $0.id == message.id && $0.id != replyId }
                    update(replyId) { $0 = message }
                case .failed(let message):
                    fail(message, text: text, replyId: replyId)
                }
            }
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            guard liveReplyId == replyId else { return }
            fail(error.userMessage, text: text, replyId: replyId)
        }
    }

    /// The answer did not come (or stopped short): the reason stays visible and the question can
    /// be asked again. An empty placeholder goes; a partial answer stays until the retry.
    private func fail(_ message: String, text: String, replyId: String) {
        failure = message
        turn = turn.failed(message, text: text)
        messages.removeAll { $0.id == replyId && $0.content.isEmpty }
        if messages.contains(where: { $0.id == replyId }) { failedReplyId = replyId }
    }

    // MARK: Match proposal

    /// Accepts or rejects a reply's match proposal. The card reads as decided at once; the
    /// server's copy of the message replaces it, or a refusal puts the buttons back with the reason.
    func decide(_ id: String, _ decision: ChatProposalDecision) {
        guard let message = messages.first(where: { $0.id == id }),
              ChatProposalCard.canDecide(message.proposal, saving: decisions[id]) else { return }
        let previous = message.proposal?.status
        decisionErrors[id] = nil
        decisions[id] = decision
        update(id) { $0 = ChatProposalCard.decided($0, decision) }
        Task {
            defer { decisions[id] = nil }
            do {
                let updated: ChatMessage = try await app.api.send("PATCH", "/api/ai/chat", body: ChatDecisionRequest(id: id, decision: decision))
                if updated.id == id { update(id) { $0 = updated } }
                // Accepting links the receipt to the bank row (and may approve the receipt); the
                // write filter skips /api/ai/, so the lists are told here.
                if decision == .accepted { app.dataVersion += 1 }
                Haptics.success()
            } catch {
                update(id) { $0 = ChatProposalCard.reverted($0, to: previous) }
                if !(error is CancellationError) {
                    decisionErrors[id] = error.userMessage
                    Haptics.error()
                }
            }
        }
    }

    // MARK: Bank card

    func loadBank() async {
        let version = app.dataVersion
        guard !bankLoading, bankVersion != version else { return }
        bankLoading = true
        defer { bankLoading = false }
        do {
            let position: BankHubPosition = try await app.api.get("/api/bank-accounts")
            bank = ChatBankSummary(position)
            bankFailed = false
            bankVersion = version
        } catch is CancellationError {
        } catch {
            bankFailed = true
            bankVersion = version
        }
    }

    // MARK: Receipt in chat

    /// Shows the receipt as the owner's message at once and sends it; the server's reading of it
    /// comes back as the assistant's reply (with a match proposal when a bank row fits).
    func sendReceipt(_ file: ChatReceiptUpload) {
        guard canAttach else {
            // A reply started while the file was being prepared: say so rather than drop it quietly.
            failure = "Odota, että vastaus valmistuu, ja lähetä kuitti sitten uudelleen."
            return
        }
        loads.next()
        failure = nil
        let localId = "receipt-\(file.clientId)"
        messages.append(ChatMessage(id: localId, role: "user", content: ChatReceiptFile.content(file.name)))
        attachments[localId] = ChatAttachment(name: file.name, thumbnail: file.thumbnail, isPDF: file.isPDF, phase: .sending(0))
        pendingReceipts[localId] = file
        startUpload(localId)
    }

    /// Sends a failed receipt again with the same client id: the server answers a repeat once.
    func retryReceipt(_ localId: String) {
        guard pendingReceipts[localId] != nil, attachments[localId]?.phase.canRetry == true, !streaming else { return }
        attachments[localId]?.phase = .sending(0)
        startUpload(localId)
    }

    func discardReceipt(_ localId: String) {
        guard pendingReceipts[localId] != nil, attachments[localId]?.phase.isBusy != true else { return }
        pendingReceipts[localId] = nil
        attachments[localId] = nil
        messages.removeAll { $0.id == localId }
    }

    private func dropPendingReceipts() {
        uploadTasks.values.forEach { $0.cancel() }
        uploadTasks = [:]
        pendingReceipts = [:]
        attachments = attachments.filter { $0.value.phase == .sent }
    }

    private func startUpload(_ localId: String) {
        guard let file = pendingReceipts[localId] else { return }
        uploadTasks[localId]?.cancel()
        uploadTasks[localId] = Task { await upload(file, localId: localId) }
    }

    private func uploadProgress(_ localId: String, _ fraction: Double) {
        guard let phase = attachments[localId]?.phase, phase.isBusy, phase != .reading else { return }
        attachments[localId]?.phase = .progress(fraction)
    }

    private func upload(_ file: ChatReceiptUpload, localId: String) async {
        var form = Multipart()
        form.addFile("file", filename: file.name, mimeType: file.mimeType, data: file.data)
        if let conversationId { form.addField("conversationId", conversationId) }
        form.addField("clientId", file.clientId)
        do {
            // Its own request, not `app.api`: reading the receipt can take longer than the
            // API client's 25 s timeout, and the bytes sent drive the bubble's progress.
            var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent("/api/ai/chat/receipt"))
            request.httpMethod = "POST"
            request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let token = await app.auth.currentToken()
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            request.timeoutInterval = 120
            let progress = UploadProgress { [weak self] fraction in
                Task { @MainActor in self?.uploadProgress(localId, fraction) }
            }
            let (data, response) = try await Self.streamSession.upload(for: request, from: form.finalize(), delegate: progress)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let failure = ChatReceiptFile.failure(status: http.statusCode, data: data)
                if failure.endsSession { await app.unauthorized(sentToken: token) }
                throw failure
            }
            guard let result = try? JSONDecoder().decode(ChatReceiptResponse.self, from: data) else {
                throw LKError(status: 200, code: "DECODE", message: "Palvelimen vastausta ei voitu lukea.")
            }
            uploadTasks[localId] = nil
            // Another conversation was opened meanwhile: the receipt is stored, its bubble is gone.
            guard let index = messages.firstIndex(where: { $0.id == localId }) else { return }
            if conversationId == nil { title = result.userMessage.content }
            conversationId = result.conversationId
            messages[index] = result.userMessage
            messages.removeAll { $0.id == result.assistantMessage.id }
            messages.append(result.assistantMessage)
            messages = messages.uniquedById()
            attachments[localId] = nil
            attachments[result.userMessage.id] = ChatAttachment(name: file.name, thumbnail: file.thumbnail, isPDF: file.isPDF, phase: .sent)
            pendingReceipts[localId] = nil
            // The receipt is now in Kuitit; the write filter skips /api/ai/.
            app.dataVersion += 1
            Haptics.success()
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            uploadTasks[localId] = nil
            guard attachments[localId] != nil else { return }
            attachments[localId]?.phase = .failed(error.userMessage)
            Haptics.error()
        }
    }

    private func update(_ id: String, _ change: (inout ChatMessage) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
    }
}

/// A receipt picked in the chat, ready to send.
struct ChatReceiptUpload: @unchecked Sendable {
    let name: String
    let mimeType: String
    let data: Data
    let thumbnail: UIImage?
    /// The user message's client id; a retry repeats it so the server stores the receipt once.
    let clientId: String
    var isPDF: Bool { mimeType == "application/pdf" }
}

/// What the owner's receipt bubble shows besides its text.
struct ChatAttachment: Equatable {
    let name: String
    let thumbnail: UIImage?
    let isPDF: Bool
    var phase: ChatReceiptPhase

    static func == (a: ChatAttachment, b: ChatAttachment) -> Bool {
        a.name == b.name && a.isPDF == b.isPDF && a.phase == b.phase && a.thumbnail === b.thumbnail
    }
}

/// Reports the bytes of one upload sent so far.
private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let report: @Sendable (Double) -> Void

    init(report: @escaping @Sendable (Double) -> Void) { self.report = report }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
