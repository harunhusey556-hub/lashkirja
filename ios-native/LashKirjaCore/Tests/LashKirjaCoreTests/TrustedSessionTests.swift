import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

// w67 (row 27, owner): a session stored on this device opens the app with no round trip first,
// within its idle (30 d) and absolute (180 d) limits; a sign-in binds the session to the device's
// key and every refresh is signed with it; launch and foreground gaps feed an anonymous histogram.

private let now = Date(timeIntervalSince1970: 1_790_000_000)
private let day: TimeInterval = 86_400
private func token(expiresIn: TimeInterval = 20 * day, startedAgo: TimeInterval? = 10 * day) -> StoredToken {
    StoredToken(token: "T1", expiresAt: now.addingTimeInterval(expiresIn), issuedAt: now.addingTimeInterval(-day), userId: "u1",
                sessionStartedAt: startedAgo.map { now.addingTimeInterval(-$0) })
}

@Test func aValidStoredSessionOpensWithoutAskingTheServer() {
    #expect(TrustedSession.decide(token(), lastActive: now.addingTimeInterval(-2 * day), now: now) == .open)
    // Never recorded (a token stored before w67): the server's own limits still apply.
    #expect(TrustedSession.decide(token(startedAgo: nil), lastActive: nil, now: now) == .open)
}

@Test func noStoredSessionIsTheSignInScreenWithoutANotice() {
    #expect(TrustedSession.decide(nil, lastActive: now, now: now) == .signIn(expired: false))
}

@Test func pastTheIdleLimitIsTheSignInScreen() {
    #expect(TrustedSession.decide(token(), lastActive: now.addingTimeInterval(-29 * day), now: now) == .open)
    #expect(TrustedSession.decide(token(), lastActive: now.addingTimeInterval(-31 * day), now: now) == .signIn(expired: true))
}

@Test func pastTheAbsoluteLimitIsTheSignInScreenHoweverOftenUsed() {
    #expect(TrustedSession.decide(token(startedAgo: 179 * day), lastActive: now, now: now) == .open)
    #expect(TrustedSession.decide(token(startedAgo: 181 * day), lastActive: now, now: now) == .signIn(expired: true))
}

@Test func anExpiredTokenIsTheSignInScreen() {
    #expect(TrustedSession.decide(token(expiresIn: -1), lastActive: now, now: now) == .signIn(expired: true))
}

@Test func storedTokensFromBeforeW67StillDecode() throws {
    let old = Data(#"{"token":"T","expiresAt":2000000000,"issuedAt":1000000000,"userId":"u"}"#.utf8)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
    let stored = try decoder.decode(StoredToken.self, from: old)
    #expect(stored.sessionStartedAt == nil)
    #expect(stored.userId == "u")
}

@Test func usageGapsFallIntoTheHistogramsBuckets() {
    let hour: TimeInterval = 3_600
    #expect(UsageGap.bucket(59 * 60) == "<1h")
    #expect(UsageGap.bucket(hour) == "1-12h")
    #expect(UsageGap.bucket(12 * hour) == "12-24h")
    #expect(UsageGap.bucket(day) == "1-3d")
    #expect(UsageGap.bucket(3 * day) == "3-7d")
    #expect(UsageGap.bucket(7 * day) == "7-30d")
    #expect(UsageGap.bucket(30 * day) == "7-30d")
    #expect(UsageGap.bucket(31 * day) == ">30d")
    let event = UsageGap.event(2 * hour, trigger: "launch")
    #expect(event.kind == "usage_gap")
    #expect(event.name == "1-12h")
    #expect(event.screen == "launch")
    #expect(Set(UsageGap.buckets).count == 7)
}

// MARK: Device-bound sign-in and refresh

private actor FakeSigner: DeviceKeySigner {
    private(set) var signed: [String] = []
    private(set) var removed = 0
    private var key: String? = "PUBKEY"
    func newPublicKey() -> String? { key = "PUBKEY"; return key }
    func refreshHeaders(token: String, now: Date) -> [String: String] {
        guard key != nil else { return [:] }
        signed.append(token)
        return ["X-LK-Device-Time": String(Int(now.timeIntervalSince1970)), "X-LK-Device-Signature": "SIG-\(token)"]
    }
    func remove() { key = nil; removed += 1 }
}

private let apiHeader = ["x-lashkirja-api-version": "1"]
private func json(_ s: String, _ status: Int = 200) -> HTTPResponse { HTTPResponse(status: status, headers: apiHeader, body: Data(s.utf8)) }
private func tokenBody(_ token: String) -> String {
    #"{"token":"\#(token)","tokenType":"Bearer","expiresAt":"2026-11-01T00:00:00.000Z","user":{"userId":"u1","email":"a@b.fi","firstName":"Harun"}}"#
}

private func make(_ responses: [HTTPResponse], signer: FakeSigner) async -> (AuthService, InMemoryTokenStore, FakeTransport) {
    let store = InMemoryTokenStore()
    let transport = FakeTransport(responses)
    let auth = AuthService(store: store, signer: signer, now: { now })
    let client = APIClient(baseURL: URL(string: "https://example.test")!, transport: transport, tokens: auth, sleep: { _ in })
    await auth.bind(client)
    return (auth, store, transport)
}

@Test func signInSendsTheDevicesPublicKeyAndStartsTheAbsoluteClock() async throws {
    let signer = FakeSigner()
    let (auth, store, transport) = await make([json(tokenBody("T1"))], signer: signer)
    _ = try await auth.login(email: "a@b.fi", password: "pw")
    let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: String]
    #expect(body["deviceKey"] == "PUBKEY")
    #expect(await store.load()?.sessionStartedAt == now)
}

