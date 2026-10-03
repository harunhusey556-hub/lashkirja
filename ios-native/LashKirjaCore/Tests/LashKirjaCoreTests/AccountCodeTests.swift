import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import LashKirjaCore

private let apiHeader = ["x-lashkirja-api-version": "1"]
private func reply(_ s: String, _ status: Int = 200) -> HTTPResponse { HTTPResponse(status: status, headers: apiHeader, body: Data(s.utf8)) }
private let tokenBody = #"{"token":"T1","tokenType":"Bearer","expiresAt":"2026-11-01T00:00:00.000Z","user":{"userId":"u1","email":"a@b.fi","firstName":"Harun"}}"#
private let fixedNow = Date(timeIntervalSince1970: 1_790_000_000)

private func make(_ responses: [HTTPResponse]) async -> (AuthService, InMemoryTokenStore, FakeTransport) {
    let store = InMemoryTokenStore()
    let transport = FakeTransport(responses)
    let auth = AuthService(store: store, now: { fixedNow })
    let client = APIClient(baseURL: URL(string: "https://example.test")!, transport: transport, tokens: auth, sleep: { _ in })
    await auth.bind(client)
    return (auth, store, transport)
}

private func object(_ value: some Encodable) throws -> [String: String] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: String]
}

private func sent(_ request: URLRequest) throws -> [String: String] {
    try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
}

// MARK: The code

@Test func codeFromTypedOrPastedText() {
    #expect(AccountCode.normalize("123456") == "123456")
    #expect(AccountCode.normalize(" 123 456 \n") == "123456")
    #expect(AccountCode.normalize("123-456") == "123456")
    #expect(AccountCode.normalize("123–456") == "123456")
    #expect(AccountCode.normalize("LashKirja-vahvistuskoodi: 123456") == "123456")
    #expect(AccountCode.normalize("lashkirja-vahvistuskoodi:123 456") == "123456")
    #expect(AccountCode.normalize("Re: LashKirja-vahvistuskoodi: 042 001") == "042001")
}

@Test func codeRejectsAnythingButSixDigits() {
    #expect(AccountCode.normalize("") == nil)
    #expect(AccountCode.normalize("12345") == nil)
    #expect(AccountCode.normalize("1234567") == nil)
    #expect(AccountCode.normalize("12a456") == nil)
    #expect(AccountCode.normalize("LashKirja-vahvistuskoodi:") == nil)
    #expect(AccountCode.normalize("１２３４５６") == nil)
    #expect(AccountCode.normalize("https://x.fi/palauta-salasana?token=abcdefghijklmnopqrstuvwx") == nil)
    // A reset link's token is never taken for a code, and a code never for a token.
    #expect(PasswordReset.token(from: "123456") == nil)
}

@Test func extractFindsTheCodeInWhatGmailCopies() {
    // The subjects (new and old) and the body sentences as they arrive.
    #expect(AccountCode.extract("123456 on LashKirja-vahvistuskoodisi") == "123456")
    #expect(AccountCode.extract("LashKirja-vahvistuskoodi: 123456") == "123456")
    #expect(AccountCode.extract("LashKirja-tilisi vahvistuskoodi on 123456. Koodi on voimassa 15 minuuttia.") == "123456")
    #expect(AccountCode.extract("042001\n\nTämä on LashKirja-tilisi vahvistuskoodi, ja se on voimassa 15 minuuttia.") == "042001")
    #expect(AccountCode.extract("Re: 654321 on LashKirja-vahvistuskoodisi") == "654321")
    #expect(AccountCode.extract("Re: LashKirja-vahvistuskoodi: 042 001") == "042001")
    #expect(AccountCode.extract("123 456") == "123456")
    #expect(AccountCode.extract("123-456") == "123456")
    #expect(AccountCode.extract("123–456") == "123456")
    #expect(AccountCode.extract("Koodi: 123456, voimassa 30 minuuttia") == "123456")
    #expect(AccountCode.extract("Koodi (123456)") == "123456")
    #expect(AccountCode.extract(" 123456 \n") == "123456")
}

