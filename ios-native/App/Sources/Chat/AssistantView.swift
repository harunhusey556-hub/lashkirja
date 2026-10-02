import SwiftUI
import LashKirjaCore

struct AssistantView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model: ChatModel?
    @State private var showConversations = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    conversation(model)
                } else {
                    ProgressView()
                }
            }
            .background(Theme.canvas)
            .navigationTitle(model?.title ?? "Avustaja")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showConversations = true } label: { Image(systemName: "bubble.left.and.bubble.right") }
                        .accessibilityLabel("Keskustelut")
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Valmis") { dismiss() } }
            }
            .appDestinations()
            .sheet(isPresented: $showConversations) {
                if let model { ConversationsSheet(model: model) }
            }
        }
        .task {
            guard model == nil else { return }
            if let existing = app.chat {
                model = existing
                await existing.reopen()
                return
            }
            let m = ChatModel(app: app)
            app.chat = m
            model = m
            // Status and history load side by side.
            async let status: Void = m.loadStatus()
            await m.loadLatest()
            await status
        }
    }

    private func conversation(_ model: ChatModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.messages.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(Theme.accent)
                            Text("Miten voin auttaa?").font(.headline).foregroundStyle(Theme.ink)
                            Text(AssistantCooldown.intro(available: model.aiAvailable))
                                .font(.subheadline)
                                .foregroundStyle(Theme.ink2)
                                .multilineTextAlignment(.center)
                            shortcuts(model).padding(.top, 8)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                    } else if model.aiAvailable == false, !model.streaming, model.messages.last?.role == "assistant" {
                        // Limited mode: the shortcuts that still work stay at hand after each reply.
                        shortcuts(model)
                    }
                    ForEach(model.messages) { message in
                        Bubble(message: message, streaming: model.streaming && message.id == model.messages.last?.id)
                            .equatable()
                            .id(message.id)
                    }
                    if let failure = model.failure {
                        Text(failure).font(.footnote).foregroundStyle(Theme.danger)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            // Open on the latest message, and keep it in view when the keyboard shrinks the scroll view.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            // An inset rides on top of the keyboard; a composer stacked under the scroll view was left
            // behind it when the field took focus back after returning from a source page.
            .safeAreaInset(edge: .bottom, spacing: 0) { composer(model) }
            // A new message scrolls into view; a growing reply stays in view through the
            // bottom anchor above, without an animation per update.
            .onChange(of: model.messages.count) { _, _ in
                if let last = model.messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
            // Opening a source page drops the focus, so coming back does not pop the keyboard up.
            .onDisappear { focused = false }
        }
    }

    private func shortcuts(_ model: ChatModel) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AssistantCooldown.shortcuts) { shortcut in
                    Button { model.send(shortcut.message) } label: {
                        Text(shortcut.label)
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 36)
                            .background(Theme.accentSoft, in: Capsule())
                            .foregroundStyle(Theme.accentDark)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.streaming || !model.canSendShortcut)
                }
            }
        }
    }

    private func composer(_ model: ChatModel) -> some View {
        VStack(spacing: 6) {
            if model.cooldownUntil != nil {
                Label(AssistantCooldown.cooldownNote, systemImage: "hourglass")
                    .font(.footnote)
                    .foregroundStyle(Theme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if model.aiAvailable == false {
                Label(AssistantCooldown.unavailableNote, systemImage: "sparkles")
                    .font(.footnote)
                    .foregroundStyle(Theme.ink2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            composerRow(model)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func composerRow(_ model: ChatModel) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(model.canType ? "Kirjoita viesti…" : "Kirjoittaminen ei ole nyt käytössä", text: Binding(get: { model.input }, set: { model.input = $0 }), axis: .vertical)
                .disabled(!model.canType && !model.streaming)
                .lineLimit(1...5)
                .focused($focused)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(focused ? Theme.ink2.opacity(0.4) : Theme.line))
            Button {
                if model.streaming { model.stop() } else { model.send(model.input); model.input = "" }
            } label: {
                Image(systemName: model.streaming ? "stop.fill" : "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Theme.onInk)
                    .frame(width: 40, height: 40)
                    .background(model.streaming || (model.canType && !model.input.trimmingCharacters(in: .whitespaces).isEmpty) ? Theme.ink : Theme.ink2.opacity(0.5), in: Circle())
            }
            .disabled(!model.streaming && (model.input.trimmingCharacters(in: .whitespaces).isEmpty || !model.canType))
            .accessibilityLabel(model.streaming ? "Pysäytä" : "Lähetä")
        }
    }
}

/// Equatable: while a reply streams, the earlier bubbles are not rebuilt (or their markdown re-parsed).
private struct Bubble: View, Equatable {
    let message: ChatMessage
    let streaming: Bool

    var body: some View {
        let mine = message.role == "user"
        VStack(alignment: mine ? .trailing : .leading, spacing: 8) {
            Group {
                if message.content.isEmpty && streaming {
                    ProgressView().padding(.vertical, 4)
                } else {
                    // Plain text while the reply grows; markdown once it is complete.
                    Text(streaming ? AttributedString(message.content) : markdown(message.content))
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(mine ? Theme.ink : Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .foregroundStyle(mine ? Theme.onInk : Theme.ink)
            if !message.sources.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(message.sources, id: \.href) { source in
                            if let route = Route.fromHref(source.href) {
                                NavigationLink(value: route) {
                                    Label(source.label, systemImage: "link").font(.caption.weight(.semibold))
                                        .padding(.horizontal, 10).padding(.vertical, 6)
                                        .background(Theme.accentSoft, in: Capsule())
                                        .foregroundStyle(Theme.accentDark)
                                }
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

private struct ConversationsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ChatModel
    @State private var conversations: [Conversation] = []
    @State private var search = ""
    @State private var archived = false
    @State private var renaming: Conversation?
    @State private var newTitle = ""
    @State private var loaded = false
    @State private var failure: String?
    /// Only the latest list load may write the list: a swipe's reload and the search's
    /// reload no longer overlap and put back a row that was just removed.
    @State private var listLoads = LoadGeneration()

    var body: some View {
        NavigationStack {
            List {
                Picker("", selection: $archived) {
                    Text("Aktiiviset").tag(false)
                    Text("Arkisto").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                ForEach(conversations) { c in
                    Button {
                        Task { await model.open(c); dismiss() }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.title).lineLimit(1).foregroundStyle(Theme.ink)
                            if let updated = c.updatedAt { Text(InvoiceDetailView.timestamp(updated)).font(.caption).foregroundStyle(Theme.ink2) }
                        }
                    }
                    .swipeActions {
                        Button("Poista", role: .destructive) { act(c, deleted: true) }
                        Button(archived ? "Palauta" : "Arkistoi") { act(c, archived: !archived) }.tint(Theme.accentFill)
                        Button("Nimeä") { renaming = c; newTitle = c.title }.tint(Theme.neutralFill)
                    }
                }
            }
            // The empty state is not a row: a row that comes and goes beside the swiped
            // rows upset the list's row count while a swipe removal was animating.
            .overlay {
                if loaded && conversations.isEmpty && failure == nil {
                    Text(search.isEmpty ? (archived ? "Arkisto on tyhjä." : "Ei vielä keskusteluja.") : "Ei osumia.")
                        .foregroundStyle(Theme.ink2)
                        .allowsHitTesting(false)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.bar)
                }
            }
            .searchable(text: $search, prompt: "Hae keskusteluja")
            .navigationTitle("Keskustelut")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Valmis") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { model.startNew(); dismiss() } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("Uusi keskustelu")
                }
            }
            .task(id: "\(archived)|\(search)") {
                // Typing settles before the server is asked (one request, not one per letter).
                if !search.isEmpty { try? await Task.sleep(nanoseconds: 300_000_000) }
                guard !Task.isCancelled else { return }
                await load()
            }
            .alert("Nimeä keskustelu", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Nimi", text: $newTitle)
                Button("Tallenna") { if let c = renaming { act(c, title: newTitle) } }
                Button("Peruuta", role: .cancel) {}
            }
        }
    }

    private func load() async {
        let generation = listLoads.next()
        var query: [String: String] = [:]
        if archived { query["archived"] = "1" }
        if !search.isEmpty { query["q"] = search }
        do {
            let list: ConversationList = try await app.api.get("/api/ai/conversations", query: query)
            guard listLoads.isCurrent(generation) else { return }
            conversations = list.conversations.uniquedById()
            failure = nil
            loaded = true
        } catch is CancellationError {
        } catch {
            guard listLoads.isCurrent(generation) else { return }
            failure = error.userMessage
            loaded = true
        }
    }

    /// A swipe removes the row at once, in the same update as the swipe (the list animates
    /// the destructive swipe out and must find the row gone); the request follows.
    private func act(_ c: Conversation, title: String? = nil, archived: Bool? = nil, deleted: Bool? = nil) {
        let removes = deleted == true || archived != nil
        let index = conversations.firstIndex { $0.id == c.id }
        if removes {
            conversations.removeAll { $0.id == c.id }
            // A load already on its way would bring the row back.
            listLoads.next()
        }
        Task { await patch(c, at: index, removes: removes, title: title, archived: archived, deleted: deleted) }
    }

    private func patch(_ c: Conversation, at index: Int?, removes: Bool, title: String?, archived: Bool?, deleted: Bool?) async {
        struct Body: Encodable { let id: String; let title: String?; let archived: Bool?; let deleted: Bool? }
        do {
            let _: Ignored = try await app.api.send("PATCH", "/api/ai/conversations", body: Body(id: c.id, title: title, archived: archived, deleted: deleted))
            Haptics.success()
            if removes, model.conversationId == c.id { model.startNew() }
            if let title { model.renamed(c.id, to: title) }
            await load()
        } catch {
            // Failed: the row comes back where it was.
            if removes, !conversations.contains(where: { $0.id == c.id }) {
                conversations.insert(c, at: min(index ?? 0, conversations.count))
            }
            failure = error.userMessage
            Haptics.error()
        }
    }
}