@Test func refreshIsSignedForTheTokenItCarriesAndKeepsTheSessionStart() async throws {
    let signer = FakeSigner()
    let (auth, store, transport) = await make([json(tokenBody("T2"))], signer: signer)
    _ = await signer.newPublicKey()
    let started = now.addingTimeInterval(-40 * day)
    await store.save(StoredToken(token: "T1", expiresAt: now.addingTimeInterval(20 * day), issuedAt: now.addingTimeInterval(-8 * day),
                                 userId: "u1", sessionStartedAt: started))
    await auth.refreshIfDue()
    let request = try #require(transport.requests.first)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer T1")
    #expect(request.value(forHTTPHeaderField: "X-LK-Device-Signature") == "SIG-T1")
    #expect(request.value(forHTTPHeaderField: "X-LK-Device-Time") == String(Int(now.timeIntervalSince1970)))
    #expect(await signer.signed == ["T1"])
    let renewed = await store.load()
    #expect(renewed?.token == "T2")
    // The absolute limit counts from the sign-in, not from the refresh.
    #expect(renewed?.sessionStartedAt == started)
}

@Test func aLegacySessionRefreshesUnsigned() async throws {
    let signer = FakeSigner()
    await signer.remove()
    let (auth, store, transport) = await make([json(tokenBody("T2"))], signer: signer)
    await store.save(StoredToken(token: "T1", expiresAt: now.addingTimeInterval(20 * day), issuedAt: now.addingTimeInterval(-8 * day), userId: "u1"))
    await auth.refreshIfDue()
    let request = try #require(transport.requests.first)
    #expect(request.value(forHTTPHeaderField: "X-LK-Device-Signature") == nil)
    #expect(await store.load()?.token == "T2")
}

@Test func signingOutRemovesTheDeviceKey() async {
    let signer = FakeSigner()
    let (auth, store, _) = await make([], signer: signer)
    await store.save(StoredToken(token: "T1", expiresAt: now.addingTimeInterval(day), issuedAt: now, userId: "u1"))
    await auth.endSession()
    #expect(await signer.removed == 1)
}

@Test func aRefusedSignedRefreshSignsOut() async {
    let signer = FakeSigner()
    let (auth, store, _) = await make([json(#"{"error":{"code":"UNAUTHORIZED","message":"Kirjautuminen vaaditaan","reason":"device"}}"#, 401)], signer: signer)
    _ = await signer.newPublicKey()
    await store.save(StoredToken(token: "T1", expiresAt: now.addingTimeInterval(20 * day), issuedAt: now.addingTimeInterval(-8 * day), userId: "u1"))
    await auth.refreshIfDue()
    #expect(await store.load() == nil)
}
