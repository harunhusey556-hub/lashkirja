import Foundation

/// One answer chip of an onboarding question (lib/onboarding.ts ONBOARDING_STEPS).
public struct OnboardingChoice: Sendable, Identifiable, Equatable {
    public let value: String
    public let label: String
    public let detail: String?
    public var id: String { value }
}

public struct OnboardingQuestion: Sendable {
    public let question: String
    /// One short line under the question.
    public let hint: String?
    public let choices: [OnboardingChoice]
}

public enum OnboardingQuestions {
    public static let entityTypes = ["toiminimi", "kevytyrittaja", "oy"]
    public static let vatPeriods = ["month", "quarter", "year"]

    public static let entity = OnboardingQuestion(
        question: "Mikä on yritysmuotosi?",
        hint: nil,
        choices: [
            OnboardingChoice(value: "toiminimi", label: "Toiminimi", detail: "Yksityinen elinkeinonharjoittaja"),
            OnboardingChoice(value: "kevytyrittaja", label: "Kevytyrittäjä", detail: "Laskutat laskutuspalvelun kautta"),
            OnboardingChoice(value: "oy", label: "Osakeyhtiö (Oy)", detail: nil),
        ])

    /// The values are the answer as text: "true" / "false".
    public static let vat = OnboardingQuestion(
        question: "Oletko arvonlisäverorekisterissä?",
        hint: "Tästä riippuu, lasketaanko myynnistäsi ALV.",
        choices: [
            OnboardingChoice(value: "true", label: "Kyllä, olen ALV-rekisterissä", detail: nil),
            OnboardingChoice(value: "false", label: "En ole ALV-rekisterissä", detail: nil),
        ])

    public static let vatPeriod = OnboardingQuestion(
        question: "Kuinka usein ilmoitat ALV:n OmaVerossa?",
        hint: nil,
        choices: [
            OnboardingChoice(value: "month", label: "Kuukausittain", detail: "Tavallisin"),
            OnboardingChoice(value: "quarter", label: "Neljännesvuosittain", detail: "Kolmen kuukauden välein"),
            OnboardingChoice(value: "year", label: "Vuosittain", detail: nil),
        ])

    public static let sales = OnboardingQuestion(
        question: "Mitä yrityksesi myy?",
        hint: "Voit valita useita.",
        choices: [
            OnboardingChoice(value: "ripsipalvelut", label: "Ripsienpidennykset ja huollot", detail: nil),
            OnboardingChoice(value: "kulmapalvelut", label: "Kulmapalvelut", detail: "Laminointi ja värjäys"),
            OnboardingChoice(value: "koulutus", label: "Koulutukset ja kurssit", detail: nil),
            OnboardingChoice(value: "tuotemyynti", label: "Kauneustuotteiden myynti", detail: nil),
        ])

    public static let expenses = OnboardingQuestion(
        question: "Mitkä ovat tavallisimmat kulusi?",
        hint: "Voit valita useita.",
        choices: [
            OnboardingChoice(value: "tarvikkeet", label: "Tarvikkeet", detail: "Liimat, kuidut ja hoitotuotteet"),
            OnboardingChoice(value: "vuokra", label: "Liiketilan vuokra", detail: nil),
            OnboardingChoice(value: "markkinointi", label: "Markkinointi ja ajanvaraus", detail: nil),
            OnboardingChoice(value: "koulutuskulut", label: "Koulutus ja ammattikirjallisuus", detail: nil),
        ])
}

/// The onboarding answers; also the draft kept while the questions are snoozed.
/// Nothing in the multi-select questions is picked in advance, and none picked is a valid answer.
public struct OnboardingAnswers: Codable, Equatable, Sendable {
    public var entityType = "toiminimi"
    public var vatRegistered = false
    public var vatPeriod = "month"
    public var salesTypes: [String] = []
    public var expenseCategories: [String] = []

    public init() {}

    public mutating func toggleSales(_ value: String) {
        salesTypes = Self.toggled(salesTypes, value, in: OnboardingQuestions.sales)
    }

    public mutating func toggleExpense(_ value: String) {
        expenseCategories = Self.toggled(expenseCategories, value, in: OnboardingQuestions.expenses)
    }

    /// A stored draft keeps only values the server accepts (sanitizeAnswers).
    public func sanitized() -> OnboardingAnswers {
        var clean = OnboardingAnswers()
        if OnboardingQuestions.entityTypes.contains(entityType) { clean.entityType = entityType }
        clean.vatRegistered = vatRegistered
        if OnboardingQuestions.vatPeriods.contains(vatPeriod) { clean.vatPeriod = vatPeriod }
        clean.salesTypes = Self.ordered(salesTypes, in: OnboardingQuestions.sales)
        clean.expenseCategories = Self.ordered(expenseCategories, in: OnboardingQuestions.expenses)
        return clean
    }

    /// `POST /api/onboarding` (businessProfileSchema).
    public struct Body: Encodable, Sendable {
        public let entityType: String
        public let vatRegistered: Bool
        public let vatPeriod: String
        public let salesTypes: [String]
        public let expenseCategories: [String]
    }

    public var body: Body {
        let clean = sanitized()
        // The column needs a value; it only matters for a VAT-registered business.
        return Body(entityType: clean.entityType, vatRegistered: clean.vatRegistered,
                    vatPeriod: clean.vatRegistered ? clean.vatPeriod : "month",
                    salesTypes: clean.salesTypes, expenseCategories: clean.expenseCategories)
    }

    private static func toggled(_ list: [String], _ value: String, in question: OnboardingQuestion) -> [String] {
        let next = list.contains(value) ? list.filter { $0 != value } : list + [value]
        return ordered(next, in: question)
    }

    /// Known values only, once each, in the question's order.
    static func ordered(_ list: [String], in question: OnboardingQuestion) -> [String] {
        question.choices.map(\.value).filter { list.contains($0) }
    }
}

/// "Ohita nyt" (lib/onboarding-gate.ts): the questions stay away for 24 h, remembered per
/// account on this device; no profile values are assumed or saved meanwhile.
public enum OnboardingSnooze {
    public static let duration: TimeInterval = 24 * 60 * 60

    public static func until(now: Date) -> Date { now.addingTimeInterval(duration) }

    public static func isActive(until: Date?, now: Date) -> Bool {
        guard let until else { return false }
        return until > now
    }

    /// UserDefaults keys, per signed-in account.
    public static func key(userId: String) -> String { "onboarding-snoozed-until.\(userId)" }
    public static func draftKey(userId: String) -> String { "onboarding-draft.v1.\(userId)" }
}

/// What the shell does with `GET /api/onboarding`'s `onboarded` flag.
public enum OnboardingGateDecision: Equatable, Sendable {
    /// Onboarded: nothing to show.
    case done
    /// Not onboarded and not snoozed: open the questions.
    case ask
    /// Snoozed: Koti shows a card that reopens them where they were left.
    case resumeCard

    public static func decide(onboarded: Bool, snoozedUntil: Date?, now: Date) -> OnboardingGateDecision {
        if onboarded { return .done }
        return OnboardingSnooze.isActive(until: snoozedUntil, now: now) ? .resumeCard : .ask
    }
}

/// The Koti card shown while the questions are snoozed (OnboardingResumeCard.tsx).
public enum OnboardingResume {
    public static let title = "Viimeistele yritysprofiili"
    public static let detail = "Noin minuutti. ALV lasketaan profiilin mukaan."
}
