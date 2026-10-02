import Foundation
import LashKirjaCore

/// "Kuittaa" on a failed job. The server marks it dismissed (POST /api/jobs/:id/dismiss); the id
/// is also kept on the phone, so a server without that route still lets the owner clear it.
/// Job ids are UUIDs, so one list serves every account on the device.
@MainActor
enum JobDismissals {
    private static let key = "jobs.dismissed.v1"
    private static let limit = 200

    static var ids: Set<String> { Set(UserDefaults.standard.stringArray(forKey: key) ?? []) }

    private static func remember(_ id: String) {
        var list = UserDefaults.standard.stringArray(forKey: key) ?? []
        guard !list.contains(id) else { return }
        list.append(id)
        UserDefaults.standard.set(Array(list.suffix(limit)), forKey: key)
    }

    static func dismiss(_ id: String, api: APIClient) async throws {
        do {
            let _: Ignored = try await api.send("POST", "/api/jobs/\(id)/dismiss", body: EmptyBody())
        } catch let error as LKError where error.status == 404 || error.status == 409 {
            // An older server (no such route) or a job that is no longer failed: hiding it is right.
        }
        remember(id)
    }

    /// The owner's bank connections as the failure rule reads them; nil when they did not load.
    static func connections(api: APIClient) async -> [JobsQueue.ConnectionState]? {
        guard let list: BankConnections = try? await api.get("/api/bank/connections") else { return nil }
        return JobsQueue.connectionStates(list)
    }
}
