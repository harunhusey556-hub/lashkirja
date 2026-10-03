import SwiftUI
import UserNotifications
import BackgroundTasks
import LashKirjaCore

/// Local notifications ("Kuitti puuttuu", a late invoice, a VAT return due…). The app is signed
/// with a free Apple account, so there is no remote push: `GET /api/notifications` is read when
/// the app becomes active and when iOS grants a background refresh (BGAppRefreshTask), and each
/// id is shown once (`NotificationPlanner` decides what, `DeliveredIds` remembers what was shown).
/// iOS alone decides when a background refresh runs; the settings screen says so.
@MainActor
final class AppNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AppNotifications()
    /// Must match `BGTaskSchedulerPermittedIdentifiers` in project.yml.
    static let refreshTaskId = "fi.tiyouba.lashkirja.refresh"

    private enum Key {
        static let prefs = "notifications.prefs.v1"
        static let delivered = "notifications.delivered.v1"
        static let cursor = "notifications.cursor.v1"
        static let counts = "notifications.counts.v1"
        static let asked = "notifications.asked.v1"
        static let seen = "notifications.seen.v1"
    }

    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard
    private weak var app: AppModel?
    /// A tap that arrived before the app model did (the app was launched by it).
    private var pendingTap: NotificationTap?
    private var running = false

    /// Set once from the App's init, before launch finishes, so a tap that launched the app is
    /// not lost.
    func activate(app: AppModel) {
        self.app = app
        center.delegate = self
        let capture = UNNotificationAction(identifier: NotificationAction.capture, title: "Kuvaa kuitti", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: NotificationAction.missingReceiptCategory, actions: [capture], intentIdentifiers: []),
        ])
        if let tap = pendingTap {
            pendingTap = nil
            apply(tap)
        }
    }

    // MARK: Settings

    var prefs: NotificationPrefs {
        guard let data = defaults.data(forKey: Key.prefs),
              let prefs = try? JSONDecoder().decode(NotificationPrefs.self, from: data) else { return NotificationPrefs() }
        return prefs
    }

    /// Saved from "Ilmoitukset": the daily summary and the next background refresh follow at once.
    func update(_ prefs: NotificationPrefs) {
        if let data = try? JSONEncoder().encode(prefs) { defaults.set(data, forKey: Key.prefs) }
        Task { await scheduleDailySummary(counts: lastCounts) }
        scheduleBackgroundRefresh()
    }

    func permission() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    @discardableResult
    func requestPermission() async -> Bool {
        defaults.set(true, forKey: Key.asked)
        return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    /// "Lähetä testi-ilmoitus": a few seconds later, so it shows on the lock screen too.
    func sendTest() async -> Bool {
        let content = UNMutableNotificationContent()
        content.title = "Testi-ilmoitus"
        content.body = "Ilmoitukset toimivat. Näin LashKirja muistuttaa kuiteista ja laskuista."
        content.sound = .default
        let request = UNNotificationRequest(identifier: "lk.test", content: content,
                                            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false))
        return (try? await center.add(request)) != nil
    }

    // MARK: Fetching

    func appBecameActive() async {
        guard let app, case .signedIn = app.phase else { return }
        await refresh(app: app, inBackground: false)
    }

    /// The BGAppRefreshTask handler (`.backgroundTask(.appRefresh)` in LashKirjaApp).
    func backgroundRefresh() async {
        scheduleBackgroundRefresh()
        guard let app else { return }
        await refresh(app: app, inBackground: true)
    }

    /// Asks iOS for the next background refresh; the date is only the earliest it may run.
    func scheduleBackgroundRefresh() {
        let scheduler = BGTaskScheduler.shared
        guard prefs.enabled else {
            scheduler.cancel(taskRequestWithIdentifier: Self.refreshTaskId)
            return
        }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskId)
        request.earliestBeginDate = NotificationPlanner.nextRefresh(after: Date(), prefs: prefs, calendar: .current)
        // Refused in the simulator and when Background App Refresh is off: the app-active fetch remains.
        try? scheduler.submit(request)
    }

    private func refresh(app: AppModel, inBackground: Bool) async {
        guard !running else { return }
        running = true
        defer { running = false }
        let prefs = self.prefs
        guard prefs.enabled, let token = await app.auth.currentToken() else { return }
        let status = await permission()
        let authorized = status == .authorized || status == .provisional || status == .ephemeral
        let since = authorized ? defaults.string(forKey: Key.cursor) : nil
        let feed: NotificationFeed
        do { feed = try await app.api.get("/api/notifications", query: since.map { ["since": $0] } ?? [:]) }
        catch { return }
        // Signed out (perhaps in as someone else) while it loaded: nothing of that session is shown.
        guard await app.auth.currentToken() == token else { return }
        let firstRun = !defaults.bool(forKey: Key.seen)
        defaults.set(true, forKey: Key.seen)

        guard authorized else {
            let ask = NotificationPlanner.shouldAskPermission(
                undetermined: status == .notDetermined, askedBefore: defaults.bool(forKey: Key.asked),
                firstRun: firstRun, missingReceipts: feed.counts[NotificationKind.missingReceipt.rawValue] ?? 0)
            if ask && !inBackground && UIApplication.shared.applicationState == .active, await requestPermission() {
                // Allowed: show what is waiting now rather than at the next fetch.
                Task { await self.refresh(app: app, inBackground: false) }
            }
            return
        }

        let plan = NotificationPlanner.plan(feed.items, prefs: prefs, delivered: delivered, now: Date(), calendar: .current)
        for item in plan.outgoing {
            try? await center.add(UNNotificationRequest(identifier: item.id, content: content(for: item), trigger: nil))
        }
        delivered = delivered.adding(plan.markDelivered)
        // Quiet hours: the cursor stays, so what arrived meanwhile comes again in the morning.
        if !plan.hold, let cursor = feed.cursor { defaults.set(cursor, forKey: Key.cursor) }
        lastCounts = feed.counts
        await scheduleDailySummary(counts: feed.counts)
    }

    private func content(for item: OutgoingNotification) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = item.title
        content.body = item.body
        content.sound = .default
        content.threadIdentifier = item.threadId
        if let category = item.categoryId { content.categoryIdentifier = category }
        var info: [String: String] = ["kind": item.kind.rawValue]
        if let href = item.href { info["href"] = href }
        if let transactionId = item.transactionId { info["transactionId"] = transactionId }
        content.userInfo = info
        return content
    }

    /// One summary waiting at a time, with the counts of the latest fetch; nothing open, none.
    private func scheduleDailySummary(counts: [String: Int]) async {
        center.removePendingNotificationRequests(withIdentifiers: [NotificationAction.dailySummaryId])
        guard let text = NotificationPlanner.dailySummary(counts: counts, prefs: prefs) else { return }
        let fire = NotificationPlanner.nextDailySummary(after: Date(), prefs: prefs, calendar: .current)
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
        content.sound = .default
        content.threadIdentifier = "lk.daily"
        let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
        let request = UNNotificationRequest(identifier: NotificationAction.dailySummaryId, content: content,
                                            trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
        try? await center.add(request)
    }

    private var delivered: DeliveredIds {
        get {
            guard let data = defaults.data(forKey: Key.delivered),
                  let ids = try? JSONDecoder().decode(DeliveredIds.self, from: data) else { return DeliveredIds() }
            return ids
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) { defaults.set(data, forKey: Key.delivered) }
        }
    }

    private var lastCounts: [String: Int] {
        get { (defaults.dictionary(forKey: Key.counts) as? [String: Int]) ?? [:] }
        set { defaults.set(newValue, forKey: Key.counts) }
    }

    // MARK: Sign-out

    /// Nothing of this owner's stays: shown and waiting notifications, the shown ids, the cursor.
    /// The choices on "Ilmoitukset" belong to the phone and stay.
    func clearForSignOut() {
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
        for key in [Key.delivered, Key.cursor, Key.counts] { defaults.removeObject(forKey: key) }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshTaskId)
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let tap = NotificationTap.resolve(href: info["href"] as? String, transactionId: info["transactionId"] as? String,
                                          action: response.actionIdentifier)
        await MainActor.run { self.apply(tap) }
    }

    /// A tap opens its screen on Koti's stack (MainTabView reads `pendingRoute`); "Kuvaa kuitti"
    /// opens the camera for that bank row (`pendingCapture`).
    private func apply(_ tap: NotificationTap) {
        guard let app else {
            pendingTap = tap
            return
        }
        switch tap {
        case .route(let href):
            guard let route = Route.fromHref(href) else { return }
            app.pendingRoute = PendingRoute(tab: .koti, route: route)
        case .capture(let transactionId):
            app.pendingCapture = PendingCapture(transactionId: transactionId)
        case .none:
            break
        }
    }
}
