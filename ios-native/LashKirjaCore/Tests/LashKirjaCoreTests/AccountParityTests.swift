import Testing
import Foundation
@testable import LashKirjaCore

// MARK: - Perintä (SellerProfileCard.tsx: lateInterestPercent / reminderFee)

private func profile(interest: Decimal? = nil, feeCents: Int? = 500) -> Profile {
    var p = Profile(firstName: "Liisa", lastName: "Demo", email: "a@b.fi", entityType: "oy", vatRegistered: true, vatPeriod: "month")
    p.lateInterestPercent = interest
    p.reminderFeeCents = feeCents
    return p
}

private func patchJSON(_ old: Profile, _ new: Profile) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(ProfilePatch(from: old, to: new))) as! [String: Any]
}

@Test func collectionFieldsShowStoredValuesTheWebWay() {
    let f = CollectionFields(profile: profile(interest: Decimal(string: "11.5"), feeCents: 750))
    #expect(f.interest == "11,5")
    #expect(f.fee == "7,50")
    // No interest set: empty; a missing fee reads as the server default 5,00.
    let empty = CollectionFields(profile: profile(interest: nil, feeCents: nil))
    #expect(empty.interest == "")
    #expect(empty.fee == "5,00")
}

@Test func collectionFieldsValidateLikeTheWeb() {
    var f = CollectionFields(profile: profile())
    f.interest = "101"
    #expect(f.interestError == "Anna korko välillä 0-100, esim. 11,5.")
    f.interest = "-1"
    #expect(f.interestError == "Anna korko välillä 0-100, esim. 11,5.")
    f.interest = "abc"
    #expect(f.interestError == "Anna korko välillä 0-100, esim. 11,5.")
    f.interest = " 11,5 % "
    #expect(f.interestError == "Anna korko välillä 0-100, esim. 11,5.") // "%" is not a number on the web either
    f.interest = "11,5"
    #expect(f.interestError == nil)
    f.interest = ""
    #expect(f.interestError == nil) // empty = no interest charged
    f.fee = ""
    #expect(f.feeError == "Anna muistutusmaksu, esim. 5,00.")
    f.fee = "-2"
    #expect(f.feeError == "Anna muistutusmaksu, esim. 5,00.")
    f.fee = "7,50 €"
    #expect(f.feeError == nil)
    f.fee = "5 eur"
    #expect(f.feeError == nil)
    #expect(f.isValid)
}

@Test func collectionPatchSendsInterestAndFeeInEuros() throws {
    let base = profile(interest: nil, feeCents: 500)
    var fields = CollectionFields(profile: base)
    fields.interest = "11,5"
    fields.fee = "7,5"
    var edited = base
    fields.apply(to: &edited, from: base)
    #expect(edited.lateInterestPercent == Decimal(string: "11.5"))
    #expect(edited.reminderFeeCents == 750)
    let json = try patchJSON(base, edited)
    #expect(Set(json.keys) == ["lateInterestPercent", "reminderFee"])
    #expect((json["lateInterestPercent"] as? NSNumber)?.doubleValue == 11.5)
    // The server takes euros (`reminderFee`) and stores cents itself.
    #expect((json["reminderFee"] as? NSNumber)?.doubleValue == 7.5)
}

@Test func collectionUntouchedFieldsSendNothing() throws {
    // A stored float like 11.499999 must not be re-sent just because the form showed it rounded.
    let base = profile(interest: Decimal(11.499999999), feeCents: 500)
    let fields = CollectionFields(profile: base)
    var edited = base
    fields.apply(to: &edited, from: base)
    #expect(ProfilePatch(from: base, to: edited).isEmpty)
}

@Test func collectionClearedInterestIsSentAsNull() throws {
    let base = profile(interest: 8, feeCents: 500)
    var fields = CollectionFields(profile: base)
    fields.interest = "  "
    var edited = base
    fields.apply(to: &edited, from: base)
    let json = try patchJSON(base, edited)
    #expect(Set(json.keys) == ["lateInterestPercent"])
    #expect(json["lateInterestPercent"] is NSNull)
}

// MARK: - Passkey sign-in (LoginForm.tsx, passkey-client.ts signInWithPasskey)

