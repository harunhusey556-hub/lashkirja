import SwiftUI
import LashKirjaCore

/// Sähköposti: what mail sync brought in, in folders as a mail app shows them. Bills wait in
/// Odottaa, approved ones move to Hyväksytyt, and attachments that are not bills are archived
/// on arrival to Arkisto, from where they can be restored.
struct EmailInboxView: View {
    @Environment(AppModel.self) private var app
    @State private var folder: EmailInboxFolder = .pending
    @State private var receipts: Loadable<[Receipt]> = .idle
    @State private var total = 0
    @State private var truncated = false
    @State private var loadingMore = false
    @State private var limit = ShowMore()
    @State private var counts = EmailInboxCounts()
    /// nil until the profile has answered: "no mailbox" is shown only when it is known.
    @State private var mailboxes: [ImapAccount]?
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var checking = false
    @State private var cleaning = false
    @State private var confirmCleanup = false
    /// Rows whose review change is on its way: their buttons wait for it.
    @State private var moving: Set<String> = []
    @State private var failure: String?
    @State private var notice: String?
    @State private var checkedAt: Date?
    @State private var openSettings = false
    @State private var toast: Toast?
    @State private var toastAction: (() async -> Void)?
    @State private var toastTask: Task<Void, Never>?

    /// The last "Tarkista nyt" on this device; the server's own check time (profile imapAccounts)
    /// is shown when it is newer, and stands in for a server that does not send one yet.
    private static let checkedKey = "sahkoposti.checkedAt"

    init() {
        let stored = UserDefaults.standard.double(forKey: Self.checkedKey)
        _checkedAt = State(initialValue: stored > 0 ? Date(timeIntervalSince1970: stored) : nil)
    }

    private struct ReloadKey: Hashable {
        let folder: EmailInboxFolder
        let version: Int
    }

