import SwiftUI
import UIKit
import LashKirjaCore

/// Ilmoita ongelmasta: one line from the owner marks this moment in the event log and sends
/// the trail at once. The code it shows finds the report and what led to it
/// (`npm run debug-log -- --report CODE`).
struct ReportProblemView: View {
    @Environment(AppModel.self) private var app
    @State private var note = ""
    @State private var busy = false
    @State private var sentCode: String?
    @State private var sendFailed = false
    @FocusState private var noteFocused: Bool

    var body: some View {
        List {
            Section {
                TextField("Mitä tapahtui?", text: $note, axis: .vertical)
                    .lineLimit(3...8)
                    .disabled(busy)
                    .focused($noteFocused)
            } header: {
                Text("Kuvaile ongelma lyhyesti")
            } footer: {
                Text("Lokiin menee vain mitä sovelluksessa tehtiin (näkymät, pyynnöt, virheet), ei summia, nimiä tai salasanoja.")
            }
            Section {
                Button { Task { await send() } } label: {
                    HStack {
                        Text("Lähetä ilmoitus").frame(maxWidth: .infinity, minHeight: 44).font(.headline)
                        if busy { ProgressView() }
                    }
                }
                .buttonStyle(.primary)
                .disabled(busy || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .listRowBackground(Color.clear)
            }
            if let sentCode {
                Section {
                    Text("Ilmoitus tallennettu. Koodi: \(sentCode)").font(.headline).textSelection(.enabled)
                    Text(sendFailed
                         ? "Lokia ei saatu vielä lähetettyä. Se lähtee automaattisesti, kun yhteys toimii."
                         : "Kerro tämä koodi, niin ongelma löytyy lokista.")
                        .font(.footnote).foregroundStyle(sendFailed ? Theme.warning : Theme.ink2)
                    Button("Kopioi koodi") { UIPasteboard.general.string = sentCode }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .formKeyboard()
        .navigationTitle("Ilmoita ongelmasta")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send() async {
        // The keyboard goes with the note: left up, it covered the code's line and 'Kopioi koodi' (U081).
        noteFocused = false
        busy = true
        defer { busy = false }
        let code = ProblemReport.newCode()
        await EventLog.shared.record(ProblemReport.event(code: code, note: note, screen: "settings.report"))
        let sent = await app.eventUploader.flush()
        sentCode = code
        sendFailed = !sent
        note = ""
        sent ? Haptics.success() : Haptics.error()
    }
}
