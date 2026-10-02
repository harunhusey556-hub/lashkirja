import Testing
import Foundation
@testable import LashKirjaCore

private func json(_ value: some Encodable) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
}

// MARK: Password reset

@Test func resetTokenFromTheMailLink() {
    let token = "abcdefghijklmnopqrstuvwx_-12"
    #expect(PasswordReset.token(from: "https://lk.example.fi/palauta-salasana?token=\(token)") == token)
    #expect(PasswordReset.token(from: "  lashkirja://palauta-salasana?token=\(token)\n") == token)
    // The link percent-encodes the token.
    #expect(PasswordReset.token(from: "https://x.fi/palauta-salasana?a=1&token=abc%2Ddefghijklmnopqrstuvwxyz") == "abc-defghijklmnopqrstuvwxyz")
}

@Test func resetTokenPastedAsTheCodeAlone() {
    #expect(PasswordReset.token(from: " abcdefghijklmnopqrstuvwxyz ") == "abcdefghijklmnopqrstuvwxyz")
}

@Test func resetTokenRefusesWhatIsNotOne() {
    #expect(PasswordReset.token(from: "") == nil)
    #expect(PasswordReset.token(from: "short") == nil)
    #expect(PasswordReset.token(from: "https://x.fi/palauta-salasana") == nil)
    #expect(PasswordReset.token(from: "https://x.fi/palauta-salasana?token=short") == nil)
    #expect(PasswordReset.token(from: String(repeating: "a", count: 201)) == nil)
    #expect(PasswordReset.token(from: "has a space inside it here ok") == nil)
}

@Test func newPasswordChecksMatchTheWebForm() {
    #expect(PasswordReset.validate(password: "1234567", repeat: "1234567").password == "Salasanassa on oltava vähintään 8 merkkiä.")
    #expect(PasswordReset.validate(password: "12345678", repeat: "12345679").repeat == "Salasanat eivät täsmää.")
    let ok = PasswordReset.validate(password: "12345678", repeat: "12345678")
    #expect(ok.password == nil && ok.repeat == nil && ok.isValid)
}

