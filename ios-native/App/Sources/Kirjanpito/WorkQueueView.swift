import SwiftUI
import LashKirjaCore

/// Huomioitavat (/tyot): background jobs and the exception queue, with a retry for failed reads.
struct WorkQueueView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<Snapshot> = .idle
    /// Coming back to the screen does not ask the server again unless something changed.
    @State private var gate = ReloadGate()
    @State private var filter = "all"
    @State private var retrying: String?
    @State private var note: (text: String, failed: Bool)?

    struct Snapshot {
        var jobs: [BackgroundJob]
        var items: [WorkQueueItem]
    }

    var body: some View {
        List {
            if let data = state.value {
                jobsSection(JobsQueue.visibleJobs(data.jobs))
                itemsSections(data.items)
            } else {
                LoadState(state: state, retry: load) { (_: Snapshot) in EmptyView() }
                    .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("Huomioitavat")
        .refreshable { await load() }
        .task(id: app.dataVersion) {
            guard state.value == nil || gate.isDue(version: app.dataVersion) else { return }
            // Marked only after a load that finished: a cancelled one must not count as fresh.
            let version = app.dataVersion
            await load()
            if !Task.isCancelled { gate.mark(version: version) }
        }
        // Poll only while a job is running (BOOKS-16); the task ends when the screen goes.
        .task(id: hasActiveJob) {
            guard hasActiveJob else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if Task.isCancelled { break }
                await load()
            }
        }
    }

    private var hasActiveJob: Bool { state.value?.jobs.contains(where: \.isActive) ?? false }

    @ViewBuilder private func jobsSection(_ jobs: [BackgroundJob]) -> some View {
        Section {
            if jobs.isEmpty {
                Text("Ei käynnissä olevia töitä. Tuonnit ja haut näkyvät tässä, kun ne ovat kesken.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
            }
            ForEach(jobs) { job in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(job.title).foregroundStyle(Theme.ink)
                        Text(job.secondary).font(.caption).foregroundStyle(Theme.ink2)
                    }
                    Spacer(minLength: 8)
                    if job.isActive { ProgressView().controlSize(.small) }
                    Text(job.statusLabel)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(tone(job.status).opacity(0.14), in: Capsule())
                        .foregroundStyle(tone(job.status))
                }
            }
        } header: {
            Text("Työt")
        } footer: {
            Text("Tuonnit, haut ja niiden virheet.")
        }
    }

    @ViewBuilder private func itemsSections(_ items: [WorkQueueItem]) -> some View {
        if items.isEmpty {
            Section {
                Text("Ei korjattavaa. Jos tuonti tai haku epäonnistuu, se näkyy tässä.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
            } header: {
                Text("Korjattavat")
            }
        } else {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(JobsQueue.chips(items, selected: filter)) { chip in
                            Button { filter = chip.id } label: {
                                Text("\(chip.label) \(chip.count)")
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 34)
                                    .background(filter == chip.id ? Theme.ink : Theme.surface, in: Capsule())
                                    .overlay(Capsule().stroke(Theme.line))
                                    .foregroundStyle(filter == chip.id ? Theme.onInk : Theme.ink)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            } header: {
                Text("Korjattavat")
            }
            Section {
                let visible = JobsQueue.filter(items, kind: filter)
                if visible.isEmpty {
                    Text("Ei korjattavaa.").foregroundStyle(Theme.ink2)
                }
                ForEach(visible) { item in
                    row(item)
                }
            } footer: {
                if let note { Text(note.text).foregroundStyle(note.failed ? Theme.danger : Theme.success) }
            }
        }
    }

    @ViewBuilder private func row(_ item: WorkQueueItem) -> some View {
        let label = VStack(alignment: .leading, spacing: 2) {
            Text(item.title).foregroundStyle(Theme.ink)
            // The reason ends in the advice, so it is shown in full (F29).
            Text("\(item.kindLabel) · \(item.detail)").font(.caption).foregroundStyle(Theme.ink2)
        }
        if !item.retryIds.isEmpty {
            HStack(spacing: 12) {
                label
                Spacer(minLength: 8)
                Button {
                    Task { await retry(item) }
                } label: {
                    Text(retrying == item.id ? "Käynnistetään…" : "Yritä uudelleen")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .background(Theme.accentSoft, in: Capsule())
                        .foregroundStyle(Theme.accentDark)
                }
                .buttonStyle(.borderless)
                .disabled(retrying != nil)
            }
        } else if let href = item.href, let route = Route.fromHref(href) {
            NavigationLink(value: route) { label }
        } else {
            label
        }
    }

    private func tone(_ status: String) -> Color {
        switch status {
        case "running": Theme.accent
        case "failed": Theme.danger
        case "done": Theme.success
        default: Theme.ink2
        }
    }

    private func load() async {
        do {
            let api = app.api
            async let jobs: JobsList = api.get("/api/jobs")
            async let queue: WorkQueueList = api.get("/api/work-queue")
            let snapshot = Snapshot(jobs: try await jobs.jobs, items: try await queue.items)
            state = .loaded(snapshot)
        } catch is CancellationError {
        } catch {
            // "Not loaded" is not "empty" (BOOKS-16): a loaded list stays, with the error below it.
            if state.value == nil { state = .failed(error.userMessage) } else { note = (error.userMessage, true) }
        }
    }

    /// One retry starts every identical failure the row stands for (F29).
    private func retry(_ item: WorkQueueItem) async {
        guard retrying == nil else { return }
        retrying = item.id
        defer { retrying = nil }
        do {
            for id in item.retryIds {
                let _: Ignored = try await app.api.send("POST", "/api/jobs/\(id)/retry", body: Optional<EmptyBody>.none)
            }
            Haptics.success()
            note = ("Luku käynnistettiin uudelleen.", false)
            app.dataVersion += 1
        } catch is CancellationError {
        } catch {
            Haptics.error()
            note = (error.userMessage, true)
        }
        await load()
    }
}
