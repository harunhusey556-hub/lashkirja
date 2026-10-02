import Testing
import Foundation
@testable import LashKirjaCore

private func at(_ iso: String) -> Date { APIDate.instant(iso)! }

private let accounts = [
    BankConnection.Account(id: "a1", name: "Käyttötili", iban: "FI21 1234 5600 0007 85", inScope: true),
    BankConnection.Account(id: "a2", name: "Muu", iban: "FI21 1234 5600 0007 86", inScope: false),
]

private func connection(status: String = "active", lastError: String? = nil, validUntil: String? = "2026-06-01T00:00:00.000Z",
                        lastSuccessAt: String? = "2026-03-01T10:00:00.000Z", lastSyncAt: String? = "2026-03-02T10:00:00.000Z",
                        psuType: String? = "business", accounts list: [BankConnection.Account]? = accounts) -> BankConnection {
    BankConnection(id: "c1", aspspName: "Nordea", status: status, accounts: list, validUntil: validUntil,
                   lastSyncAt: lastSyncAt, lastSuccessAt: lastSuccessAt, lastError: lastError, psuType: psuType)
}

@Test func consentDecodesLastSuccessAt() throws {
    let json = #"""
    {"id":"c1","aspspName":"Nordea","status":"active","validUntil":"2026-12-01T00:00:00.000Z",
     "lastSyncAt":"2026-10-02T08:00:00.000Z","lastSuccessAt":"2026-10-01T08:00:00.000Z","lastError":null,"accounts":[]}
    """#
    let c = try JSONDecoder().decode(BankConnection.self, from: Data(json.utf8))
    #expect(c.lastSuccessAt == "2026-10-01T08:00:00.000Z")
    #expect(c.validUntil == "2026-12-01T00:00:00.000Z")
}

@Test func consentStaysQuietWhileUsable() {
    #expect(BankConsent.reconnect(connection(), now: at("2026-04-01T00:00:00Z")) == nil)
    #expect(BankConsent.canSync(connection(), now: at("2026-04-01T00:00:00Z")))
}

@Test func consentReconnectNamesReasonInScopeAccountsAndLastSuccess() throws {
    let c = connection(status: "expired", lastError: "Yhteys vanhentui. Yhdistä uudelleen.",
                       lastSuccessAt: "2026-01-15T08:00:00.000Z", lastSyncAt: "2026-04-01T08:00:00.000Z")
    let copy = try #require(BankConsent.reconnect(c, now: at("2026-04-02T00:00:00Z")))
    #expect(copy.reason == "Yhteys vanhentui. Yhdistä uudelleen.")
    #expect(copy.accounts == ["Käyttötili · FI21 1234 5600 0007 85"])
    #expect(copy.title == "Yhteys pitää vahvistaa uudelleen")
    #expect(copy.body == "Syy: Yhteys vanhentui. Yhdistä uudelleen.")
    #expect(copy.accountsLine == "Tilit: Käyttötili · FI21 1234 5600 0007 85")
    #expect(!BankConsent.canSync(c, now: at("2026-04-02T00:00:00Z")))
}

@Test func consentReconnectListsEveryAccountWhenNoneInScope() throws {
    let list = [BankConnection.Account(id: "a1", name: " ", iban: "FI11", inScope: false),
                BankConnection.Account(id: "a2", name: "Säästö", iban: "FI22", inScope: false)]
    let copy = try #require(BankConsent.reconnect(connection(status: "expired", accounts: list)))
    #expect(copy.accounts == ["FI11", "Säästö · FI22"])
    let empty = try #require(BankConsent.reconnect(connection(status: "expired", accounts: [])))
    #expect(empty.accountsLine == "Tilit: ei tilejä")
}

@Test func consentFailedAttemptIsNotASuccess() throws {
    let copy = try #require(BankConsent.reconnect(connection(status: "error", lastSuccessAt: nil), now: at("2026-04-01T00:00:00Z")))
    #expect(copy.reason == "Yhteys epäonnistui.")
    #expect(BankConsent.lastSuccessLine(connection(status: "error", lastSuccessAt: nil)) == "Viimeisin onnistunut haku: ei vielä")
}

@Test func consentReasonFallbacks() throws {
    #expect(BankConsent.reconnect(connection(status: "revoked"))?.reason == "Suostumus on katkaistu pankissa.")
    #expect(BankConsent.reconnect(connection(status: "expired"))?.reason == "Suostumus on vanhentunut.")
    // validUntil passed while the status still says active.
    let lapsed = try #require(BankConsent.reconnect(connection(), now: at("2026-07-01T00:00:00Z")))
    #expect(lapsed.reason == "Suostumus on vanhentunut.")
    // An error status whose validUntil passed reads as expired, as on the web.
    #expect(BankConsent.reconnect(connection(status: "error"), now: at("2026-07-01T00:00:00Z"))?.reason == "Suostumus on vanhentunut.")
}

@Test func consentWithdrawnByBank() throws {
    let c = connection(status: "expired", lastError: "Pankki on peruuttanut luvan.")
    #expect(BankConsent.withdrawn(c))
    let copy = try #require(BankConsent.reconnect(c, now: at("2026-04-01T00:00:00Z")))
    #expect(copy.reason == "Pankki on peruuttanut luvan.")
    #expect(copy.title == "Pankki on peruuttanut luvan")
    #expect(copy.body == "Vahvista yhteys uudelleen, niin tapahtumat haetaan taas.")
    #expect(BankConsent.statusLabel(c) == "Lupa peruttu · Yritystili")
    #expect(!BankConsent.withdrawn(connection(lastError: "Yhteys vanhentui. Yhdistä uudelleen.")))
}

@Test func consentNeverShowsOperatorText() {
    for stored in [
        "Ohjausosoite ei ole sallittu Enable Bankingissa. Tarkista ENABLEBANKING_REDIRECT_URL Control Panelissa.",
        "Pankkiyhteyden tunnistautuminen epäonnistui. Tarkista sovelluksen avain ja APP_ID.",
        "Forbidden",
        "unauthorized",
    ] {
        #expect(BankConsent.calmError(stored) == "Pankkiyhteys epäonnistui. Yritä uudelleen.")
    }
    #expect(BankConsent.calmError("Pankki ei sallinut yhteyttä.") == "Pankki ei sallinut yhteyttä.")
    #expect(BankConsent.calmError("  ") == nil)
    #expect(BankConsent.calmError(nil) == nil)
    #expect(BankConsent.reconnect(connection(status: "error", lastError: "Tarkista sovelluksen avain ja APP_ID."))?.reason
            == "Pankkiyhteys epäonnistui. Yritä uudelleen.")
}

@Test func consentMapsOlderDashText() {
    #expect(BankConsent.calmError("Yhteys vanhentui — yhdistä uudelleen.") == "Yhteys vanhentui. Yhdistä uudelleen.")
}

@Test func consentStatusLabelAndLastSuccess() {
    #expect(BankConsent.statusLabel(connection()) == "Yhdistetty · Yritystili")
    #expect(BankConsent.statusLabel(connection(status: "pending", psuType: "personal")) == "Odottaa vahvistusta · Henkilötili")
    #expect(BankConsent.statusLabel(connection(status: "weird")) == "Tuntematon tila · Yritystili")
    #expect(BankConsent.lastSuccessLine(connection(lastSuccessAt: "2026-10-02T09:05:00.000Z"))
            == "Viimeisin onnistunut haku 2.10.2026 klo 12.05")
}

@Test func consentActiveErrorIsCalmAndNoticesAreNotAlarms() throws {
    let now = at("2026-04-01T00:00:00Z")
    #expect(BankConsent.activeError(connection(), now: now) == nil)
    let failed = try #require(BankConsent.activeError(connection(lastError: "Forbidden"), now: now))
    #expect(failed.text == "Pankkiyhteys epäonnistui. Yritä uudelleen.")
    #expect(!failed.isNotice)
    let note = try #require(BankConsent.activeError(connection(lastError: "Kaikkia tapahtumia ei saatu haettua kerralla. Haku jatkuu seuraavalla kerralla."), now: now))
    #expect(note.isNotice)
    // A connection that must be confirmed again says it in its card, not twice.
    #expect(BankConsent.activeError(connection(status: "expired", lastError: "Forbidden"), now: now) == nil)
}

@Test func consentValidityLineAndWarning() throws {
    let normal = try #require(BankConsent.validity(connection(validUntil: "2026-12-01T00:00:00.000Z"), now: at("2026-10-03T09:00:00Z")))
    #expect(normal.text == "Lupa voimassa 1.12.2026 asti")
    #expect(!normal.warning)
    // Helsinki day, not the UTC prefix.
    let lateUTC = try #require(BankConsent.validity(connection(validUntil: "2026-11-30T23:30:00.000Z"), now: at("2026-10-03T09:00:00Z")))
    #expect(lateUTC.text == "Lupa voimassa 1.12.2026 asti")
    let soon = try #require(BankConsent.validity(connection(validUntil: "2026-10-10T12:00:00.000Z"), now: at("2026-10-03T09:00:00Z")))
    #expect(soon.warning)
    #expect(soon.text == "Lupa päättyy 7 päivän päästä (10.10.2026)")
    let tomorrow = try #require(BankConsent.validity(connection(validUntil: "2026-10-04T12:00:00.000Z"), now: at("2026-10-03T09:00:00Z")))
    #expect(tomorrow.text == "Lupa päättyy huomenna (4.10.2026)")
    let today = try #require(BankConsent.validity(connection(validUntil: "2026-10-03T20:00:00.000Z"), now: at("2026-10-03T09:00:00Z")))
    #expect(today.text == "Lupa päättyy tänään (3.10.2026)")
    let edge = try #require(BankConsent.validity(connection(validUntil: "2026-10-17T12:00:00.000Z"), now: at("2026-10-03T09:00:00Z")))
    #expect(edge.warning)
    let past = try #require(BankConsent.validity(connection(validUntil: "2026-10-18T12:00:00.000Z"), now: at("2026-10-03T09:00:00Z")))
    #expect(!past.warning)
    // Nothing to say: no date, an ended consent (its card says it), or not active.
    #expect(BankConsent.validity(connection(validUntil: nil)) == nil)
    #expect(BankConsent.validity(connection(validUntil: "2026-10-01T00:00:00.000Z"), now: at("2026-10-03T09:00:00Z")) == nil)
    #expect(BankConsent.validity(connection(status: "pending", validUntil: "2026-12-01T00:00:00.000Z"), now: at("2026-10-03T09:00:00Z")) == nil)
}

@Test func consentFeedSyncableConnections() {
    let now = at("2026-04-01T00:00:00Z")
    let none = [BankConnection.Account(id: "x", name: nil, iban: "FI", inScope: false)]
    let list = [connection(), connection(status: "expired"), connection(accounts: none)]
    #expect(BankConsent.syncable(list, now: now).count == 1)
}
