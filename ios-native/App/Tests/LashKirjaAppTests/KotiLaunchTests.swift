import XCTest
import Observation
import LashKirjaCore
@testable import LashKirja

/// Launch → Koti (w44): the previous run's dashboard is read from disk, off the main actor, before
/// the tabs appear, so Koti's first frame is the figures and not a spinner.
@MainActor
final class KotiLaunchTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("koti-launch-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func dashboard(month: String) -> Data {
        Data("""
        {"firstName":"Liisa","month":"\(month)","income":120,"expenses":40,"source":"kuitit","basis":"laskutusperuste","txCount":0,
         "receiptCount":0,"invoiceCount":0,"matching":{"matchable":0,"matched":0,"suggested":0},"events":{"done":0,"total":0},
         "handled":null,"estimatedVat":0,"isRefund":false,"vat":{"registered":true,"entityType":"oy","ytdRevenue":0,"threshold":20000},
         "hasImap":false,"pendingReceiptsCount":0,"bank":{"totalBalance":0,"accountCount":0,"needsAttention":0,"state":"none",
         "hasBalance":false,"reconnectBank":null},"bankTrend":null,"cashflow":[{"month":"\(month)","income":120,"expenses":40,"source":"kuitit"}],"receivables":{"totalOpen":0,"overdue":0,"overdueCount":0},
         "payables":{"totalOpen":0,"overdue":0,"overdueCount":0},"items":[],"itemTotals":{"pending_receipt":0,"vat_gap":0,"missing_receipt":0,"invoice_match":0,"receipt_match":0,"payment_duplicate":0,"draft_invoice":0,"overdue_invoice":0},"blockingTotal":0,"previousMonth":null,
         "setup":{"receipts":false,"bank":false,"seller":false,"empty":true},"isSingleVatProfile":true,"singleVatRate":25.5}
        """.utf8)
    }

    /// A signed-in owner whose last run left Koti's month on disk; the server is unreachable.
    private func launchedApp(user: String, onDisk: Data?) async throws -> AppModel {
        let disk = ResourceDiskStore(directory: directory)
        if let onDisk {
            let key = ResourceKey(user: user, path: "/api/dashboard", query: ["month": MonthKey.current()])
            try disk.write(user: user, entries: [key.id: ResourceEntry(data: onDisk, dataVersion: 7, fetchedAt: Date())])
        }
        let tokens = InMemoryTokenStore()
        await tokens.save(StoredToken(token: "t", expiresAt: Date().addingTimeInterval(3600), issuedAt: Date(), userId: user))
        return AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: tokens, resources: ResourceCache(store: disk))
    }

    func testKotiHasItsLastDashboardWhenTheTabsAppear() async throws {
        let app = try await launchedApp(user: "koti-launch-1", onDisk: dashboard(month: MonthKey.current()))
        // What Koti would find at the moment the phase turns signed in (the tabs are built then).
        var atSignIn: Dashboard??
        withObservationTracking { _ = app.phase } onChange: {
            MainActor.assumeIsolated { atSignIn = .some(app.kotiPreview()) }
        }
        await app.start()
        guard case .signedIn = app.phase else { return XCTFail("the stored session did not open the app") }
        let shown = try XCTUnwrap(atSignIn ?? nil, "Koti had no dashboard when the tabs appeared: its first frame was a spinner")
        XCTAssertEqual(shown.month, MonthKey.current())
        XCTAssertEqual(shown.income, 120)
    }

    func testKotiSeedsItsFirstFrameFromTheLaunchRead() async throws {
        let app = try await launchedApp(user: "koti-launch-2", onDisk: dashboard(month: MonthKey.current()))
        await app.start()
        let model = KotiModel(api: app.api, profile: { nil }, app: app, opening: app.kotiPreview())
        XCTAssertEqual(model.state.value?.income, 120, "KotiView's model starts without the figures")
        XCTAssertEqual(model.month, MonthKey.current())
    }

    func testWithoutADashboardOnDiskKotiStartsEmptyAndLoads() async throws {
        let app = try await launchedApp(user: "koti-launch-3", onDisk: nil)
        await app.start()
        XCTAssertNil(app.kotiPreview())
        XCTAssertNil(KotiModel(api: app.api, profile: { nil }, app: app, opening: app.kotiPreview()).state.value)
    }
}
