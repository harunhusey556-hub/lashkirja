import XCTest
import LashKirjaCore
@testable import LashKirja

/// w67 (row 27, owner): a session stored on this device that is within its idle and absolute
/// limits opens the app on Koti's cached figures in the first frame, with no request first; past a
/// limit the launch is the sign-in screen with the expiry notice, and the session is ended.
@MainActor
final class TrustedLaunchTests: XCTestCase {
    private var directory: URL!
    private let user = "trusted-launch"

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("trusted-launch-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A Keychain stand-in the launch can read before the first frame, like `KeychainTokenStore`.
    private final class LaunchStore: TokenStore, LaunchTokenReading, @unchecked Sendable {
        private let lock = NSLock()
        private var token: StoredToken?
        private var pending: String?
        init(_ token: StoredToken?) { self.token = token }
        func loadAtLaunch() -> StoredToken? { lock.withLock { token } }
        func load() -> StoredToken? { loadAtLaunch() }
        func save(_ token: StoredToken) { lock.withLock { self.token = token } }
        func clear() { lock.withLock { token = nil } }
        func loadPendingRevoke() -> String? { lock.withLock { pending } }
        func savePendingRevoke(_ token: String?) { lock.withLock { pending = token } }
    }

    private func stored(startedAgo days: Double = 10) -> StoredToken {
        StoredToken(token: "t", expiresAt: Date().addingTimeInterval(20 * 86_400), issuedAt: Date().addingTimeInterval(-86_400),
                    userId: user, sessionStartedAt: Date().addingTimeInterval(-days * 86_400))
    }

    private func app(_ store: LaunchStore, lastActive: Date?, kotiOnDisk: Bool = true) throws -> AppModel {
        let disk = ResourceDiskStore(directory: directory)
        if kotiOnDisk {
            let key = ResourceKey(user: user, path: "/api/dashboard", query: ["month": MonthKey.current()])
            try disk.write(user: user, entries: [key.id: ResourceEntry(data: dashboard(), dataVersion: 3, fetchedAt: Date())])
        }
        return AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: store, resources: ResourceCache(store: disk),
                        signer: nil, lastActive: lastActive)
    }

    func testAValidSessionOpensOnKotisCachedFiguresInTheFirstFrame() throws {
        let app = try app(LaunchStore(stored()), lastActive: Date().addingTimeInterval(-2 * 86_400))
        // Straight after init, before any await: what the first frame is built from.
        guard case .signedIn(let opened) = app.phase else { return XCTFail("a valid stored session did not open the app: \(app.phase)") }
        XCTAssertEqual(opened.userId, user)
        XCTAssertEqual(app.shownPhase, app.phase)
        let koti = try XCTUnwrap(app.kotiPreview(), "Koti's first frame had no cached figures")
        XCTAssertEqual(koti.income, 120)
    }

    func testPastTheIdleLimitTheLaunchIsTheSignInScreenAndTheSessionEnds() async throws {
        let store = LaunchStore(stored())
        let app = try app(store, lastActive: Date().addingTimeInterval(-31 * 86_400))
        XCTAssertEqual(app.phase, .signedOut(notice: AppModel.expiredNotice))
        XCTAssertNil(app.kotiPreview())
        await app.start()
        XCTAssertEqual(app.phase, .signedOut(notice: AppModel.expiredNotice))
        XCTAssertNil(store.load(), "the idle session's token stayed on the device")
    }

    func testPastTheAbsoluteLimitTheLaunchIsTheSignInScreen() throws {
        let app = try app(LaunchStore(stored(startedAgo: 181)), lastActive: Date())
        XCTAssertEqual(app.phase, .signedOut(notice: AppModel.expiredNotice))
    }

    func testNoStoredSessionIsTheSignInScreenWithoutANotice() throws {
        let app = try app(LaunchStore(nil), lastActive: nil, kotiOnDisk: false)
        XCTAssertEqual(app.phase, .signedOut(notice: nil))
    }

    func testARefusalShowsTheSignInScreenOverTheTabsBeforeTheMainActorHandlesIt() throws {
        let app = try app(LaunchStore(stored()), lastActive: Date())
        app.refusal.set()
        XCTAssertEqual(app.shownPhase, .signedOut(notice: AppModel.expiredNotice))
        app.refusal.clear()
        XCTAssertEqual(app.shownPhase, app.phase)
    }

    func testUsageGapsAreBucketedForTheHistogram() {
        XCTAssertEqual(UsageGap.bucket(13 * 3_600), "12-24h")
        XCTAssertEqual(UsageGap.event(40 * 86_400, trigger: "foreground").name, ">30d")
    }

    private func dashboard() -> Data {
        let month = MonthKey.current()
        return Data("""
        {"firstName":"Liisa","month":"\(month)","income":120,"expenses":40,"source":"kuitit","basis":"laskutusperuste","txCount":0,
         "receiptCount":0,"invoiceCount":0,"matching":{"matchable":0,"matched":0,"suggested":0},"events":{"done":0,"total":0},
         "handled":null,"estimatedVat":0,"isRefund":false,"vat":{"registered":true,"entityType":"oy","ytdRevenue":0,"threshold":20000},
         "hasImap":false,"pendingReceiptsCount":0,"bank":{"totalBalance":0,"accountCount":0,"needsAttention":0,"state":"none",
         "hasBalance":false,"reconnectBank":null},"bankTrend":null,"cashflow":[{"month":"\(month)","income":120,"expenses":40,"source":"kuitit"}],"receivables":{"totalOpen":0,"overdue":0,"overdueCount":0},
         "payables":{"totalOpen":0,"overdue":0,"overdueCount":0},"items":[],"itemTotals":{"pending_receipt":0,"vat_gap":0,"missing_receipt":0,"invoice_match":0,"receipt_match":0,"payment_duplicate":0,"draft_invoice":0,"overdue_invoice":0},"blockingTotal":0,"previousMonth":null,
         "setup":{"receipts":false,"bank":false,"seller":false,"empty":true},"isSingleVatProfile":true,"singleVatRate":25.5}
        """.utf8)
    }
}
