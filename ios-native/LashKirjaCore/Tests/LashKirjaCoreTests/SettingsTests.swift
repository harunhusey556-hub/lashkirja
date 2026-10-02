import Testing
import Foundation
@testable import LashKirjaCore

@Test func pinRules() {
    #expect(AppLockPolicy.acceptable("1234"))
    #expect(AppLockPolicy.acceptable("12345678"))
    #expect(!AppLockPolicy.acceptable("123"))
    #expect(!AppLockPolicy.acceptable("123456789"))
    #expect(!AppLockPolicy.acceptable("12a4"))
}

@Test func pinBackoff() {
    #expect(AppLockPolicy.delay(afterFailures: 0) == 0)
    #expect(AppLockPolicy.delay(afterFailures: 1) == 1)
    #expect(AppLockPolicy.delay(afterFailures: 3) == 4)
    #expect(AppLockPolicy.delay(afterFailures: 5) == 16)
    #expect(AppLockPolicy.delay(afterFailures: 6) == 30)
    #expect(AppLockPolicy.delay(afterFailures: 40) == 30)
}

@Test func profilePatchSendsOnlyChanges() throws {
    let base = Profile(firstName: "Liisa", lastName: "Demo", email: "a@b.fi", entityType: "oy", vatRegistered: true, vatPeriod: "month")
    var edited = base
    edited.businessName = "  Lash Studio  "
    edited.vatPeriod = "quarter"
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ProfilePatch(from: base, to: edited))) as! [String: Any]
    #expect(Set(json.keys) == ["businessName", "vatPeriod"])
    #expect(json["businessName"] as? String == "Lash Studio")
    var cleared = edited
    cleared.businessName = ""
    let json2 = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ProfilePatch(from: edited, to: cleared))) as! [String: Any]
    #expect(json2["businessName"] is NSNull)
}

@Test func decodesRealSessions() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/sessions.json"))
    let list = try JSONDecoder().decode(DeviceSessions.self, from: data)
    #expect(list.sessions.first?.current == true)
    #expect(list.sessions.first?.label == "iPhone · LashKirja-sovellus")
}
