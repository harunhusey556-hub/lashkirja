import Foundation

// MARK: Greeting (web `lib/koti-greeting.ts`)

extension Koti {
    /// "Hyvää huomenta, Liisa": 5–9 morning, 10–16 day, 17–22 evening, 23–4 night (web `timeOfDayGreeting`).
    public static func timeOfDayGreeting(hour: Int, firstName: String) -> String {
        let base: String = switch hour {
        case 5..<10: "Hyvää huomenta"
        case 10..<17: "Hyvää päivää"
        case 17..<23: "Hyvää iltaa"
        default: "Hyvää yötä"
        }
        return firstName.isEmpty ? base : "\(base), \(firstName)"
    }

    /// The line under the month on Koti, by the hour of the owner's clock; nil without a name,
    /// as on the web (`kotiGreeting`), rather than a greeting to nobody.
    public static func greeting(at date: Date, firstName: String?, timeZone: TimeZone = .current) -> String? {
        let name = firstName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !name.isEmpty else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return timeOfDayGreeting(hour: calendar.component(.hour, from: date), firstName: name)
    }
}

// MARK: A brand-new account (web TF-06)

extension Koti {
    /// Nothing recorded and no bank: no receipt, statement, invoice or bank connection yet.
    /// Such an account starts from the Aloitetaan card, never from a ring or zero figures.
    public static func isFreshAccount(_ d: Dashboard) -> Bool {
        guard let setup = d.setup else { return false }
        return setup.empty && !setup.receipts && !setup.bank
    }

    public static let firstRunTitle = "Aloitetaan"
    public static let firstRunLead = "Kolme askelta, niin kirjanpito pyörii itsestään."
    /// What Koti will show, said once instead of 0,00 € cards.
    public static let firstRunNote = "Kun ensimmäiset kuitit, laskut tai pankkitapahtumat ovat sisällä, Koti näyttää tässä kuukauden myynnin, kulut, arvonlisäveron ja pankkitilien saldon."

    /// The receipt comes first: it takes half a minute with the camera and shows at once what the
    /// app does with a cost. The bank asks for a login at the bank, the seller details matter at
    /// the first invoice.
    public enum SetupStep: String, CaseIterable, Sendable, Identifiable {
        case receipt, bank, seller

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .receipt: "Kuvaa ensimmäinen kuitti"
            case .bank: "Yhdistä pankki"
            case .seller: "Täydennä laskuttajan tiedot"
            }
        }

        /// Why the step is worth doing, in one line.
        public var benefit: String {
            switch self {
            case .receipt: "Kulu kirjautuu ja sen arvonlisävero lasketaan valmiiksi."
            case .bank: "Tapahtumat tulevat itsestään ja maksut kohdistuvat laskuihin."
            case .seller: "Nimi, Y-tunnus ja tilinumero valmiina jokaisella laskulla."
            }
        }

        /// The next step's button.
        public var actionTitle: String {
            switch self {
            case .receipt: "Kuvaa kuitti"
            case .bank: "Yhdistä pankki"
            case .seller: "Täydennä tiedot"
            }
        }

        public var symbol: String {
            switch self {
            case .receipt: "camera"
            case .bank: "building.columns"
            case .seller: "person.text.rectangle"
            }
        }
    }

    public struct SetupProgress: Equatable, Sendable {
        public struct Row: Equatable, Sendable, Identifiable {
            public let step: SetupStep
            public let done: Bool
            public var id: SetupStep { step }
        }

        public let rows: [Row]

        public var done: Int { rows.filter(\.done).count }
        public var total: Int { rows.count }
        /// The first step not done, in the card's order: the one with the button.
        public var next: SetupStep? { rows.first { !$0.done }?.step }
        public var complete: Bool { next == nil }
        /// "1/3 valmis".
        public var label: String { "\(done)/\(total) valmis" }
        /// "Tehty 1, jäljellä 2": read aloud, "1/3" would be a fraction.
        public var accessibilityLabel: String { "Tehty \(done), jäljellä \(total - done)" }

        /// "Yhdistä pankki, seuraava askel. Tapahtumat tulevat …".
        public func rowAccessibilityLabel(_ row: Row) -> String {
            let state = row.done ? "valmis" : (row.step == next ? "seuraava askel" : "tekemättä")
            return "\(row.step.title), \(state). \(row.step.benefit)"
        }
    }

    public static func setupProgress(_ setup: Dashboard.Setup) -> SetupProgress {
        SetupProgress(rows: [
            .init(step: .receipt, done: setup.receipts),
            .init(step: .bank, done: setup.bank),
            .init(step: .seller, done: setup.seller),
        ])
    }
}

// MARK: The status card's ring

extension Koti {
    public static let nothingToCountYet = "Ei vielä tapahtumia tässä kuussa"

    public struct MonthStatus: Equatable, Sendable {
        /// nil when there is nothing to count: no ring then, never a full one.
        public let progress: Double?
        public let headline: String
        public let detail: String?
    }

    /// 0 of 0 is not "100 % · Kaikki kunnossa": a month with nothing in it says so.
    public static func monthStatus(done: Int, total: Int, blocking: Int) -> MonthStatus {
        guard total > 0 else {
            return MonthStatus(progress: nil, headline: blocking > 0 ? headline(blocking: blocking) : nothingToCountYet, detail: nil)
        }
        return MonthStatus(progress: min(1, Double(done) / Double(total)), headline: headline(blocking: blocking),
                           detail: "\(done) / \(total) tapahtumaa on kunnossa")
    }
}
