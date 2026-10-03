import Foundation

/// The order of Koti's parts. Money first: the balance is what an owner checks, so it sits
/// right under the month's status; what needs doing follows, then the month's figures and the
/// open invoices, and the history last.
public enum KotiSection: Hashable, Sendable {
    /// "Viimeistele yritysprofiili": the onboarding was skipped and is still open.
    case onboarding
    /// The month's checklist and the VAT estimate.
    case status
    /// Parts of the dashboard that did not load, with one retry.
    case partialFailure
    /// Käyttöönotto: first on a brand-new account, below the money otherwise.
    case setup
    /// Rahatilanne: today's balance and its line.
    case balance
    /// Tarvitaan sinulta.
    case tasks
    /// Tuonnit ja virheet, only while an import or fetch has failed.
    case failedJobs
    /// Myynti and Kulut of the shown month.
    case money
    /// Pankkitilit (without the balance card), Avoimet myyntilaskut and ostolaskut.
    case positions
    /// ALV-raja lähestyy / ylittynyt, outside the VAT register only.
    case vatThreshold
    /// Tulot ja menot, 6 kk.
    case cashflow
    /// Hoidettu automaattisesti: this week, so only on the current month.
    case handled
    /// A brand-new account: one sentence on what Koti will show, instead of zero cards.
    case firstRunNote
}

public enum KotiLayout {
    public struct Input: Equatable, Sendable {
        public var atCurrentMonth: Bool
        /// Nothing booked yet (no receipt, statement or invoice).
        public var brandNew: Bool
        /// Nothing booked and no bank either (`Koti.isFreshAccount`): the first-run page.
        public var fresh: Bool
        /// A Käyttöönotto step is still open.
        public var setupOpen: Bool
        public var partialFailure: Bool
        public var balanceCard: Bool
        public var hasTasks: Bool
        public var failedJobs: Bool
        public var hasPositions: Bool
        public var cashflowMoved: Bool
        public var handled: Bool
        public var onboardingOpen: Bool
        public var vatThreshold: Bool

        public init(atCurrentMonth: Bool = true, brandNew: Bool = false, fresh: Bool = false, setupOpen: Bool = false, partialFailure: Bool = false,
                    balanceCard: Bool = false, hasTasks: Bool = false, failedJobs: Bool = false, hasPositions: Bool = false,
                    cashflowMoved: Bool = false, handled: Bool = false, onboardingOpen: Bool = false, vatThreshold: Bool = false) {
            self.atCurrentMonth = atCurrentMonth
            self.brandNew = brandNew
            self.fresh = fresh
            self.setupOpen = setupOpen
            self.partialFailure = partialFailure
            self.balanceCard = balanceCard
            self.hasTasks = hasTasks
            self.failedJobs = failedJobs
            self.hasPositions = hasPositions
            self.cashflowMoved = cashflowMoved
            self.handled = handled
            self.onboardingOpen = onboardingOpen
            self.vatThreshold = vatThreshold
        }

        public init(dashboard d: Dashboard, atCurrentMonth: Bool, hasTasks: Bool, failedJobs: Int, onboardingOpen: Bool = false) {
            let setup = d.setup
            self.init(
                atCurrentMonth: atCurrentMonth,
                brandNew: setup?.empty == true,
                fresh: Koti.isFreshAccount(d),
                setupOpen: setup.map { $0.empty || !$0.receipts || !$0.bank } ?? false,
                partialFailure: !Koti.failedSections(d.sectionErrors).isEmpty,
                balanceCard: Koti.showsBalanceCard(d.bank),
                hasTasks: hasTasks,
                failedJobs: failedJobs > 0,
                hasPositions: !Koti.positionRows(d).isEmpty,
                cashflowMoved: d.cashflow.contains { $0.income != 0 || $0.expenses != 0 },
                handled: (d.handled?.count ?? 0) > 0,
                onboardingOpen: onboardingOpen,
                vatThreshold: Koti.vatThreshold(d) != nil
            )
        }
    }

    public static func sections(_ input: Input) -> [KotiSection] {
        let setup = input.atCurrentMonth && input.setupOpen
        var sections: [KotiSection] = []
        // As on the web, the skipped onboarding waits at the top of Koti.
        if input.onboardingOpen { sections.append(.onboarding) }
        // Nothing to count yet (TF-06): no ring saying "Kaikki kunnossa", no 0,00 € cards and no
        // empty lists; getting started and one honest sentence. Failures and tasks still show.
        if input.fresh {
            if setup { sections.append(.setup) }
            if input.partialFailure { sections.append(.partialFailure) }
            if input.hasTasks { sections.append(.tasks) }
            if input.failedJobs { sections.append(.failedJobs) }
            sections.append(.firstRunNote)
            return sections
        }
        // A brand-new account has no money to show yet: getting started is the whole page.
        if setup && input.brandNew { sections.append(.setup) }
        sections.append(.status)
        if input.partialFailure { sections.append(.partialFailure) }
        if input.balanceCard { sections.append(.balance) }
        if input.hasTasks { sections.append(.tasks) }
        if input.failedJobs { sections.append(.failedJobs) }
        sections.append(.money)
        if input.hasPositions { sections.append(.positions) }
        if input.vatThreshold { sections.append(.vatThreshold) }
        if setup && !input.brandNew { sections.append(.setup) }
        if input.cashflowMoved { sections.append(.cashflow) }
        if input.handled && input.atCurrentMonth { sections.append(.handled) }
        return sections
    }
}
