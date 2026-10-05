import SwiftUI
import LashKirjaCore

/// Asetukset → Sähköpostimallit: the owner's own texts for sending an invoice. The default one
/// fills the send sheet (and automatic sends); placeholders are filled per invoice by the server.
struct EmailTemplatesView: View {
    @Environment(AppModel.self) private var app
    @State private var state = ScreenLoad<[EmailTemplate]>()
    @State private var placeholders = EmailPlaceholder.all
    @State private var gate = ReloadGate()
    @State private var limit = ShowMore()
    @State private var failure: String?
    @State private var editing: EditTarget?

    enum EditTarget: Identifiable, Hashable {
        case new, existing(EmailTemplate)
        var id: String {
            switch self {
            case .new: "new"
            case .existing(let template): template.id
            }
        }
    }

    var body: some View {
        List {
            if let all = state.value {
                if let banner = state.banner {
                    Section { RefreshFailureBanner(failure: banner, retry: load) }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                let rows = all.filter { !app.removedIds.contains($0.id) }
                Section {
                    if rows.isEmpty {
                        Text("Ei malleja vielä. Laskun lähetyksessä käytetään vakiotekstiä.").foregroundStyle(Theme.ink2)
                    }
                    ForEach(rows.prefix(limit.visible(rows.count))) { template in
                        Button { editing = .existing(template) } label: { row(template) }
                            .swipeActions {
                                Button("Poista", role: .destructive) { remove(template) }
                                if !template.isDefault {
                                    Button("Oletus") { Task { await makeDefault(template) } }.tint(Theme.accent)
                                }
                            }
                    }
                    ShowMoreButton(limit: $limit, total: rows.count)
                    Button { editing = .new } label: { Label("Uusi malli", systemImage: "plus") }
                } footer: {
                    Text("Oletusmalli täyttää lähetyksen aiheen ja viestin. Pyyhkäise vasemmalle asettaaksesi oletuksen tai poistaaksesi.")
                }
                placeholderHelp
            } else {
                ScreenStateView(state: state, retry: load) { (_: [EmailTemplate]) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
            if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Sähköpostimallit")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { editing = .new } label: { Image(systemName: "plus") }.accessibilityLabel("Uusi malli")
            }
        }
        .sheet(item: $editing) { target in
            switch target {
            case .new: EmailTemplateEditor(existing: nil, placeholders: placeholders)
            case .existing(let template): EmailTemplateEditor(existing: template, placeholders: placeholders)
            }
        }
        .refreshable { await load() }
        .task(id: app.dataVersion) {
            guard state.value == nil || gate.isDue(version: app.dataVersion) else { return }
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
    }

    private func row(_ template: EmailTemplate) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(template.name).foregroundStyle(Theme.ink)
                if template.isDefault {
                    Text("Oletus").font(.caption2.weight(.semibold)).foregroundStyle(Theme.accent)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.accent.opacity(0.12), in: Capsule())
                }
            }
            Text(template.subject).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
        }
    }

    private var placeholderHelp: some View {
        Section("Paikkamerkit") {
            DisclosureGroup("Näin malli täyttyy laskulle") {
                ForEach(placeholders) { item in
                    LabeledContent(item.token, value: item.label).font(.subheadline.monospaced())
                }
            }
        }
    }

    private func load() async {
        state.begin()
        do {
            let list: EmailTemplateList = try await app.api.get("/api/invoice-email-templates", query: ["kind": "invoice"])
            state.succeed(list.templates)
            if let server = list.placeholders, !server.isEmpty { placeholders = server }
        } catch is CancellationError {
        } catch {
            state.fail(error)
        }
    }

    private func makeDefault(_ template: EmailTemplate) async {
        failure = nil
        do {
            let _: EmailTemplateResponse = try await app.api.send("PATCH", "/api/invoice-email-templates/\(template.id)", body: EmailTemplateDefault())
            Haptics.success()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }

    private func remove(_ template: EmailTemplate) {
        let api = app.api, id = template.id
        withAnimation {
            app.removeInBackground([id]) {
                let _: Ignored = try await api.send("DELETE", "/api/invoice-email-templates/\(id)", body: Optional<EmptyBody>.none)
            }
        }
    }
}

/// New or edited template: name, subject, message and "Oletusmalli". Placeholders are typed as they are.
struct EmailTemplateEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let existing: EmailTemplate?
    let placeholders: [EmailPlaceholder]
    @State private var name = ""
    @State private var subject = ""
    @State private var message = ""
    @State private var isDefault = false
    @State private var busy = false
    @State private var failure: String?
    @State private var loaded = false

    private var draft: EmailTemplateDraft {
        EmailTemplateDraft(name: name, subject: subject, body: message, isDefault: isDefault)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Mallin nimi", text: $name)
                    Toggle("Oletusmalli", isOn: $isDefault)
                } footer: {
                    Text("Oletusmalli täyttää laskun lähetyksen valmiiksi.")
                }
                Section("Viesti") {
                    TextField("Aihe", text: $subject)
                    TextEditor(text: $message).frame(minHeight: 180).accessibilityLabel("Viesti")
                }
                Section {
                    // Tap to add at the end of the message: quicker than typing the braces.
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(placeholders) { item in
                                SectionChip(title: item.token, selected: false) { message += item.token }
                            }
                        }
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } header: {
                    Text("Paikkamerkit")
                } footer: {
                    Text(EmailPlaceholder.help(placeholders) + ".")
                }
                if let failure { Section { Text(failure).foregroundStyle(Theme.danger) } }
            }
            .navigationTitle(existing == nil ? "Uusi malli" : "Muokkaa mallia")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Peruuta") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Tallenna") { Task { await save() } }.disabled(busy || draft.problem != nil)
                }
            }
            .interactiveDismissDisabled(busy)
            .onAppear {
                guard !loaded else { return }
                loaded = true
                if let existing {
                    name = existing.name
                    subject = existing.subject
                    message = existing.body
                    isDefault = existing.isDefault
                } else {
                    // A first template starts from the shape of the built-in text.
                    subject = "Lasku {laskunumero} · {yritys}"
                    message = "Hei {asiakas},\n\nliitteenä lasku {laskunumero}.\n\nSumma: {summa}\nEräpäivä: {erapaiva}\nViitenumero: {viitenumero}\n\nKiitos!\n{yritys}"
                }
            }
        }
    }

    private func save() async {
        let draft = draft
        if let problem = draft.problem { failure = problem; Haptics.error(); return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            if let existing {
                let _: EmailTemplateResponse = try await app.api.send("PATCH", "/api/invoice-email-templates/\(existing.id)", body: draft)
            } else {
                let _: EmailTemplateResponse = try await app.api.send("POST", "/api/invoice-email-templates", body: draft)
            }
            Haptics.success()
            dismiss()
        } catch {
            failure = error.userMessage
            Haptics.error()
        }
    }
}
