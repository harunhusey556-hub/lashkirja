import Testing
import Foundation
@testable import LashKirjaCore

// MARK: - First-run conversation (lib/onboarding.ts, OnboardingChat.tsx)

/// Answers every question up to the summary: toiminimi, the given VAT answer, monthly, nothing sold, rent.
private func finished(vat: Bool) -> OnboardingFlow {
    var flow = OnboardingFlow()
    flow.answer("toiminimi")
    flow.answer(vat ? "true" : "false")
    if vat { flow.answer("month") }
    flow.answer([String]())
    flow.answer(["vuokra"])
    return flow
}

@Test func onboardingFlowMirrorsTheWebsQuestions() {
    #expect(OnboardingFlow.intro == "Hei! Muokataan LashKirja sinun yrityksellesi sopivaksi. Se vie noin minuutin.")
    #expect(OnboardingStep.entityType.question == "Mikä on yritysmuotosi?")
    #expect(OnboardingStep.entityType.hint == nil)
    #expect(OnboardingStep.entityType.choices.map(\.label) == ["Toiminimi", "Kevytyrittäjä", "Osakeyhtiö (Oy)"])
    #expect(OnboardingStep.entityType.choices[0].detail == "Yksityinen elinkeinonharjoittaja")
    #expect(OnboardingStep.entityType.choices[1].detail == "Laskutat laskutuspalvelun kautta")
    #expect(OnboardingStep.vatRegistered.question == "Oletko arvonlisäverorekisterissä?")
    #expect(OnboardingStep.vatRegistered.hint == "Tästä riippuu, lasketaanko myynnistäsi ALV.")
    #expect(OnboardingStep.vatRegistered.choices.map(\.label) == ["Kyllä, olen ALV-rekisterissä", "En ole ALV-rekisterissä"])
    #expect(OnboardingStep.vatPeriod.question == "Kuinka usein ilmoitat ALV:n OmaVerossa?")
    #expect(OnboardingStep.vatPeriod.choices.map(\.label) == ["Kuukausittain", "Neljännesvuosittain", "Vuosittain"])
    #expect(OnboardingStep.vatPeriod.choices[0].detail == "Tavallisin")
    #expect(OnboardingStep.vatPeriod.choices[1].detail == "Kolmen kuukauden välein")
    #expect(OnboardingStep.salesTypes.isMultiSelect && OnboardingStep.expenseCategories.isMultiSelect)
    #expect(!OnboardingStep.entityType.isMultiSelect)
}

@Test func onboardingFlowAsksOneQuestionAtATime() {
    var flow = OnboardingFlow()
    #expect(flow.current == .entityType)
    #expect(flow.transcript.isEmpty)
    #expect(flow.steps.count == 5)
    #expect(flow.progressLabel == "1 / 5")
    flow.answer("oy")
    #expect(flow.current == .vatRegistered)
    #expect(flow.transcript == [.entityType])
    #expect(flow.progress == 0.2)
    // A value that is not a choice of the current question is not an answer.
    flow.answer("month")
    flow.answer(["vuokra"])
    #expect(flow.current == .vatRegistered)
    flow.answer("true")
    #expect(flow.current == .vatPeriod)
    flow.answer("quarter")
    #expect(flow.current == .salesTypes)
    flow.answer(["tuotemyynti", "bogus", "ripsipalvelut"])
    #expect(flow.answers.salesTypes == ["ripsipalvelut", "tuotemyynti"])
    flow.answer([String]())
    #expect(flow.isComplete)
    #expect(flow.current == nil)
    #expect(flow.progress == 1)
    #expect(flow.progressLabel == "Valmis")
    #expect(flow.transcript == OnboardingStep.allCases)
}

@Test func onboardingFlowVatNoSkipsThePeriod() {
    var flow = OnboardingFlow()
    flow.answer("kevytyrittaja")
    flow.answer("false")
    #expect(flow.steps == [.entityType, .vatRegistered, .salesTypes, .expenseCategories])
    #expect(flow.current == .salesTypes)
    #expect(flow.progressLabel == "3 / 4")
    let done = finished(vat: false)
    #expect(done.isComplete)
    #expect(done.summary.map(\.label) == ["Yritysmuoto", "ALV-rekisteri", "Myynti", "Kulut"])
    #expect(done.answers.body.vatPeriod == "month")
    #expect(done.answers.body.vatRegistered == false)
}

@Test func onboardingFlowEditKeepsLaterAnswersThatStillHold() {
    var flow = finished(vat: true)
    flow.edit(.entityType)
    #expect(flow.current == .entityType)
    #expect(flow.transcript.isEmpty)
    #expect(flow.selection(for: .entityType) == ["toiminimi"])
    #expect(!flow.isComplete)
    flow.answer("oy")
    // Everything after it still holds: straight back to the summary.
    #expect(flow.isComplete)
    #expect(flow.answers.entityType == "oy")
    #expect(flow.answerText(.expenseCategories) == "Liiketilan vuokra")
}