@Test func extractRefusesWhatIsNotACode() {
    #expect(AccountCode.extract("") == nil)
    #expect(AccountCode.extract("Koodi on voimassa 15 minuuttia.") == nil)
    #expect(AccountCode.extract("1234567") == nil)
    #expect(AccountCode.extract("Tilaus 1234567 on vahvistettu") == nil)
    #expect(AccountCode.extract("12345") == nil)
    #expect(AccountCode.extract("040 123 4567") == nil)
    #expect(AccountCode.extract("12 3456") == nil)
    #expect(AccountCode.extract("123  456") == nil)
    #expect(AccountCode.extract("abc123456") == nil)
    #expect(AccountCode.extract("123456.78") == nil)
    #expect(AccountCode.extract("１２３４５６") == nil)
    #expect(AccountCode.extract("https://x.fi/palauta-salasana?token=123456") == nil)
    #expect(AccountCode.extract("https://x.fi/palauta-salasana?token=Ab-123456_xyzABCDEFGHIJ") == nil)
}

@Test func extractTakesTheFirstCodeAndSkipsLongerNumbers() {
    #expect(AccountCode.extract("Viite 1234567, koodi 222333 tai 444555") == "222333")
    #expect(AccountCode.extract("Avaa linkki: https://x.fi/palauta-salasana?token=abc123456def\n\n987654 on koodi") == "987654")
}

