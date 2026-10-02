import Foundation

/// The web's `lib/bank-consent-copy.ts` (plus the labels of BankConnectCard): what a bank consent that
/// can no longer sync says, and the bank errors as the owner may read them. The last success is
/// `lastSuccessAt` only, so a failed attempt never looks like a fetch.
public enum BankConsent {
    /// The bank itself withdrew the consent (the owner did not press Katkaise).
    public static let revokedMessage = "Pankki on peruuttanut luvan."
    public static let expiredConnectionMessage = "Yhteys vanhentui. Yhdistä uudelleen."
    /// The same sentence as older rows stored it, with a dash.
    static let oldExpiredConnectionMessage = "Yhteys vanhentui — yhdistä uudelleen."
    public static let rateLimitedMessage = "Pankki pyytää odottamaan. Yritä hetken päästä uudelleen."
    /// Any bank-side failure the owner cannot act on.
    public static let genericBankError = "Pankkiyhteys epäonnistui. Yritä uudelleen."
    /// Older rows stored text written for the server's operator; never shown.
    static let operatorText = ["ENABLEBANKING", "APP_ID", "Control Panel", "sovelluksen avain", "palvelimelta", "Forbidden", "Unauthorized"]
    /// Stored sync notices (something waits), told calmly instead of as a failure (web `isSyncNotice`).
    static let noticeStarts = ["Kuukausi on lukittu, joten", "Kaikkia tapahtumia ei saatu haettua kerralla.", "Pankki antoi tapahtumat vain viimeisen"]
    /// Not on the web, which only reacts once the consent has ended: the app warns this many days ahead.
    public static let expiryWarningDays = 14

    static let statusLabels = [
        "pending": "Odottaa vahvistusta",
        "authorizing": "Yhdistetään",
        "active": "Yhdistetty",
        "expired": "Vanhentunut",
        "revoked": "Katkaistu",
        "error": "Virhe",
    ]

    /// A stored bank error, as the owner may read it.
    public static func calmError(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        if trimmed == oldExpiredConnectionMessage { return expiredConnectionMessage }
        let operator_ = operatorText.contains { trimmed.range(of: $0, options: .caseInsensitive) != nil }
        return operator_ ? genericBankError : trimmed
    }

    public static func isSyncNotice(_ text: String?) -> Bool {
        guard let text else { return false }
        return noticeStarts.contains { text.hasPrefix($0) }
    }

    /// True for a connection the bank itself ended with a withdrawn consent.
    public static func withdrawn(_ connection: BankConnection) -> Bool {
        connection.lastError?.trimmingCharacters(in: .whitespacesAndNewlines) == revokedMessage
    }

    static func expired(_ connection: BankConnection, now: Date) -> Bool {
        guard let until = connection.validUntil.flatMap(APIDate.instant) else { return false }
        return until <= now
    }

    /// The "Vahvista uudelleen" card.
    public struct Reconnect: Equatable, Sendable {
        public let reason: String
        /// "Käyttötili · FI21 …": the in-scope accounts, or every account when none is.
        public let accounts: [String]
        public let withdrawn: Bool
        public let lastSuccessAt: String?
        public let lastAttemptAt: String?

        public var title: String { withdrawn ? "Pankki on peruuttanut luvan" : "Yhteys pitää vahvistaa uudelleen" }
        public var body: String { withdrawn ? "Vahvista yhteys uudelleen, niin tapahtumat haetaan taas." : "Syy: \(reason)" }
        public var accountsLine: String { "Tilit: \(accounts.isEmpty ? "ei tilejä" : accounts.joined(separator: ", "))" }
    }

    public static func reconnect(_ connection: BankConnection, now: Date = Date()) -> Reconnect? {
        let lapsed = expired(connection, now: now)
        let status = connection.status
        guard ["expired", "revoked", "error"].contains(status) || lapsed else { return nil }
        let reason = calmError(connection.lastError)
            ?? (status == "revoked" ? "Suostumus on katkaistu pankissa."
                : status == "error" && !lapsed ? "Yhteys epäonnistui."
                : "Suostumus on vanhentunut.")
        let all = connection.accounts ?? []
        let scoped = all.filter { $0.inScope == true }
        let listed = (scoped.isEmpty ? all : scoped).map { account -> String in
            let iban = account.iban ?? ""
            guard let label = account.name?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty else { return iban }
            return "\(label) · \(iban)"
        }
        return Reconnect(reason: reason, accounts: listed, withdrawn: withdrawn(connection),
                         lastSuccessAt: connection.lastSuccessAt, lastAttemptAt: connection.lastSyncAt)
    }

    /// "Synkronoi nyt" / "Päivitä" is offered only on a working consent.
    public static func canSync(_ connection: BankConnection, now: Date = Date()) -> Bool {
        connection.status == "active" && reconnect(connection, now: now) == nil
    }

    /// The connections a feed refresh can fetch: working, with at least one account in the books.
    public static func syncable(_ connections: [BankConnection], now: Date = Date()) -> [BankConnection] {
        connections.filter { canSync($0, now: now) && !BankScope.inScopeIDs($0).isEmpty }
    }

    /// "Yhdistetty · Yritystili", "Lupa peruttu · Henkilötili".
    public static func statusLabel(_ connection: BankConnection) -> String {
        let state = withdrawn(connection) ? "Lupa peruttu" : statusLabels[connection.status] ?? "Tuntematon tila"
        return "\(state) · \(connection.psuType == "business" ? "Yritystili" : "Henkilötili")"
    }

    public static func lastSuccessLine(_ connection: BankConnection) -> String {
        guard let at = connection.lastSuccessAt, APIDate.instant(at) != nil else { return "Viimeisin onnistunut haku: ei vielä" }
        return "Viimeisin onnistunut haku \(APIDate.timestamp(at))"
    }

    /// The stored error of a working consent, calm; a notice is not an alarm. Nil when a reconnect
    /// card already says what is wrong.
    public static func activeError(_ connection: BankConnection, now: Date = Date()) -> (text: String, isNotice: Bool)? {
        guard connection.status == "active", reconnect(connection, now: now) == nil,
              let text = calmError(connection.lastError) else { return nil }
        return (text, isSyncNotice(text))
    }

    public struct Validity: Equatable, Sendable {
        public let text: String
        /// Ends within `expiryWarningDays`.
        public let warning: Bool
    }

    /// "Lupa voimassa 1.12.2026 asti", or the warning a fortnight before. Nil without a date, on a
    /// consent that is not working, or one that has ended (its reconnect card says it).
    public static func validity(_ connection: BankConnection, now: Date = Date()) -> Validity? {
        guard connection.status == "active", reconnect(connection, now: now) == nil,
              let until = connection.validUntil.flatMap(APIDate.instant) else { return nil }
        let endDay = APIDate.dayString(until)
        let shown = APIDate.displayDay(endDay)
        let days = BankHistory.calendar.dateComponents([.day], from: APIDate.day(APIDate.dayString(now))!, to: APIDate.day(endDay)!).day ?? 0
        guard days <= expiryWarningDays else { return Validity(text: "Lupa voimassa \(shown) asti", warning: false) }
        let when = days <= 0 ? "tänään" : days == 1 ? "huomenna" : "\(days) päivän päästä"
        return Validity(text: "Lupa päättyy \(when) (\(shown))", warning: true)
    }
}