private let apiHeader = ["x-lashkirja-api-version": "1"]
private func json(_ s: String, _ status: Int = 200) -> HTTPResponse { HTTPResponse(status: status, headers: apiHeader, body: Data(s.utf8)) }
private let fixedNow = Date(timeIntervalSince1970: 1_790_000_000)

private func makeAuth(_ responses: [HTTPResponse]) async -> (AuthService, InMemoryTokenStore, FakeTransport) {
    let store = InMemoryTokenStore()
    let transport = FakeTransport(responses)
    let auth = AuthService(store: store, now: { fixedNow })
    let client = APIClient(baseURL: URL(string: "https://example.test")!, transport: transport, tokens: auth, sleep: { _ in })
    await auth.bind(client)
    return (auth, store, transport)
}

@Test func passkeySignInOptionsDecodeUsernameless() async throws {
    let (auth, _, transport) = await makeAuth([json(#"{"challengeId":"c1","options":{"rpId":"lashkirja.fi","challenge":"AQID","timeout":60000,"userVerification":"required"}}"#)])
    let start = try await auth.passkeyOptions()
    #expect(start.challengeId == "c1")
    #expect(start.rpId == "lashkirja.fi")
    #expect(start.challenge == Data([1, 2, 3]))
    #expect(transport.requests[0].url?.path == "/api/auth/passkey/authenticate/options")
    #expect(transport.requests[0].httpMethod == "POST")
    #expect(String(data: transport.requests[0].httpBody ?? Data(), encoding: .utf8) == "{}")
}

@Test func passkeySignInStoresTheTokenLikePasswordLogin() async throws {
    let token = #"{"token":"T9","tokenType":"Bearer","expiresAt":"2026-11-01T00:00:00.000Z","user":{"userId":"u1","email":"a@b.fi","firstName":"Liisa"}}"#
    let (auth, store, transport) = await makeAuth([json(token)])
    let verify = PasskeySignInVerify(challengeId: "c1", credentialId: Data([0xfb, 0xff]), clientDataJSON: Data([1]),
                                     authenticatorData: Data([2]), signature: Data([3]), userHandle: Data([4]))
    let user = try await auth.passkeySignIn(verify)
    #expect(user.firstName == "Liisa")
    #expect(await store.load()?.token == "T9")
    #expect(await auth.currentToken() == "T9")
    #expect(transport.requests[0].url?.path == "/api/auth/passkey/authenticate/verify")
    let body = try JSONSerialization.jsonObject(with: transport.requests[0].httpBody!) as! [String: Any]
    #expect(body["challengeId"] as? String == "c1")
    #expect(body["transport"] as? String == "bearer")
    #expect(body["device"] as? String == "ios-app")
    let credential = body["response"] as! [String: Any]
    #expect(credential["id"] as? String == "-_8")
    #expect(credential["rawId"] as? String == "-_8")
    #expect(credential["type"] as? String == "public-key")
    #expect(credential["authenticatorAttachment"] as? String == "platform")
    let assertion = credential["response"] as! [String: Any]
    #expect(assertion["clientDataJSON"] as? String == "AQ")
    #expect(assertion["authenticatorData"] as? String == "Ag")
    #expect(assertion["signature"] as? String == "Aw")
    #expect(assertion["userHandle"] as? String == "BA")
}

@Test func passkeySignInLeavesOutAnEmptyUserHandle() throws {
    let verify = PasskeySignInVerify(challengeId: "c", credentialId: Data([1]), clientDataJSON: Data([1]),
                                     authenticatorData: Data([1]), signature: Data([1]), userHandle: nil)
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(verify)) as! [String: Any]
    let assertion = (body["response"] as! [String: Any])["response"] as! [String: Any]
    #expect(assertion["userHandle"] == nil)
}

@Test func passkeySignInFailuresReadLikeTheWeb() {
    #expect(PasskeySignInFailure.fromOptions(status: 503) == .notConfigured)
    #expect(PasskeySignInFailure.fromOptions(status: 429) == .rate)
    #expect(PasskeySignInFailure.fromOptions(status: 0) == .network)
    #expect(PasskeySignInFailure.fromOptions(status: 500) == .failed)
    #expect(PasskeySignInFailure.fromVerify(status: 401) == .rejected)
    #expect(PasskeySignInFailure.fromVerify(status: 403) == .closed)
    #expect(PasskeySignInFailure.fromVerify(status: 429) == .rate)
    #expect(PasskeySignInFailure.fromVerify(status: 503) == .notConfigured)
    #expect(PasskeySignInFailure.fromVerify(status: 0) == .network)
    #expect(PasskeySignInFailure(ceremony: .cancelled) == .cancelled)
    #expect(PasskeySignInFailure(ceremony: .notConfigured) == .notConfigured)
    #expect(PasskeySignInFailure(ceremony: .exists) == .failed)

    #expect(PasskeySignInFailure.cancelled.message(serverMessage: "x") == nil)
    #expect(PasskeySignInFailure.rejected.message(serverMessage: "x") == "Pääsyavain ei kelpaa. Kirjaudu salasanalla.")
    #expect(PasskeySignInFailure.closed.message(serverMessage: nil) == "Tili on suljettu.")
    #expect(PasskeySignInFailure.closed.message(serverMessage: "Tili suljettu 1.9.") == "Tili suljettu 1.9.")
    #expect(PasskeySignInFailure.rate.message(serverMessage: nil) == "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen.")
    #expect(PasskeySignInFailure.failed.message(serverMessage: "raw") == "Kirjautuminen pääsyavaimella epäonnistui. Yritä uudelleen tai kirjaudu salasanalla.")
    // These two hide the button and are a note, not an error.
    #expect(PasskeySignInFailure.notConfigured.hidesButton)
    #expect(PasskeySignInFailure.unsupported.hidesButton)
    #expect(!PasskeySignInFailure.rejected.hidesButton)
}

// MARK: - Passkey offer after a password sign-in (lib/passkey-offer.ts)

@Test func passkeyOfferIsRememberedPerAccountOnTheDevice() {
    #expect(PasskeyOffer.key(email: "  Liisa@Example.FI ") == "lk.passkeyOffer.v1:liisa@example.fi")
}

@Test func passkeyOfferOnlyWhenReadyUnseenAndWithoutPasskeys() {
    #expect(PasskeyOffer.shouldOffer(passkeysReady: true, email: "a@b.fi", seen: false, passkeyCount: 0))
    #expect(!PasskeyOffer.shouldOffer(passkeysReady: false, email: "a@b.fi", seen: false, passkeyCount: 0))
    #expect(!PasskeyOffer.shouldOffer(passkeysReady: true, email: " ", seen: false, passkeyCount: 0))
    #expect(!PasskeyOffer.shouldOffer(passkeysReady: true, email: "a@b.fi", seen: true, passkeyCount: 0))
    #expect(!PasskeyOffer.shouldOffer(passkeysReady: true, email: "a@b.fi", seen: false, passkeyCount: 1))
    // Offline, slow (over 2,5 s) or an error: no list, no offer.
    #expect(!PasskeyOffer.shouldOffer(passkeysReady: true, email: "a@b.fi", seen: false, passkeyCount: nil))
    #expect(PasskeyOffer.listTimeout == 2.5)
}

// MARK: - Onboarding (lib/onboarding.ts, lib/onboarding-gate.ts)

@Test func onboardingAsksTheWebsMultiSelectQuestions() {
    #expect(OnboardingQuestions.sales.question == "Mitä yrityksesi myy?")
    #expect(OnboardingQuestions.sales.hint == "Voit valita useita.")
    #expect(OnboardingQuestions.sales.choices.map(\.value) == ["ripsipalvelut", "kulmapalvelut", "koulutus", "tuotemyynti"])
    #expect(OnboardingQuestions.sales.choices[1].label == "Kulmapalvelut")
    #expect(OnboardingQuestions.sales.choices[1].detail == "Laminointi ja värjäys")
    #expect(OnboardingQuestions.expenses.question == "Mitkä ovat tavallisimmat kulusi?")
    #expect(OnboardingQuestions.expenses.choices.map(\.value) == ["tarvikkeet", "vuokra", "markkinointi", "koulutuskulut"])
    #expect(OnboardingQuestions.expenses.choices[0].detail == "Liimat, kuidut ja hoitotuotteet")
}

@Test func onboardingStartsWithNothingPicked() {
    let answers = OnboardingAnswers()
    #expect(answers.salesTypes.isEmpty)
    #expect(answers.expenseCategories.isEmpty)
}

@Test func onboardingToggleKeepsTheQuestionsOrder() {
    var answers = OnboardingAnswers()
    answers.toggleSales("tuotemyynti")
    answers.toggleSales("ripsipalvelut")
    #expect(answers.salesTypes == ["ripsipalvelut", "tuotemyynti"])
    answers.toggleSales("tuotemyynti")
    #expect(answers.salesTypes == ["ripsipalvelut"])
    answers.toggleExpense("vuokra")
    answers.toggleExpense("bogus")
    #expect(answers.expenseCategories == ["vuokra"])
}

@Test func onboardingBodyMatchesTheServerSchema() throws {
    var answers = OnboardingAnswers()
    answers.entityType = "kevytyrittaja"
    answers.vatRegistered = false
    answers.vatPeriod = "quarter"
    answers.toggleSales("koulutus")
    let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(answers.body)) as! [String: Any]
    #expect(body["entityType"] as? String == "kevytyrittaja")
    #expect(body["vatRegistered"] as? Bool == false)
    // The column needs a value; it only matters for a VAT-registered business.
    #expect(body["vatPeriod"] as? String == "month")
    #expect(body["salesTypes"] as? [String] == ["koulutus"])
    #expect(body["expenseCategories"] as? [String] == [])
    answers.vatRegistered = true
    let registered = try JSONSerialization.jsonObject(with: JSONEncoder().encode(answers.body)) as! [String: Any]
    #expect(registered["vatPeriod"] as? String == "quarter")
}

@Test func onboardingDraftDropsUnknownValues() throws {
    let raw = #"{"entityType":"llc","vatRegistered":true,"vatPeriod":"week","salesTypes":["koulutus","x","koulutus"],"expenseCategories":["vuokra"]}"#
    let answers = try JSONDecoder().decode(OnboardingAnswers.self, from: Data(raw.utf8)).sanitized()
    #expect(answers.entityType == "toiminimi")
    #expect(answers.vatRegistered == true)
    #expect(answers.vatPeriod == "month")
    #expect(answers.salesTypes == ["koulutus"])
    #expect(answers.expenseCategories == ["vuokra"])
}

@Test func onboardingSnoozeLastsADay() {
    let until = OnboardingSnooze.until(now: fixedNow)
    #expect(until == fixedNow.addingTimeInterval(86_400))
    #expect(OnboardingSnooze.isActive(until: until, now: fixedNow.addingTimeInterval(86_399)))
    #expect(!OnboardingSnooze.isActive(until: until, now: until))
    #expect(!OnboardingSnooze.isActive(until: nil, now: fixedNow))
    #expect(OnboardingSnooze.key(userId: "u1") == "onboarding-snoozed-until.u1")
    #expect(OnboardingSnooze.draftKey(userId: "u1") == "onboarding-draft.v1.u1")
}

@Test func onboardingGateAsksOrOffersTheResumeCard() {
    let later = fixedNow.addingTimeInterval(3_600)
    #expect(OnboardingGateDecision.decide(onboarded: true, snoozedUntil: later, now: fixedNow) == .done)
    #expect(OnboardingGateDecision.decide(onboarded: false, snoozedUntil: nil, now: fixedNow) == .ask)
    #expect(OnboardingGateDecision.decide(onboarded: false, snoozedUntil: later, now: fixedNow) == .resumeCard)
    // The snooze ran out: the questions come back by themselves.
    #expect(OnboardingGateDecision.decide(onboarded: false, snoozedUntil: fixedNow, now: fixedNow) == .ask)
    #expect(OnboardingResume.title == "Viimeistele yritysprofiili")
    #expect(OnboardingResume.detail == "Noin minuutti. ALV lasketaan profiilin mukaan.")
}