@Test func codeFieldKeepsTheCodeOrDigitsOnly() {
    // Typing one digit at a time, and the keyboard's one-time-code suggestion.
    #expect(AccountCode.input("1", previous: "") == "1")
    #expect(AccountCode.input("123456", previous: "12345") == "123456")
    #expect(AccountCode.input("123456", previous: "") == "123456")
    // A pasted subject or body line becomes just the code.
    #expect(AccountCode.input("123456 on LashKirja-vahvistuskoodisi", previous: "") == "123456")
    #expect(AccountCode.input("LashKirja-tilisi vahvistuskoodi on 123456. Koodi on voimassa 15 minuuttia.", previous: "") == "123456")
    // Pasted after digits already typed: the pasted code wins, not the first six digits.
    #expect(AccountCode.input("12345987654", previous: "12345") == "987654")
    #expect(AccountCode.input("12Koodi 987 654", previous: "12") == "987654")
    // No code: only the digits, at most six.
    #expect(AccountCode.input("12a", previous: "12") == "12")
    #expect(AccountCode.input("", previous: "123") == "")
    #expect(AccountCode.input("1234567", previous: "123456") == "123456")
    #expect(AccountCode.input("1234567", previous: "") == "")
    #expect(AccountCode.input("Koodi on voimassa 15 minuuttia.", previous: "") == "15")
    // Its own result is stable, so setting it again changes nothing.
    for kept in ["", "1", "12345", "123456"] { #expect(AccountCode.input(kept, previous: kept) == kept) }
}

@Test func emailCheckCatchesTyposBeforeSending() {
    #expect(EmailCheck.problem("nimi@yritys.fi") == nil)
    #expect(EmailCheck.problem(" Nimi.Suku+x@posti.yritys.fi \n") == nil)
    #expect(EmailCheck.problem("") == EmailCheck.missing)
    #expect(EmailCheck.problem("   ") == EmailCheck.missing)
    #expect(EmailCheck.problem("nimi") == EmailCheck.invalid)
    #expect(EmailCheck.problem("nimi@") == EmailCheck.invalid)
    #expect(EmailCheck.problem("@yritys.fi") == EmailCheck.invalid)
    #expect(EmailCheck.problem("nimi@yritys") == EmailCheck.invalid)
    #expect(EmailCheck.problem("nimi@yritys.") == EmailCheck.invalid)
    #expect(EmailCheck.problem("nimi@@yritys.fi") == EmailCheck.invalid)
    #expect(EmailCheck.problem("ni mi@yritys.fi") == EmailCheck.invalid)
}

// MARK: Request bodies (contract field names)

@Test func signUpBodiesUseTheContractFields() throws {
    #expect(try object(SignUpStartBody(email: " A@B.fi ", password: "salasana1", firstName: " Harun ")) == ["email": "a@b.fi", "password": "salasana1", "firstName": "Harun"])
    #expect(try object(SignUpVerifyBody(email: "A@b.fi", code: "123 456", password: "salasana1")) == ["email": "a@b.fi", "code": "123456", "password": "salasana1", "device": "ios-app"])
    #expect(try object(SignUpResendBody(email: " a@b.fi")) == ["email": "a@b.fi"])
    #expect(try object(ResetWithCodeBody(email: "A@B.fi", code: "LashKirja-vahvistuskoodi: 654321", password: "uusisalasana")) == ["email": "a@b.fi", "code": "654321", "password": "uusisalasana"])
}

@Test func signUpAnswersDecode() throws {
    let decoder = JSONDecoder()
    #expect(try decoder.decode(SignUpStatus.self, from: Data(#"{"enabled":true}"#.utf8)).enabled)
    #expect(try !decoder.decode(SignUpStatus.self, from: Data(#"{"enabled":false}"#.utf8)).enabled)
    // Fail closed: no flag, or a strange one, means no sign-up button.
    #expect(try !decoder.decode(SignUpStatus.self, from: Data("{}".utf8)).enabled)
    #expect(try !decoder.decode(SignUpStatus.self, from: Data(#"{"enabled":"yes"}"#.utf8)).enabled)
    #expect(try decoder.decode(SignUpStartResponse.self, from: Data(#"{"ok":true,"mailConfigured":true}"#.utf8)) == SignUpStartResponse(ok: true, mailConfigured: true))
}

// MARK: Errors

@Test func flatErrorKeepsCodeAndAttemptsLeft() {
    let wrong = APIErrorDecoder.decode(status: 400, data: Data(#"{"error":"Koodi ei kelpaa.","code":"SIGNUP_CODE_INVALID","attemptsLeft":3}"#.utf8))
    #expect(wrong == LKError(status: 400, code: "SIGNUP_CODE_INVALID", message: "Koodi ei kelpaa.", fields: ["attemptsLeft": "3"]))
    let taken = APIErrorDecoder.decode(status: 409, data: Data(#"{"code":"SIGNUP_EMAIL_TAKEN"}"#.utf8))
    #expect(taken.code == "SIGNUP_EMAIL_TAKEN")
    #expect(taken.message == LKError.unreachable)
    // An odd `code` type does not lose the sentence.
    let odd = APIErrorDecoder.decode(status: 400, data: Data(#"{"error":"Virhe","code":12}"#.utf8))
    #expect(odd == LKError(status: 400, message: "Virhe"))
    #expect(APIErrorDecoder.decode(status: 400, data: Data("{}".utf8)).message == LKError.unreachable)
}

@Test func contractErrorsMapToTheTypedFailure() {
    func failure(_ status: Int, _ body: String) -> AccountCodeFailure {
        AccountCodeFailure(APIErrorDecoder.decode(status: status, data: Data(body.utf8)))
    }
    #expect(failure(400, #"{"error":"Koodi ei kelpaa.","code":"SIGNUP_CODE_INVALID","attemptsLeft":2}"#) == .codeInvalid(attemptsLeft: 2))
    #expect(failure(400, #"{"error":"Koodi ei kelpaa tai se on vanhentunut.","code":"RESET_CODE_INVALID"}"#) == .resetCodeInvalid)
    #expect(failure(410, #"{"error":"Vanhentunut","code":"SIGNUP_EXPIRED"}"#) == .signUpExpired)
    #expect(failure(410, #"{"error":"Vanhentunut","code":"RESET_EXPIRED"}"#) == .resetExpired)
    #expect(failure(409, #"{"code":"SIGNUP_EMAIL_TAKEN"}"#) == .emailTaken)
    #expect(failure(403, #"{"error":"Uusien tilien luonti ei ole käytössä.","code":"SIGNUP_DISABLED"}"#) == .disabled)
    #expect(failure(429, #"{"error":"Liian monta yritystä."}"#) == .rateLimited)
    #expect(failure(503, #"{"error":"Tilin luonti ei ole juuri nyt käytössä."}"#) == .other)
    #expect(AccountCodeFailure(LKError(status: 0, code: "NETWORK", message: LKError.unreachable)) == .other)
}

@Test func failureMessagesAreFinnish() {
    #expect(AccountCodeFailure.codeInvalid(attemptsLeft: 3).message(serverMessage: "x") == "Koodi ei kelpaa. Yrityksiä jäljellä: 3.")
    #expect(AccountCodeFailure.codeInvalid(attemptsLeft: 1).message(serverMessage: nil) == "Koodi ei kelpaa. Yksi yritys jäljellä.")
    #expect(AccountCodeFailure.codeInvalid(attemptsLeft: nil).message(serverMessage: nil) == "Koodi ei kelpaa.")
    #expect(AccountCodeFailure.resetCodeInvalid.message(serverMessage: "x") == "Koodi ei kelpaa tai se on vanhentunut.")
    #expect(!AccountCodeFailure.resetCodeInvalid.startsOver)
    #expect(AccountCodeFailure.disabled.message(serverMessage: nil) == "Uusien tilien luonti ei ole käytössä.")
    #expect(AccountCodeFailure.rateLimited.message(serverMessage: "Odota hetki.") == "Odota hetki.")
    #expect(AccountCodeFailure.other.message(serverMessage: "Tilin luonti ei ole juuri nyt käytössä.") == "Tilin luonti ei ole juuri nyt käytössä.")
    #expect(AccountCodeFailure.signUpExpired.startsOver)
    #expect(AccountCodeFailure.emailTaken.startsOver)
    #expect(!AccountCodeFailure.codeInvalid(attemptsLeft: 2).startsOver)
}

// MARK: AuthService

@Test func signupStatusReadsTheFlag() async throws {
    let (auth, _, transport) = await make([reply(#"{"enabled":true}"#)])
    #expect(try await auth.signupStatus().enabled)
    #expect(transport.requests[0].httpMethod == "GET")
    #expect(transport.requests[0].url?.path == "/api/auth/signup/status")
}

@Test func signupStartSendsTheForm() async throws {
    let (auth, store, transport) = await make([reply(#"{"ok":true,"mailConfigured":true}"#)])
    let answer = try await auth.signupStart(email: " A@B.fi ", password: "salasana1", firstName: "Harun")
    #expect(answer.mailConfigured == true)
    #expect(transport.requests[0].url?.path == "/api/auth/signup/start")
    #expect(try sent(transport.requests[0]) == ["email": "a@b.fi", "password": "salasana1", "firstName": "Harun"])
    #expect(await store.load() == nil)
}

@Test func signupVerifySignsInLikeLogin() async throws {
    let (auth, store, transport) = await make([reply(tokenBody)])
    let user = try await auth.signupVerify(email: "a@b.fi", code: "123 456", password: "salasana1")
    #expect(user == AuthUser(userId: "u1", email: "a@b.fi", firstName: "Harun"))
    #expect(transport.requests[0].url?.path == "/api/auth/signup/verify")
    #expect(try sent(transport.requests[0]) == ["email": "a@b.fi", "code": "123456", "password": "salasana1", "device": "ios-app"])
    #expect(await store.load()?.token == "T1")
    #expect(await auth.currentToken() == "T1")
}

@Test func signupVerifyWrongCodeKeepsNoSession() async throws {
    let (auth, store, _) = await make([reply(#"{"error":"Koodi ei kelpaa.","code":"SIGNUP_CODE_INVALID","attemptsLeft":4}"#, 400)])
    do {
        _ = try await auth.signupVerify(email: "a@b.fi", code: "000000", password: "salasana1")
        Issue.record("a wrong code must throw")
    } catch let error as LKError {
        #expect(AccountCodeFailure(error) == .codeInvalid(attemptsLeft: 4))
    }
    #expect(await store.load() == nil)
    #expect(await auth.currentToken() == nil)
}

@Test func signupResendAndResetWithCodePostTheContractBodies() async throws {
    let (auth, store, transport) = await make([reply(#"{"ok":true}"#), reply(#"{"ok":true}"#)])
    try await auth.signupResend(email: "A@b.fi")
    try await auth.resetWithCode(email: "a@b.fi", code: "654-321", password: "uusisalasana")
    #expect(transport.requests[0].url?.path == "/api/auth/signup/resend")
    #expect(try sent(transport.requests[0]) == ["email": "a@b.fi"])
    #expect(transport.requests[1].url?.path == "/api/auth/password/reset")
    #expect(try sent(transport.requests[1]) == ["email": "a@b.fi", "code": "654321", "password": "uusisalasana"])
    #expect(await store.load() == nil)
}

@Test func resetWithExpiredCodeMapsToResetExpired() async {
    let (auth, _, _) = await make([reply(#"{"error":"Koodi on vanhentunut.","code":"RESET_EXPIRED"}"#, 410)])
    await #expect(throws: LKError(status: 410, code: "RESET_EXPIRED", message: "Koodi on vanhentunut.")) {
        try await auth.resetWithCode(email: "a@b.fi", code: "123456", password: "uusisalasana")
    }
}
