import SwiftUI
import LashKirjaCore

struct AssistantView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model: ChatModel?
    @State private var input = ""
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
            if model == nil {
                let m = ChatModel(app: app)
                model = m
                await m.loadLatest()
            }
        }
    }

    private func conversation(_ model: ChatModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.messages.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(Theme.accent)
                            Text("Kysy kirjanpidostasi").font(.headline)
                            Text("Esimerkiksi: \"Paljonko ALV:ta maksan tässä kuussa?\"").font(.subheadline).foregroundStyle(Theme.ink2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                    }
                    ForEach(model.messages) { message in
                        Bubble(message: message, streaming: model.streaming && message.id == model.messages.last?.id)
                            .id(message.id)
                    }
                    if let failure = model.failure {
                        Text(failure).font(.footnote).foregroundStyle(Theme.danger)
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            // An inset rides on top of the keyboard; a composer stacked under the scroll view was left
            // behind it when the field took focus back after returning from a source page.
            .safeAreaInset(edge: .bottom, spacing: 0) { composer(model) }
            .onChange(of: model.messages.last?.content) { _, _ in
                if let last = model.messages.last { withAnimation(.snappy) { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            // Opening a source page drops the focus, so coming back does not pop the keyboard up.
            .onDisappear { focused = false }
        }
    }

    private func composer(_ model: ChatModel) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Kirjoita viesti…", text: $input, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(focused ? Theme.ink2.opacity(0.4) : Theme.line))
            Button {
                if model.streaming { model.stop() } else { model.send(input); input = "" }
            } label: {
                Image(systemName: model.streaming ? "stop.fill" : "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Theme.onInk)
                    .frame(width: 40, height: 40)
                    .background(model.streaming || !input.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.ink : Theme.ink2.opacity(0.5), in: Circle())
            }
            .disabled(!model.streaming && input.trimmingCharacters(in: .whitespaces).isEmpty)
            .accessibilityLabel(model.streaming ? "Pysäytä" : "Lähetä")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

private struct Bubble: View {
    let message: ChatMessage
    let streaming: Bool

    var body: some View {
        let mine = message.role == "user"
        VStack(alignment: mine ? .trailing : .leading, spacing: 8) {
            Group {
                if message.content.isEmpty && streaming {
                    ProgressView().padding(.vertical, 4)
                } else {
                    Text(markdown(message.content))
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
                        Button("Poista", role: .destructive) { Task { await patch(c, deleted: true) } }
                        Button(archived ? "Palauta" : "Arkistoi") { Task { await patch(c, archived: !archived) } }.tint(Theme.accent)
                        Button("Nimeä") { renaming = c; newTitle = c.title }.tint(Theme.ink2)
                    }
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
            .task(id: "\(archived)|\(search)") { await load() }
            .alert("Nimeä keskustelu", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Nimi", text: $newTitle)
                Button("Tallenna") { if let c = renaming { Task { await patch(c, title: newTitle) } } }
                Button("Peruuta", role: .cancel) {}
            }
        }
    }

    private func load() async {
        var query: [String: String] = [:]
        if archived { query["archived"] = "1" }
        if !search.isEmpty { query["q"] = search }
        if let list: ConversationList = try? await app.api.get("/api/ai/conversations", query: query) {
            withAnimation { conversations = list.conversations }
        }
    }

    private func patch(_ c: Conversation, title: String? = nil, archived: Bool? = nil, deleted: Bool? = nil) async {
        struct Body: Encodable { let id: String; let title: String?; let archived: Bool?; let deleted: Bool? }
        if (try? await app.api.send("PATCH", "/api/ai/conversations", body: Body(id: c.id, title: title, archived: archived, deleted: deleted)) as Ignored) != nil {
            Haptics.success()
            if deleted == true || archived != nil, model.conversationId == c.id { model.startNew() }
            await load()
        }
    }
}
