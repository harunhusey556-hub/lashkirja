import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

private let apiHeader = ["x-lashkirja-api-version": "1"]
private let base = URL(string: "https://example.test")!
private struct Thing: Decodable {}

// C2: a 401 that is not "your session is gone" (wrong current password) must not sign out.
@Test func wrongPasswordDoesNotSignOut() async {
    let t = FakeTransport([HTTPResponse(status: 401, headers: apiHeader, body: Data(#"{"error":"Nykyinen salasana on väärä."}"#.utf8))])
    let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: "T"), sleep: { _ in })
    let flag = Flag()
    await c.setOnUnauthorized { await flag.set() }
    await #expect(throws: LKError.self) { let _: Thing = try await c.send("POST", "/api/auth/password", body: EmptyBody()) }
    #expect(await flag.value == false)
}

@Test func sessionGoneStillSignsOut() async {
    for body in [#"{"error":"Ei kirjautunut"}"#, #"{"error":{"code":"UNAUTHORIZED","message":"Kirjaudu sisään"}}"#, #"{"error":"Unauthorized"}"#, ""] {
        let t = FakeTransport([HTTPResponse(status: 401, headers: apiHeader, body: Data(body.utf8))])
        let c = APIClient(baseURL: base, transport: t, tokens: FixedToken(value: "T"), sleep: { _ in })
        let flag = Flag()
        await c.setOnUnauthorized { await flag.set() }
        await #expect(throws: LKError.self) { let _: Thing = try await c.get("/x") }
        #expect(await flag.value, "body: \(body)")
    }
}

// I6: a 409 with an object `details` keeps the server's message.
@Test func objectDetailsKeepMessage() {
    let e = APIErrorDecoder.decode(status: 409, data: Data(#"{"error":{"code":"CONFLICT","message":"Sama kuitti on jo tallennettu.","details":{"isDuplicate":true,"receiptId":"r1"}}}"#.utf8))
    #expect(e.message == "Sama kuitti on jo tallennettu.")
    #expect(e.isDuplicate)
    let other = APIErrorDecoder.decode(status: 409, data: Data(#"{"error":{"code":"CONFLICT","message":"Tiedosto on jo käytetty."}}"#.utf8))
    #expect(!other.isDuplicate)
}

// C1: editing a draft sends expectedUpdatedAt and a dueDate, not paymentTermDays.
@Test func invoicePatchBody() throws {
    var draft = InvoiceDraft(customerId: "c1", issueDate: "2026-10-02", paymentTermDays: 14)
    draft.lines = [InvoiceDraft.Line(description: "Huolto", quantity: 1, unit: "kpl", unitPrice: 10, vatRate: 24)]
    let patch = InvoicePatch(draft: draft, expectedUpdatedAt: "2026-10-02T14:36:47.946Z")
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as! [String: Any]
    #expect(json["expectedUpdatedAt"] as? String == "2026-10-02T14:36:47.946Z")
    #expect(json["dueDate"] as? String == "2026-10-16")
    #expect(json["paymentTermDays"] == nil)
    #expect(json["notes"] is NSNull)
}

// I4: a PATCH clears emptied customer fields with null; a POST leaves them out.
@Test func customerPatchClearsFields() throws {
    var draft = CustomerDraft()
    draft.name = "Testi Oy"
    draft.email = ""
    let post = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
    #expect(post["email"] == nil)
    draft.clearsEmptyFields = true
    let patch = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as! [String: Any]
    #expect(patch["email"] is NSNull)
    #expect(patch["name"] as? String == "Testi Oy")
}

// I5: VAT periods follow the owner's filing period.
@Test func vatPeriods() {
    #expect(VatPeriod.key(for: "2026-10", kind: "month") == "2026-10")
    #expect(VatPeriod.key(for: "2026-10", kind: "quarter") == "2026-Q4")
    #expect(VatPeriod.key(for: "2026-10", kind: "year") == "2026")
    #expect(VatPeriod.previous("2026-10", kind: "month") == "2026-09")
    #expect(VatPeriod.previous("2026-10", kind: "quarter") == "2026-Q3")
    #expect(VatPeriod.previous("2026-02", kind: "quarter") == "2025-Q4")
    #expect(VatPeriod.previous("2026-10", kind: "year") == "2025")
    #expect(VatPeriod.shift("2026-Q1", by: -1) == "2025-Q4")
    #expect(VatPeriod.shift("2025", by: 1) == "2026")
    #expect(VatPeriod.shift("2026-12", by: 1) == "2027-01")
    #expect(VatPeriod.title("2026-Q3") == "Q3 2026")
}

// M1: per-account balance is `currentBalance` on the server.
@Test func bankAccountBalance() throws {
    let a = try JSONDecoder().decode(BankAccount.self, from: Data(#"{"id":"a","name":"Käyttötili","bankName":null,"iban":"FI00","currency":"EUR","currentBalance":403.13,"archivedAt":null}"#.utf8))
    #expect(a.balance == Decimal(string: "403.13"))
}

// M2: clearing a name is not sent as null (the server rejects null names).
@Test func profilePatchKeepsNamesNonNull() throws {
    let base = Profile(firstName: "Liisa", lastName: "Demo", email: "a@b.fi", entityType: "oy", vatRegistered: true, vatPeriod: "month")
    var edited = base
    edited.firstName = ""
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ProfilePatch(from: base, to: edited))) as! [String: Any]
    #expect(json["firstName"] == nil)
}

// I3: a 200 batch-approve with failures is reported.
@Test func batchApproveFailures() throws {
    let r = try JSONDecoder().decode(BatchApproveResult.self, from: Data(#"{"succeeded":0,"failed":[{"id":"r1","error":"Kuitilta puuttuu summa."}]}"#.utf8))
    #expect(r.firstError == "Kuitilta puuttuu summa.")
    let ok = try JSONDecoder().decode(BatchApproveResult.self, from: Data(#"{"succeeded":2,"failed":[]}"#.utf8))
    #expect(ok.firstError == nil)
}
