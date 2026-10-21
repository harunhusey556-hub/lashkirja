import XCTest
import LashKirjaCore
@testable import LashKirja

/// Ultrareview #37 (row 27): the idle lock reads its trigger from `UsageClock`. While the lock is up
/// the launch, the trip to the background and the return must not move that clock on, or a
/// force-quit and relaunch (or iOS ending the backgrounded app) opens the app unlocked.
@MainActor
final class IdleLockTests: XCTestCase {
    private var directory: URL!
    private var savedDefaults: [String: Any?] = [:]
    private let keys = ["lock.idle", "lock.enabled", "usage.lastActiveAt"]

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("idle-lock-\(UUID().uuidString)")
        for key in keys { savedDefaults[key] = UserDefaults.standard.object(forKey: key) }
        UserDefaults.standard.set(true, forKey: "lock.idle")
        UserDefaults.standard.set(false, forKey: "lock.enabled")
        AppLock.shared.endIdleLock()
    }

    override func tearDown() {
        AppLock.shared.endIdleLock()
        for key in keys {
            if let value = savedDefaults[key] ?? nil { UserDefaults.standard.set(value, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
        try? FileManager.default.removeItem(at: directory)
    }

    private func launch(lastActive: Date) async -> AppModel {
        UsageClock.touch(lastActive)
        let tokens = InMemoryTokenStore()
        await tokens.save(StoredToken(token: "t", expiresAt: Date().addingTimeInterval(3600), issuedAt: Date(), userId: "idle-lock"))
        let app = AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: tokens,
                           resources: ResourceCache(store: ResourceDiskStore(directory: directory)),
                           signer: nil, lastActive: UsageClock.lastActive)
        // What LashKirjaApp.init does over the first frame.
        AppLock.shared.lockIfIdle(lastActive: app.launchLastActive)
        return app
    }

    private func relaunchWouldLock() -> Bool {
        guard let last = UsageClock.lastActive else { return false }
        return Date().timeIntervalSince(last) >= AppLock.idleLockAfter
    }

    func testTheLaunchAndTheBackgroundDoNotMoveTheClockWhileTheIdleLockIsUp() async {
        let away = Date().addingTimeInterval(-13 * 3_600)
        let app = await launch(lastActive: away)
        XCTAssertTrue(AppLock.shared.isLocked, "13 h unused with the idle lock on did not lock the launch")

        await app.start()
        XCTAssertEqual(UsageClock.lastActive?.timeIntervalSince1970 ?? 0, away.timeIntervalSince1970, accuracy: 0.001, "the launch moved the usage clock on behind the lock")
        app.background()
        XCTAssertEqual(UsageClock.lastActive?.timeIntervalSince1970 ?? 0, away.timeIntervalSince1970, accuracy: 0.001, "the trip to the background moved the usage clock on behind the lock")
        XCTAssertTrue(relaunchWouldLock(), "a force-quit and relaunch here would open the app unlocked")
    }

    func testTheReturnFromTheBackgroundDoesNotMoveTheClockWhileTheIdleLockIsUp() async {
        let away = Date().addingTimeInterval(-13 * 3_600)
        let app = await launch(lastActive: away)
        await app.start()
        app.background()
        await app.foreground()
        XCTAssertTrue(AppLock.shared.isLocked)
        XCTAssertEqual(UsageClock.lastActive?.timeIntervalSince1970 ?? 0, away.timeIntervalSince1970, accuracy: 0.001, "the return from the background moved the usage clock on behind the lock")
        XCTAssertTrue(relaunchWouldLock())
    }

    func testLiftingTheLockStartsTheClockAgain() async {
        let app = await launch(lastActive: Date().addingTimeInterval(-13 * 3_600))
        await app.start()
        // A sign-in proves the owner, like Face ID does.
        AppLock.shared.endIdleLock()
        XCTAssertFalse(AppLock.shared.isLocked)
        XCTAssertLessThan(Date().timeIntervalSince(UsageClock.lastActive ?? .distantPast), 5, "the unlock did not count as use")
        XCTAssertFalse(relaunchWouldLock())
    }

    /// X153: the Asetukset row reads the idle lock as well as the PIN. With no PIN it said
    /// 'Ei käytössä' while the app would lock after 12 hours unused.
    func testTheSettingsRowReadsTheIdleLock() {
        XCTAssertFalse(AppLock.shared.isEnabled, "a PIN lock is on in this run: the idle lock is not read alone")
        XCTAssertEqual(SettingsView.lockRowSubtitle(AppLock.shared), "Käytössä", "the idle lock alone is on")
        UserDefaults.standard.set(false, forKey: "lock.idle")
        XCTAssertEqual(SettingsView.lockRowSubtitle(AppLock.shared), "Ei käytössä", "neither lock is on")
    }

    func testAnUnlockedAppMovesTheClockOnAsBefore() async {
        let recent = Date().addingTimeInterval(-3_600)
        let app = await launch(lastActive: recent)
        XCTAssertFalse(AppLock.shared.isLocked)
        await app.start()
        let launched = UsageClock.lastActive ?? .distantPast
        XCTAssertGreaterThan(launched, recent.addingTimeInterval(3_000), "an unlocked launch did not count as use")
        app.background()
        XCTAssertGreaterThanOrEqual(UsageClock.lastActive ?? .distantPast, launched)
    }
}