@Test func forgotAnswerFallsBackToTheServerCopy() throws {
    let sent = try JSONDecoder().decode(ForgotPasswordResponse.self, from: Data(#"{"ok":true,"mailConfigured":true,"message":"Jos osoitteella löytyy tili, palautuslinkki on matkalla."}"#.utf8))
    #expect(sent.mailSent)
    #expect(sent.text == "Jos osoitteella löytyy tili, palautuslinkki on matkalla.")
    let bare = try JSONDecoder().decode(ForgotPasswordResponse.self, from: Data(#"{"ok":true,"mailConfigured":false}"#.utf8))
    #expect(!bare.mailSent)
    #expect(bare.text.hasPrefix("Palautuslinkkiä ei voida lähettää"))
}

@Test func forgotAndResetBodies() throws {
    #expect(try json(ForgotPasswordBody(email: "  Maija@Example.FI ")) as NSDictionary == ["email": "Maija@Example.FI"] as NSDictionary)
    #expect(try json(ResetPasswordBody(token: "t", password: "p")) as NSDictionary == ["token": "t", "password": "p"] as NSDictionary)
}

// MARK: Privacy requests

@Test func accountRequestsDecode() throws {
    let body = #"{"requests":[{"id":"r1","kind":"export","status":"completed","note":null,"packagePath":"x.zip","createdAt":"2026-09-01T10:00:00.000Z","updatedAt":"2026-09-02T10:00:00.000Z","resolvedAt":null,"statusLabel":"Valmis","kindLabel":"Tietojen kopio","downloadable":true},{"id":"r2","kind":"close","status":"pending","createdAt":"2026-09-03T10:00:00.000Z","statusLabel":"Odottaa","kindLabel":"Tilin sulkeminen","downloadable":false}]}"#
    let list = try JSONDecoder().decode(AccountRequestList.self, from: Data(body.utf8))
    #expect(list.requests.count == 2)
    #expect(list.requests[0].downloadable)
    #expect(!list.requests[0].isOpen)
    #expect(list.requests[1].isOpen)
    #expect(list.requests[1].kindLabel == "Tilin sulkeminen")
}

@Test func accountRequestBody() throws {
    #expect(try json(AccountRequestBody(kind: .close, currentPassword: "pw")) as NSDictionary == ["kind": "close", "currentPassword": "pw"] as NSDictionary)
    #expect(try json(AccountRequestBody(kind: .export, currentPassword: "pw"))["kind"] as? String == "export")
}

@Test func closeConfirmationNamesWhatHappens() {
    #expect(AccountCopy.closeConfirmation.hasPrefix("Pyyntö kirjataan tuelle."))
    #expect(AccountCopy.closeConfirmation.contains("säilyvät 6 vuotta"))
    #expect(AccountCopy.closeConfirmWord == "SULJE")
    #expect(AccountCopy.closeConfirmMatches(" sulje "))
    #expect(!AccountCopy.closeConfirmMatches("sulj"))
}

// MARK: Email change

@Test func emailChangeBodyTrims() throws {
    let body = try #require(EmailChangeBody(email: " uusi@example.fi ", currentPassword: "pw"))
    #expect(try json(body) as NSDictionary == ["email": "uusi@example.fi", "currentPassword": "pw"] as NSDictionary)
    #expect(EmailChangeBody(email: "  ", currentPassword: "pw") == nil)
}

@Test func emailProfileReadsThePendingAddress() throws {
    let p = try JSONDecoder().decode(AccountEmailProfile.Response.self, from: Data(#"{"profile":{"email":"a@b.fi","pendingEmail":"c@d.fi","entityType":"tmi"}}"#.utf8)).profile
    #expect(p.email == "a@b.fi")
    #expect(p.pendingEmail == "c@d.fi")
    let none = try JSONDecoder().decode(AccountEmailProfile.Response.self, from: Data(#"{"profile":{"email":"a@b.fi","pendingEmail":null}}"#.utf8)).profile
    #expect(none.pendingEmail == nil)
}

@Test func emailConfirmTokenComesFromTheLinkToo() {
    let token = "abcdefghijklmnopqrstuvwxyz"
    #expect(PasswordReset.token(from: "https://x.fi/vahvista-sahkoposti?token=\(token)") == token)
}

// MARK: Passkeys

@Test func passkeysDecode() throws {
    let list = try JSONDecoder().decode(PasskeyList.self, from: Data(#"{"passkeys":[{"id":"k1","deviceName":"iPhone","createdAt":"2026-09-01T10:00:00.000Z","lastUsedAt":null}]}"#.utf8))
    #expect(list.passkeys.first?.deviceName == "iPhone")
    #expect(list.passkeys.first?.detail == "Luotu 1.9.2026 · Ei vielä käytetty")
    let used = try JSONDecoder().decode(Passkey.self, from: Data(#"{"id":"k1","deviceName":"iPhone","createdAt":"2026-09-01T10:00:00.000Z","lastUsedAt":"2026-09-20T10:00:00.000Z"}"#.utf8))
    #expect(used.detail == "Luotu 1.9.2026 · Käytetty viimeksi 20.9.2026")
}

@Test func passkeyNameRules() {
    #expect(PasskeyName.validate("  ") == "Anna nimi.")
    #expect(PasskeyName.validate(String(repeating: "x", count: 61)) == "Enintään 60 merkkiä.")
    #expect(PasskeyName.validate(" iPad ") == nil)
}

@Test func passkeyFailureCopyMatchesTheWeb() {
    #expect(PasskeyFailure.cancelled.message(serverMessage: nil) == nil)
    #expect(PasskeyFailure.notConfigured.message(serverMessage: nil) == "Pääsyavaimet eivät ole vielä käytössä tällä palvelimella. Kirjaudu salasanalla.")
    #expect(PasskeyFailure.exists.message(serverMessage: nil) == "Tällä laitteella on jo pääsyavain tälle tilille.")
    #expect(PasskeyFailure.password.message(serverMessage: "Salasana ei täsmää.") == "Salasana ei täsmää.")
    #expect(PasskeyFailure.failed.message(serverMessage: nil) == "Pääsyavaimen luonti epäonnistui. Yritä uudelleen.")
    #expect(PasskeyFailure.from(status: 503) == .notConfigured)
    #expect(PasskeyFailure.from(status: 401) == .password)
    #expect(PasskeyFailure.from(status: 400) == .password)
    #expect(PasskeyFailure.from(status: 429) == .rate)
    #expect(PasskeyFailure.from(status: 409) == .failed)
}

@Test func base64URLRoundTrips() {
    let data = Data([0xfb, 0xff, 0xbf, 0x00, 0x01])
    let text = Base64URL.encode(data)
    #expect(!text.contains("+") && !text.contains("/") && !text.contains("="))
    #expect(Base64URL.decode(text) == data)
    #expect(Base64URL.decode("") == nil)
}

@Test func registrationOptionsDecode() throws {
    let body = #"{"challengeId":"c1","options":{"rp":{"name":"LashKirja","id":"lk.example.fi"},"user":{"id":"dXNlcg","name":"a@b.fi","displayName":"Maija"},"challenge":"Y2hhbGxlbmdl","pubKeyCredParams":[],"timeout":60000,"excludeCredentials":[{"id":"a2V5","type":"public-key"}],"authenticatorSelection":{"residentKey":"required"}}}"#
    let start = try JSONDecoder().decode(PasskeyRegistrationStart.self, from: Data(body.utf8))
    #expect(start.challengeId == "c1")
    #expect(start.rpId == "lk.example.fi")
    #expect(start.challenge == Data("challenge".utf8))
    #expect(start.userId == Data("user".utf8))
    #expect(start.userName == "a@b.fi")
    #expect(start.displayName == "Maija")
    #expect(start.excludedCredentialIds == [Data("key".utf8)])
}

@Test func registrationVerifyBodyHasTheWebAuthnShape() throws {
    let body = PasskeyRegistrationVerify(challengeId: "c1", credentialId: Data("key".utf8), clientDataJSON: Data("cd".utf8), attestationObject: Data("ao".utf8))
    let root = try json(body)
    #expect(root["challengeId"] as? String == "c1")
    #expect(root["device"] as? String == "ios-app")
    let response = try #require(root["response"] as? [String: Any])
    #expect(response["id"] as? String == "a2V5")
    #expect(response["rawId"] as? String == "a2V5")
    #expect(response["type"] as? String == "public-key")
    #expect(response["authenticatorAttachment"] as? String == "platform")
    #expect((response["clientExtensionResults"] as? [String: Any])?.isEmpty == true)
    let inner = try #require(response["response"] as? [String: Any])
    #expect(inner["clientDataJSON"] as? String == "Y2Q")
    #expect(inner["attestationObject"] as? String == "YW8")
    #expect(inner["transports"] as? [String] == ["hybrid", "internal"])
}

@Test func passkeyStatusDecodes() throws {
    let s = try JSONDecoder().decode(PasskeyStatus.self, from: Data(#"{"web":true,"native":false}"#.utf8))
    #expect(s.web && !s.native)
}