    var body: some View {
        List {
            mailboxSection
            if let failure { Text(failure).foregroundStyle(Theme.danger) }
            if let notice { Text(notice).foregroundStyle(Theme.ink2) }
            if showsFolders {
                Section { chips }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
                if let rows = receipts.value?.filter({ !app.removedIds.contains($0.id) }) {
                    if folder == .pending && EmailInboxText.cleanupCandidates(rows) > 0 {
                        cleanupSection(EmailInboxText.cleanupCandidates(rows))
                    }
                    Section {
                        if rows.isEmpty {
                            Text(folder.emptyText).foregroundStyle(Theme.ink2)
                        }
                        ForEach(rows.prefix(limit.visible(rows.count))) { receipt in row(receipt) }
                        // Ten at a time; the next server page is asked for only by the button, never on scroll.
                        PagedShowMoreButton(limit: $limit, loaded: rows.count, total: total, serverHasMore: truncated, loading: loadingMore) {
                            await loadMore()
                            return (receipts.value ?? []).filter { !app.removedIds.contains($0.id) }.count
                        }
                    }
                } else {
                    LoadState(state: receipts, retry: load) { (_: [Receipt]) in EmptyView() }
                        .listRowBackground(Color.clear)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Sähköposti")
        .navigationDestination(isPresented: $openSettings) { RouteScreen(route: .emailImport) }
        .overlay(alignment: .bottom) {
            if let toast {
                ToastView(toast: toast) { runToastAction() }.padding(.bottom, 8)
            }
        }
        .confirmationDialog("Arkistoidaanko liitteet, joissa ei ole summaa?", isPresented: $confirmCleanup, titleVisibility: .visible) {
            Button("Arkistoi") { Task { await cleanup() } }
        } message: {
            Text("Ne siirtyvät Arkistoon, josta ne voi palauttaa.")
        }
        .refreshable { await load() }
        .task(id: ReloadKey(folder: folder, version: app.dataVersion)) {
            // The kept profile shows the mailboxes at once; the load below refreshes them.
            if mailboxes == nil, let profile = app.profile { mailboxes = profile.imapAccounts ?? [] }
            guard receipts.value == nil || gate.isDue(key: folder.rawValue, version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(key: folder.rawValue, version: version) }
        }
    }

    // MARK: Pieces

    /// Folders show once a mailbox is connected, or when an earlier one left mail behind.
    private var showsFolders: Bool {
        guard let mailboxes else { return true }
        let stored = (counts.pending ?? 0) + (counts.approved ?? 0) + (counts.rejected ?? 0)
        return !mailboxes.isEmpty || stored > 0
    }

    @ViewBuilder private var mailboxSection: some View {
        if let mailboxes {
            if mailboxes.isEmpty {
                Section {
                    ContentUnavailableView {
                        Label("Sähköpostia ei ole yhdistetty", systemImage: "envelope.badge")
                    } description: {
                        Text("Yhdistä sähköpostiosoite, niin siihen tulevat laskut haetaan tänne. Liitteet, jotka eivät ole laskuja, arkistoidaan.")
                    } actions: {
                        Button("Yhdistä sähköposti") { openSettings = true }
                            .buttonStyle(.primary)
                    }
                }
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(mailboxes) { account in
                        HStack(spacing: 12) {
                            Image(systemName: "envelope.fill").foregroundStyle(Theme.success).frame(width: 28)
                            Text(account.email).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Button { Task { await check() } } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Label(checking ? String("Tarkistetaan…") : String("Tarkista nyt"), systemImage: "arrow.clockwise")
                                if let lastCheck = EmailInboxText.lastCheck(mailboxes, device: checkedAt), !checking {
                                    // "juuri nyt" turns into a time while the screen stays open.
                                    TimelineView(.everyMinute) { context in
                                        Text(EmailInboxText.checked(lastCheck, now: context.date)).font(.caption).foregroundStyle(Theme.ink2)
                                    }
                                }
                            }
                            if checking { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(checking)
                    NavigationLink(value: Route.emailImport) {
                        Label("Sähköpostiasetukset", systemImage: "gearshape")
                    }
                    .foregroundStyle(Theme.ink)
                } header: {
                    Text(mailboxes.count == 1 ? "Postilaatikko" : "Postilaatikot")
                } footer: {
                    Text("Uusi posti tarkistetaan myös automaattisesti.")
                }
            }
        }
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(EmailInboxFolder.allCases) { option in
                    let selected = option == folder
                    Button {
                        select(option)
                    } label: {
                        HStack(spacing: 4) {
                            Text(option.title)
                            if let count = counts[option] {
                                Text("\(count)").monospacedDigit().foregroundStyle(selected ? Theme.onInk.opacity(0.8) : Theme.ink2)
                            }
                        }
                        .font(.subheadline.weight(selected ? .semibold : .regular))
                        .foregroundStyle(selected ? Theme.onInk : Theme.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(selected ? Theme.ink : Theme.surface, in: Capsule())
                        .overlay(Capsule().stroke(Theme.line, lineWidth: selected ? 0 : 1))
                    }
                    .buttonStyle(.pressable)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 16)
        }
    }

    private func cleanupSection(_ candidates: Int) -> some View {
        Section {
            Button { confirmCleanup = true } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Siivoa: arkistoi ei-laskut", systemImage: "archivebox")
                        Text(candidates == 1 ? String("1 liite ilman summaa") : String("\(candidates) liitettä ilman summaa"))
                            .font(.caption).foregroundStyle(Theme.ink2)
                    }
                    if cleaning { Spacer(); ProgressView() }
                }
            }
            .foregroundStyle(Theme.ink)
            .disabled(cleaning)
        }
    }

    @ViewBuilder private func row(_ receipt: Receipt) -> some View {
        let status = EmailInboxFolder(rawValue: receipt.reviewStatus ?? "") ?? folder
        let busy = moving.contains(receipt.id)
        NavigationLink(value: Route.receipt(receipt.id)) { ReceiptRow(receipt: receipt) }
            // Swiped as in a mail app: archive from the right, approve from the left.
            .swipeActions(edge: .trailing) {
                switch status {
                case .pending:
                    Button { Task { await move(receipt.id, from: .pending, to: .rejected) } } label: {
                        Label("Arkistoi", systemImage: "archivebox")
                    }
                    .tint(Theme.neutralFill)
                    .disabled(busy)
                case .rejected:
                    Button { Task { await move(receipt.id, from: .rejected, to: .pending) } } label: {
                        Label("Palauta", systemImage: "arrow.uturn.backward")
                    }
                    .tint(Theme.accentFill)
                    .disabled(busy)
                case .approved:
                    EmptyView()
                }
            }
            .swipeActions(edge: .leading) {
                if status == .pending {
                    Button { Task { await approve(receipt.id) } } label: {
                        Label("Hyväksy", systemImage: "checkmark")
                    }
                    .tint(Theme.successFill)
                    .disabled(busy)
                }
            }
            .contextMenu {
                switch status {
                case .pending:
                    Button { Task { await approve(receipt.id) } } label: { Label("Hyväksy", systemImage: "checkmark.circle") }
                    Button { Task { await move(receipt.id, from: .pending, to: .rejected) } } label: { Label("Arkistoi", systemImage: "archivebox") }
                case .rejected:
                    Button { Task { await move(receipt.id, from: .rejected, to: .pending) } } label: { Label("Palauta", systemImage: "arrow.uturn.backward") }
                case .approved:
                    EmptyView()
                }
            }
    }

    private func select(_ next: EmailInboxFolder) {
        guard next != folder else { return }
        Haptics.selection()
        // The rows of the folder left must not stay under the new chip (their swipes would differ).
        receipts = .idle
        total = 0
        truncated = false
        limit.reset()
        folder = next
    }

    // MARK: Loading

    private func load() async {
        if receipts.value == nil { receipts = .loading }
        let api = app.api
        // A slow answer for a folder the owner already left must not replace the newer list.
        let asked = folder
        async let profile: ProfileResponse? = try? api.get("/api/profile")
        async let pending: ReceiptCounts? = try? api.get("/api/receipts/counts", query: EmailInboxFolder.pending.countsQuery())
        async let approved: ReceiptCounts? = try? api.get("/api/receipts/counts", query: EmailInboxFolder.approved.countsQuery())
        async let rejected: ReceiptCounts? = try? api.get("/api/receipts/counts", query: EmailInboxFolder.rejected.countsQuery())
        do {
            let list: ReceiptList = try await api.get("/api/receipts", query: asked.listQuery())
            if asked == folder {
                receipts = .loaded(list.receipts)
                total = list.count ?? list.receipts.count
                truncated = list.truncated ?? false
                failure = nil
            }
        } catch is CancellationError {
            return
        } catch {
            if asked == folder {
                if receipts.value == nil { receipts = .failed(error.userMessage) } else { failure = error.userMessage }
            }
        }
        if let response = await profile {
            mailboxes = response.profile.imapAccounts ?? []
            app.profileChanged(response.profile)
        }
        let (p, a, r) = await (pending, approved, rejected)
        counts = EmailInboxCounts(pending: p?.counts.all ?? counts.pending,
                                  approved: a?.counts.all ?? counts.approved,
                                  rejected: r?.counts.all ?? counts.rejected)
    }

    private func loadMore() async {
        guard truncated, !loadingMore, let loaded = receipts.value else { return }
        loadingMore = true
        defer { loadingMore = false }
        let asked = folder
        do {
            let page: ReceiptList = try await app.api.get("/api/receipts", query: asked.listQuery(offset: loaded.count))
            guard asked == folder else { return }
            receipts = .loaded(ReceiptPaging.append(loaded, page.receipts))
            total = page.count ?? total
            truncated = page.truncated ?? false
        } catch is CancellationError {
        } catch {
            failure = error.userMessage
        }
    }

    // MARK: Actions

    private func check() async {
        guard !checking else { return }
        checking = true
        failure = nil
        notice = nil
        defer { checking = false }
        let archivedBefore = counts.rejected
        do {
            let result: ImapSyncResult = try await app.api.send("POST", "/api/integrations/imap/sync", body: EmptyBody())
            let now = Date()
            checkedAt = now
            UserDefaults.standard.set(now.timeIntervalSince1970, forKey: Self.checkedKey)
            await load()
            // The server counts only the bills; what it archived shows as the archive's growth.
            let archived = archivedBefore.flatMap { before in counts.rejected.map { max(0, $0 - before) } }
            withAnimation { notice = EmailInboxText.syncNotice(bills: result.count, archived: archived) }
            Haptics.success()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func cleanup() async {
        guard !cleaning else { return }
        cleaning = true
        failure = nil
        notice = nil
        defer { cleaning = false }
        do {
            let result: EmailArchiveResult = try await app.api.send("POST", "/api/integrations/imap/archive", body: EmptyBody())
            await load()
            withAnimation { notice = EmailInboxText.cleanupNotice(result.archived) }
            Haptics.success()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    /// Archive (`rejected`) or restore (`pending`). The row leaves at once; it is unhidden only
    /// after it is out of this list, so it can show up in the other folder after a reload.
    private func move(_ id: String, from: EmailInboxFolder, to target: EmailInboxFolder, undoable: Bool = true) async {
        guard !moving.contains(id) else { return }
        moving.insert(id)
        defer { moving.remove(id) }
        failure = nil
        withAnimation { app.hide([id]) }
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/receipts/\(id)/review", body: ReceiptReviewBody(target))
            Haptics.success()
            dropRow(id)
            app.unhide([id])
            if undoable {
                showToast(target == .rejected ? "Arkistoitu." : "Palautettu odottamaan.", action: "Kumoa") {
                    await move(id, from: target, to: from, undoable: false)
                }
            }
            await load()
        } catch {
            withAnimation { app.unhide([id]) }
            failure = error.userMessage
            Haptics.error()
        }
    }

    /// Approved as the kuitit queue does, so a refusal (no amount, a closed month) says why.
    private func approve(_ id: String) async {
        struct Body: Encodable { let receiptIds: [String] }
        guard !moving.contains(id) else { return }
        moving.insert(id)
        defer { moving.remove(id) }
        failure = nil
        withAnimation { app.hide([id]) }
        do {
            let result: BatchApproveResult = try await app.api.send("POST", "/api/receipts/batch-approve", body: Body(receiptIds: [id]))
            if let problem = result.firstError {
                withAnimation { app.unhide([id]) }
                failure = problem
                Haptics.error()
                return
            }
            Haptics.success()
            dropRow(id)
            app.unhide([id])
            showToast("Hyväksytty.", action: nil, run: nil)
            await load()
        } catch {
            withAnimation { app.unhide([id]) }
            failure = error.userMessage
            Haptics.error()
        }
    }

    /// Out of the loaded rows before the reload, so a reload that fails does not bring it back here.
    private func dropRow(_ id: String) {
        guard let rows = receipts.value else { return }
        receipts = .loaded(rows.filter { $0.id != id })
        total = max(0, total - 1)
    }

    // MARK: Toast

    private func showToast(_ text: String, action: String?, run: (() async -> Void)?) {
        toastTask?.cancel()
        toastAction = run
        withAnimation(.snappy) { toast = Toast(text: text, actionLabel: action) }
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation { toast = nil }
            toastAction = nil
        }
    }

    private func runToastAction() {
        let action = toastAction
        toastTask?.cancel()
        toastAction = nil
        withAnimation { toast = nil }
        if let action { Task { await action() } }
    }
}