@Test func onboardingFlowEditingVatDropsOrAsksThePeriod() {
    var flow = finished(vat: true)
    flow.edit(.vatRegistered)
    flow.answer("false")
    #expect(flow.isComplete)
    #expect(!flow.answered.contains(.vatPeriod))
    #expect(flow.summary.map(\.step) == [.entityType, .vatRegistered, .salesTypes, .expenseCategories])
    flow.edit(.vatRegistered)
    flow.answer("true")
    // Registered again: the period is a new question, nothing pre-chosen.
    #expect(flow.current == .vatPeriod)
    #expect(flow.selection(for: .vatPeriod).isEmpty)
    flow.answer("year")
    #expect(flow.isComplete)
    #expect(flow.answers.body.vatPeriod == "year")
}

@Test func onboardingFlowEditIgnoresUnansweredSteps() {
    var flow = OnboardingFlow()
    flow.answer("toiminimi")
    flow.edit(.salesTypes)
    #expect(flow.current == .vatRegistered)
    flow.edit(.entityType)
    #expect(flow.current == .entityType)
    flow.edit(.vatRegistered)
    #expect(flow.current == .entityType)
}

@Test func onboardingFlowAnswerTexts() {
    var flow = OnboardingFlow()
    #expect(flow.answerText(.entityType) == "")
    #expect(flow.selection(for: .entityType).isEmpty)
    flow.answer("oy")
    flow.answer("true")
    flow.answer("month")
    flow.answer(["kulmapalvelut", "koulutus"])
    flow.answer([String]())
    #expect(flow.answerText(.entityType) == "Osakeyhtiö (Oy)")
    #expect(flow.answerText(.vatRegistered) == "Kyllä, olen ALV-rekisterissä")
    #expect(flow.answerText(.vatPeriod) == "Kuukausittain")
    #expect(flow.answerText(.salesTypes) == "Kulmapalvelut, Koulutukset ja kurssit")
    #expect(flow.answerText(.expenseCategories) == "Ei mitään näistä")
    #expect(flow.summary.map(\.value) == ["Osakeyhtiö (Oy)", "Kyllä", "Kuukausittain", "Kulmapalvelut, Koulutukset ja kurssit", "Ei mitään näistä"])
    var no = OnboardingFlow()
    no.answer("toiminimi")
    no.answer("false")
    #expect(no.answerText(.vatRegistered) == "En ole ALV-rekisterissä")
    #expect(no.summary[1].value == "Ei")
}

@Test func onboardingFlowDraftRoundTrip() throws {
    var flow = OnboardingFlow()
    flow.answer("kevytyrittaja")
    flow.answer("true")
    flow.answer("quarter")
    flow.answer(["ripsipalvelut"])
    flow.edit(.vatRegistered)
    let data = try JSONEncoder().encode(flow)
    let restored = try #require(OnboardingFlow.draft(from: data))
    #expect(restored == flow)
    #expect(restored.current == .vatRegistered)
    #expect(restored.transcript == [.entityType])
    #expect(restored.selection(for: .vatRegistered) == ["true"])
    #expect(restored.answers.salesTypes == ["ripsipalvelut"])
}

@Test func onboardingFlowDraftFromTheEarlierFormStartsOver() throws {
    let raw = #"{"entityType":"oy","vatRegistered":true,"vatPeriod":"year","salesTypes":["koulutus","x"],"expenseCategories":[]}"#
    let flow = try #require(OnboardingFlow.draft(from: Data(raw.utf8)))
    #expect(flow.current == .entityType)
    #expect(flow.answered.isEmpty)
    #expect(flow.selection(for: .entityType).isEmpty)
    #expect(flow.selection(for: .salesTypes) == ["koulutus"])
    #expect(OnboardingFlow.draft(from: Data("nonsense".utf8)) == nil)
}

@Test func onboardingFlowDraftDropsWhatNoLongerHolds() throws {
    // A tampered draft: a VAT period answered for a business that is not VAT-registered,
    // an unknown company form and an edit of an unanswered step.
    let raw = #"{"answers":{"entityType":"llc","vatRegistered":false,"vatPeriod":"year","salesTypes":[],"expenseCategories":[]},"answered":["entityType","vatRegistered","vatPeriod"],"editing":"salesTypes"}"#
    let flow = try #require(OnboardingFlow.draft(from: Data(raw.utf8)))
    #expect(flow.answers.entityType == "toiminimi")
    #expect(flow.answered == [.entityType, .vatRegistered])
    #expect(flow.editing == nil)
    #expect(flow.current == .salesTypes)
}
