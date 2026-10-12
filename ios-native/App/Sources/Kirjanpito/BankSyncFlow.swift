import Foundation
import LashKirjaCore

/// "Päivitä" on a bank connection (`POST /api/bank/connections/[id]/sync`) and what the owner must
/// see after it: the balances the sync returned at once, every screen asked again, and, when the
/// server finishes the sync as a job, a wait (at most a minute) until `/api/sync/version` says the
/// new rows are in. The old balance never stays on screen without a word.
@MainActor
enum BankSyncFlow {
    enum Outcome {
        /// The sync is in: the screens are reloading.
        case done(BankSyncResult)
        /// The server is still working on it after a minute; the screens reload when it lands.
        case stillRunning(BankSyncResult)
    }

    /// Told when the sync went to the background on the server ("Päivitetään…").
    static func run(_ app: AppModel, connectionId: String, waiting: () -> Void) async throws -> Outcome {
        let before = app.versions.server
        let started = Date()
        let result: BankSyncResult = try await app.api.send("POST", "/api/bank/connections/\(connectionId)/sync", body: EmptyBody())
        app.versions.takeBalances(result.balances)
        app.versions.absorb(dataVersion: result.dataVersion)
        app.dataVersion += 1
        guard result.isPending else { return .done(result) }
        waiting()
        while true {
            try await Task.sleep(nanoseconds: UInt64(VersionPolling.syncWaitStep * 1_000_000_000))
            let snapshot = await app.pollVersion(absorb: true)
            switch SyncWait.check(before: before, now: snapshot, started: started, at: Date()) {
            case .fresh:
                app.dataVersion += 1
                return .done(result)
            case .waiting:
                continue
            case .timedOut:
                return .stillRunning(result)
            }
        }
    }

    static let stillRunningNotice = "Pankki käsittelee hakua vielä. Saldot päivittyvät, kun haku valmistuu."
}
