import Foundation

// Card payments on the iPhone (Stripe Terminal, Tap to Pay). The server talks to Stripe; the app
// only drives the reader. A payment counts on the invoice only after the server has checked it
// with Stripe (`finalize` or the webhook), never because the phone said so.

// MARK: - API models (`/api/pos/*`)

/// `GET /api/pos/status` (also the answer of onboarding refresh and the settings PATCH).
public struct POSStatus: Decodable, Sendable, Equatable {
    public struct Account: Decodable, Sendable, Equatable {
        public let connected: Bool
        public let chargesEnabled: Bool
        public let payoutsEnabled: Bool
        public let detailsSubmitted: Bool

        public init(connected: Bool, chargesEnabled: Bool, payoutsEnabled: Bool, detailsSubmitted: Bool) {
            self.connected = connected
            self.chargesEnabled = chargesEnabled
            self.payoutsEnabled = payoutsEnabled
            self.detailsSubmitted = detailsSubmitted
        }

        public static let none = Account(connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false)

        enum CodingKeys: String, CodingKey { case connected, chargesEnabled, payoutsEnabled, detailsSubmitted }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            connected = try c.decodeIfPresent(Bool.self, forKey: .connected) ?? false
            chargesEnabled = try c.decodeIfPresent(Bool.self, forKey: .chargesEnabled) ?? false
            payoutsEnabled = try c.decodeIfPresent(Bool.self, forKey: .payoutsEnabled) ?? false
            detailsSubmitted = try c.decodeIfPresent(Bool.self, forKey: .detailsSubmitted) ?? false
        }
    }

    public let enabled: Bool
    public let account: Account
    public let locationId: String?
    public let posEnabled: Bool
    public let ready: Bool
    /// A Stripe Express dashboard link, only when the server offers one (not in the v1 contract).
    public let dashboardUrl: String?
    /// The server's Stripe key is a test key: the app may offer the simulated reader (Testitila).
    /// Missing (older servers) and any live key read as false.
    public let testMode: Bool

    public init(enabled: Bool, account: Account, locationId: String?, posEnabled: Bool, ready: Bool, dashboardUrl: String? = nil,
                testMode: Bool = false) {
        self.enabled = enabled
        self.account = account
        self.locationId = locationId
        self.posEnabled = posEnabled
        self.ready = ready
        self.dashboardUrl = dashboardUrl
        self.testMode = testMode
    }

    /// A server without Stripe answers every `/api/pos/*` with 503: the same as "not enabled".
    public static let unavailable = POSStatus(enabled: false, account: .none, locationId: nil, posEnabled: false, ready: false)

    enum CodingKeys: String, CodingKey { case enabled, account, locationId, posEnabled, ready, dashboardUrl, testMode }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        account = try c.decodeIfPresent(Account.self, forKey: .account) ?? .none
        locationId = try c.decodeIfPresent(String.self, forKey: .locationId)
        posEnabled = try c.decodeIfPresent(Bool.self, forKey: .posEnabled) ?? false
        ready = try c.decodeIfPresent(Bool.self, forKey: .ready) ?? false
        dashboardUrl = try c.decodeIfPresent(String.self, forKey: .dashboardUrl)
        testMode = try c.decodeIfPresent(Bool.self, forKey: .testMode) ?? false
    }
}

/// The status bare or as `{ "status": … }`; the refresh and PATCH answers may use either.
public struct POSStatusEnvelope: Decodable, Sendable {
    public let status: POSStatus

    enum CodingKeys: String, CodingKey { case status }

    public init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: CodingKeys.self), let wrapped = try? c.decode(POSStatus.self, forKey: .status) {
            status = wrapped
        } else {
            status = try POSStatus(from: decoder)
        }
    }
}

/// `POST /api/pos/onboarding`: the Stripe onboarding page to open.
public struct POSOnboardingLink: Decodable, Sendable { public let url: String }

/// `POST /api/pos/connection-token`.
public struct POSConnectionToken: Decodable, Sendable { public let secret: String }

/// `PATCH /api/pos/settings`.
public struct POSSettingsPatch: Encodable, Sendable {
    public let posEnabled: Bool
    public init(posEnabled: Bool) { self.posEnabled = posEnabled }
}

/// The body of `POST /api/pos/payment-intents` (sent with an Idempotency-Key).
public struct POSPaymentIntentRequest: Encodable, Sendable {
    public let invoiceId: String
    public let amount: Decimal
    public init(invoiceId: String, amount: Decimal) {
        self.invoiceId = invoiceId
        self.amount = amount
    }
}

/// The PaymentIntent the server made on the owner's Stripe account.
public struct POSCreatedPayment: Decodable, Sendable, Equatable {
    public let id: String
    public let paymentIntentId: String
    public let clientSecret: String
    public let locationId: String?
    public let amountCents: Int
    public let currency: String

    public init(id: String, paymentIntentId: String, clientSecret: String, locationId: String?, amountCents: Int, currency: String) {
        self.id = id
        self.paymentIntentId = paymentIntentId
        self.clientSecret = clientSecret
        self.locationId = locationId
        self.amountCents = amountCents
        self.currency = currency
    }

    public var amount: Decimal { Decimal(amountCents) / 100 }
}

public struct POSCreatedPaymentResponse: Decodable, Sendable { public let payment: POSCreatedPayment }

/// `PosPaymentView` of the contract; amounts in euros.
public struct POSPaymentView: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let invoiceId: String?
    public let status: String
    public let amount: Decimal
    public let refunded: Decimal
    public let cardBrand: String?
    public let cardLast4: String?
    public let createdAt: String
    public let succeededAt: String?

    enum CodingKeys: String, CodingKey { case id, invoiceId, status, amount, refunded, cardBrand, cardLast4, createdAt, succeededAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        invoiceId = try c.decodeIfPresent(String.self, forKey: .invoiceId)
        status = try c.decode(String.self, forKey: .status)
        amount = try c.decodeMoney(.amount)
        refunded = try c.decodeMoneyIfPresent(.refunded) ?? 0
        cardBrand = try c.decodeIfPresent(String.self, forKey: .cardBrand)
        cardLast4 = try c.decodeIfPresent(String.self, forKey: .cardLast4)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        succeededAt = try c.decodeIfPresent(String.self, forKey: .succeededAt)
    }

    public var cardLabel: String? { POSCard.label(brand: cardBrand, last4: cardLast4) }

    /// Only money that was taken and not yet returned can be refunded.
    public var isRefundable: Bool {
        (status == "succeeded" || status == "partially_refunded") && refunded < amount
    }
}

public struct POSPaymentsResponse: Decodable, Sendable { public let payments: [POSPaymentView] }

/// `POST /api/pos/payments/:id/finalize`.
public struct POSFinalizeResponse: Decodable, Sendable {
    public let payment: POSPaymentView
    /// The invoice after booking; read leniently, because the payment's status alone decides
    /// whether the money was recorded (an unreadable invoice must not look like a failure).
    public let invoice: Invoice?

    enum CodingKeys: String, CodingKey { case payment, invoice }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        payment = try c.decode(POSPaymentView.self, forKey: .payment)
        invoice = try? c.decodeIfPresent(Invoice.self, forKey: .invoice)
    }
}

/// `POST /api/pos/payments/:id/refund`; no amount refunds what is left.
public struct POSRefundRequest: Encodable, Sendable {
    public let amount: Decimal?
    public init(amount: Decimal? = nil) { self.amount = amount }

    enum CodingKeys: String, CodingKey { case amount }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let amount { try c.encode(amount, forKey: .amount) }
    }
}

public enum POSCard {
    /// "Visa •••• 4242" from Stripe's brand code and the last four digits.
    public static func label(brand: String?, last4: String?) -> String? {
        let name = brand.flatMap { $0.isEmpty ? nil : brandName($0) }
        let digits = last4.flatMap { $0.isEmpty ? nil : $0 }
        switch (name, digits) {
        case let (name?, digits?): return "\(name) •••• \(digits)"
        case let (nil, digits?): return "Kortti •••• \(digits)"
        case let (name?, nil): return name
        default: return nil
        }
    }

    static func brandName(_ code: String) -> String {
        switch code.lowercased() {
        case "visa": "Visa"
        case "mastercard": "Mastercard"
        case "amex", "american_express": "American Express"
        case "discover": "Discover"
        case "diners": "Diners Club"
        case "jcb": "JCB"
        case "unionpay": "UnionPay"
        case "interac": "Interac"
        case "eftpos_au": "eftpos"
        default: code.prefix(1).uppercased() + code.dropFirst()
        }
    }
}

// MARK: - Readiness

/// What this iPhone build can do: hardware (iPhone XS or newer) and the Tap to Pay entitlement,
/// which only the signed Tap to Pay build carries.
public struct POSDeviceCapability: Sendable, Equatable {
    public let supportsTapToPay: Bool
    public let hasEntitlement: Bool
    public init(supportsTapToPay: Bool, hasEntitlement: Bool) {
        self.supportsTapToPay = supportsTapToPay
        self.hasEntitlement = hasEntitlement
    }
}

/// One step still missing before a card can be charged, in the order the owner fixes them.
public enum POSMissing: String, CaseIterable, Sendable {
    case server, stripeAccount, onboarding, charges, location, posDisabled, deviceSupport, entitlement

    public var title: String {
        switch self {
        case .server: "Korttimaksut eivät ole käytössä palvelimella"
        case .stripeAccount: "Stripe-tiliä ei ole yhdistetty"
        case .onboarding: "Stripe-tilin tiedot ovat kesken"
        case .charges: "Stripe ei ole vielä hyväksynyt korttimaksuja"
        case .location: "Maksupaikka puuttuu"
        case .posDisabled: "Korttimaksut on kytketty pois"
        case .deviceSupport: "Tämä iPhone ei tue Tap to Pay -maksuja"
        case .entitlement: "Tap to Pay -oikeus puuttuu"
        }
    }

    public var detail: String {
        switch self {
        case .server: "Palvelimelle ei ole määritetty Stripe-avainta. Korttimaksut otetaan käyttöön palvelimen asetuksista."
        case .stripeAccount: "Yhdistä yrityksesi oma Stripe-tili kohdassa Asetukset → Maksut. Rahat menevät suoraan sille."
        case .onboarding: "Täydennä yrityksen tiedot Stripessä kohdassa Asetukset → Maksut → Jatka Stripessä."
        case .charges: "Stripe tarkistaa vielä tilin tietoja. Päivitä tila kohdassa Asetukset → Maksut hetken kuluttua."
        case .location: "Maksupaikka luodaan yrityksen osoitteesta, kun päivität Stripen tilan kohdassa Asetukset → Maksut."
        case .posDisabled: "Kytke Korttimaksut käytössä -valinta päälle kohdassa Asetukset → Maksut."
        case .deviceSupport: "Tap to Pay vaatii iPhone XS:n tai uudemman."
        case .entitlement: "Tämä sovellusversio on asennettu ilman Applen Tap to Pay -oikeutta. Asenna allekirjoitettu Tap to Pay -versio."
        }
    }

    /// Whether the Maksut settings screen can fix it (the others need the server or another build).
    public var fixInSettings: Bool {
        switch self {
        case .stripeAccount, .onboarding, .charges, .location, .posDisabled: true
        case .server, .deviceSupport, .entitlement: false
        }
    }
}

public enum POSReadiness {
    /// `testMode`: the owner's Testitila is on. It waives the iPhone's own requirements (the
    /// simulated reader needs neither Tap to Pay hardware nor the entitlement), and only while the
    /// server says its Stripe key is a test key.
    public static func missing(status: POSStatus, device: POSDeviceCapability, testMode: Bool = false) -> [POSMissing] {
        var out: [POSMissing] = []
        if !status.enabled {
            out.append(.server)
        } else if !status.account.connected {
            // Everything after the account follows from connecting it: name the first step only.
            out.append(.stripeAccount)
        } else {
            if !status.account.detailsSubmitted {
                out.append(.onboarding)
            } else if !status.account.chargesEnabled {
                out.append(.charges)
            } else if status.locationId == nil {
                out.append(.location)
            }
            if !status.posEnabled { out.append(.posDisabled) }
        }
        if testMode && status.testMode { return out }
        if !device.supportsTapToPay { out.append(.deviceSupport) }
        if !device.hasEntitlement { out.append(.entitlement) }
        return out
    }

    public static func canTakePayments(status: POSStatus, device: POSDeviceCapability, testMode: Bool = false) -> Bool {
        status.ready && missing(status: status, device: device, testMode: testMode).isEmpty
    }
}

// MARK: - Testitila (simulated reader)

public enum POSTestMode {
    /// Simulation runs only when the server's key is a Stripe test key and the owner turned it on.
    /// With a live key the owner's stored choice is ignored: no money can move through a simulator.
    public static func isActive(status: POSStatus?, ownerEnabled: Bool) -> Bool {
        guard let status else { return false }
        return ownerEnabled && status.enabled && status.testMode
    }

    /// The owner's choice, kept per owner on this device.
    public static func key(userId: String) -> String { "pos.testMode.\(userId)" }
}

/// Which of Stripe's simulated readers carries a test payment.
public enum POSSimulatedReader: String, Sendable, Equatable {
    /// Tried first: the same reader kind as real payments.
    case tapToPay
    /// A simulated Bluetooth WisePad 3, for an install without Tap to Pay (no entitlement, older iPhone).
    case bluetooth

    public var label: String {
        switch self {
        case .tapToPay: "Simuloitu Tap to Pay"
        case .bluetooth: "Simuloitu kortinlukija (WisePad 3)"
        }
    }

    /// Whether a failed simulated Tap to Pay discovery or connect should move on to the simulated
    /// Bluetooth reader. Stripe needs the Tap to Pay entitlement even for its simulator, and which
    /// code a build without it gets is not documented, so every refusal falls back except the
    /// owner's own cancel and a network failure (`SCPErrors.h` codes).
    public static func fallsBackToBluetooth(errorCode: Int) -> Bool {
        if errorCode == POSErrorMapping.Code.canceled { return false }
        if (9000...9099).contains(errorCode) { return false }
        return true
    }
}

/// The card the simulated reader presents (Stripe's `SimulatedCardType`; the App maps each case).
public enum POSTestCard: String, CaseIterable, Sendable, Identifiable {
    case visa, mastercard, declined, insufficientFunds, expired, processingError, offlinePin

    public enum Outcome: Sendable, Equatable { case succeeds, declined, pin }

    public static let defaultCard: POSTestCard = .visa

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .visa: "Onnistuu (Visa)"
        case .mastercard: "Onnistuu (Mastercard)"
        case .declined: "Hylätty"
        case .insufficientFunds: "Hylätty: ei katetta"
        case .expired: "Hylätty: vanhentunut kortti"
        case .processingError: "Käsittelyvirhe"
        case .offlinePin: "Vaatii PIN-koodin"
        }
    }

    public var detail: String {
        switch self {
        case .visa, .mastercard: "Maksu onnistuu ja kirjautuu laskulle."
        case .declined: "Pankki hylkää kortin (card_declined)."
        case .insufficientFunds: "Pankki hylkää kortin: tilillä ei ole katetta."
        case .expired: "Kortti on vanhentunut."
        case .processingError: "Stripe ei pysty käsittelemään korttia."
        case .offlinePin: "Kortti vaatii sirun ja PIN-koodin. Simuloitavissa vain kortinlukijalla (WisePad 3), jossa PIN syötetään ja maksu onnistuu."
        }
    }

    public var outcome: Outcome {
        switch self {
        case .visa, .mastercard: .succeeds
        case .declined, .insufficientFunds, .expired, .processingError: .declined
        case .offlinePin: .pin
        }
    }

    /// Stripe's decline code on the failed charge, where the simulator sets one.
    public var declineCode: String? {
        switch self {
        case .insufficientFunds: "insufficient_funds"
        default: nil
        }
    }

    /// Stripe simulates PIN cards on a WisePad 3 only.
    public func isSupported(on reader: POSSimulatedReader) -> Bool {
        self == .offlinePin ? reader == .bluetooth : true
    }
}

// MARK: - Amount

public enum POSAmountError: Error, Equatable, Sendable {
    case empty, notPositive, tooManyDecimals, overOpen(Decimal), belowMinimum

    public var message: String {
        switch self {
        case .empty: "Anna summa."
        case .notPositive: "Summan on oltava suurempi kuin nolla."
        case .tooManyDecimals: "Summassa voi olla enintään kaksi desimaalia."
        case .overOpen(let open): "Summa on suurempi kuin avoin saldo \(Money.format(open))."
        case .belowMinimum: "Korttimaksun vähimmäissumma on \(Money.format(POSAmount.minimum))."
        }
    }
}

public enum POSAmount {
    /// Stripe's smallest card charge in euros.
    public static let minimum = Decimal(string: "0.50")!

    /// The amount typed for a card payment: at most the invoice's open balance, whole cents.
    public static func validate(_ text: String, open: Decimal) -> Result<Decimal, POSAmountError> {
        guard let amount = Money.parse(text) else { return .failure(.empty) }
        if amount <= 0 { return .failure(.notPositive) }
        if round2(amount) != amount { return .failure(.tooManyDecimals) }
        if amount > open { return .failure(.overOpen(open)) }
        if amount < minimum { return .failure(.belowMinimum) }
        return .success(amount)
    }

    /// "Maksa 105,00 €"
    public static func payLabel(_ amount: Decimal) -> String { "Maksa \(Money.format(amount))" }

    /// The field's starting text: "1234,50" (no grouping, no sign, no €).
    public static func editText(_ amount: Decimal) -> String {
        let cents = cents(amount)
        let whole = cents / 100
        let rest = abs(cents % 100)
        return "\(whole),\(rest < 10 ? "0" : "")\(rest)"
    }

    public static func cents(_ amount: Decimal) -> Int {
        NSDecimalNumber(decimal: round2(amount) * 100).intValue
    }

    static func round2(_ value: Decimal) -> Decimal {
        var input = value
        var output = Decimal()
        NSDecimalRound(&output, &input, 2, .plain)
        return output
    }
}

// MARK: - Failures

public enum POSFailureAction: String, Sendable, Equatable {
    case retry, tryAnotherCard, sendInvoiceByEmail, openSettings

    public var title: String {
        switch self {
        case .retry: "Yritä uudelleen"
        case .tryAnotherCard: "Yritä toisella kortilla"
        case .sendInvoiceByEmail: "Lähetä lasku sähköpostilla"
        case .openSettings: "Avaa maksuasetukset"
        }
    }
}

public struct POSFailure: Sendable, Equatable {
    public enum Kind: String, CaseIterable, Sendable {
        case canceled, declined, offlinePinRequired, cardNotRead, network, passcodeRequired, deviceUnsupported, duringCall,
             termsNotAccepted, iCloudRequired, accountBlocked, locationServices, readerDisconnected, rejected, other
    }

    public let kind: Kind
    public let title: String
    public let message: String
    public let actions: [POSFailureAction]
    /// The card may have been charged (the answer was lost): the next step is to ask the server
    /// about the same PaymentIntent, never to start a new one.
    public let uncertain: Bool

    public static func make(_ kind: Kind, message: String? = nil) -> POSFailure {
        let (title, detail, actions): (String, String, [POSFailureAction]) = switch kind {
        case .canceled:
            ("Maksu peruttiin.", "Korttia ei veloitettu.", [.retry])
        case .declined:
            ("Kortti hylättiin.", "Korttia ei veloitettu. Pyydä asiakkaalta toinen kortti.", [.tryAnotherCard, .sendInvoiceByEmail])
        case .offlinePinRequired:
            ("Korttia ei voitu veloittaa lähimaksulla.",
             "Kortti vaatii PIN-koodin, jota lähimaksu iPhonella ei tue. Korttia ei veloitettu.",
             [.tryAnotherCard, .sendInvoiceByEmail])
        case .cardNotRead:
            ("Korttia ei saatu luettua.", "Pidä kortti iPhonen yläosan päällä, kunnes näkyy valmis.", [.retry])
        case .network:
            ("Yhteys katkesi.", "Maksun tila tarkistetaan samasta maksusta, joten korttia ei veloiteta kahdesti.", [.retry])
        case .passcodeRequired:
            ("iPhonen pääsykoodi puuttuu.", "Tap to Pay vaatii, että iPhonessa on pääsykoodi. Lisää se iPhonen asetuksista.", [.retry])
        case .deviceUnsupported:
            ("Tämä iPhone ei tue Tap to Pay -maksuja.", POSMissing.deviceSupport.detail, [])
        case .duringCall:
            ("Puhelu on käynnissä.", "Lopeta puhelu ja yritä uudelleen.", [.retry])
        case .termsNotAccepted:
            ("Tap to Pay -ehtoja ei hyväksytty.", "Ehdot pitää hyväksyä ennen ensimmäistä maksua.", [.retry])
        case .iCloudRequired:
            ("Kirjaudu iCloudiin.", "Tap to Pay -ehtojen hyväksyminen vaatii Apple ID -kirjautumisen.", [.retry])
        case .accountBlocked:
            ("Tap to Pay ei ole käytössä tällä tilillä.", "Tarkista Stripe-tilin tila Stripen hallintapaneelista.", [.openSettings])
        case .locationServices:
            ("Sijaintipalvelut ovat pois päältä.", "Tap to Pay tarvitsee sijainnin. Salli sijainti LashKirjalle iPhonen asetuksista.", [.retry])
        case .readerDisconnected:
            ("Yhteys maksulukijaan katkesi.", "Yhdistetään uudelleen.", [.retry])
        case .rejected:
            ("Maksua ei voitu aloittaa.", "", [.retry])
        case .other:
            ("Maksu ei onnistunut.", "Korttia ei veloitettu.", [.retry])
        }
        return POSFailure(kind: kind, title: title, message: message ?? detail, actions: actions, uncertain: kind == .network)
    }
}

/// Stripe Terminal's NSError codes (`SCPErrors.h`, SDK 5.8) and decline codes, read as numbers so
/// this stays plain Foundation.
public enum POSErrorMapping {
    public enum Code {
        public static let notConnectedToReader = 1100
        public static let canceled = 2020
        public static let locationServicesDisabled = 2200
        public static let unsupportedMobileDevice = 2910
        public static let passcodeNotEnabled = 2920
        public static let commandNotAllowedDuringCall = 2930
        public static let tosRequiresICloud = 2960
        public static let tosCanceled = 2970
        public static let readerNotAccessibleInBackground = 3900
        public static let tapToPayFailedToPrepare = 3910
        public static let tapToPayDeviceBanned = 3920
        public static let tosNotYetAccepted = 3930
        public static let tosAcceptanceFailed = 3940
        public static let merchantBlocked = 3950
        public static let invalidMerchant = 3960
        public static let accountDeactivated = 3970
        public static let declinedByStripeAPI = 6000
        public static let declinedByReader = 6500
        public static let cardNotSupported = 6510
        public static let notConnectedToInternet = 9000
        public static let requestTimedOut = 9010
        public static let internalNetworkError = 9040
        public static let tapToPayInternalNetworkError = 9041
        public static let tokenProviderError = 9050
        public static let tokenProviderTimedOut = 9052
    }

    /// Decline codes of cards that want a PIN the phone cannot take (offline PIN, common on
    /// Finnish debit cards).
    public static let offlinePinDeclineCodes: Set<String> = ["offline_pin_required", "online_or_offline_pin_required"]

    public static func failure(code: Int, declineCode: String?) -> POSFailure {
        if let declineCode, offlinePinDeclineCodes.contains(declineCode) { return .make(.offlinePinRequired) }
        switch code {
        case Code.canceled: return .make(.canceled)
        case Code.declinedByStripeAPI, Code.declinedByReader, Code.cardNotSupported, 6903: return .make(.declined)
        case 2810...2850: return .make(.cardNotRead)
        case Code.notConnectedToInternet, Code.requestTimedOut, Code.internalNetworkError, Code.tapToPayInternalNetworkError,
             Code.tokenProviderError, 9051, Code.tokenProviderTimedOut:
            return .make(.network)
        case Code.passcodeNotEnabled: return .make(.passcodeRequired)
        case Code.unsupportedMobileDevice, Code.tapToPayDeviceBanned, 2340: return .make(.deviceUnsupported)
        case Code.commandNotAllowedDuringCall: return .make(.duringCall)
        case Code.tosCanceled, Code.tosNotYetAccepted, Code.tosAcceptanceFailed: return .make(.termsNotAccepted)
        case Code.tosRequiresICloud: return .make(.iCloudRequired)
        case Code.merchantBlocked, Code.invalidMerchant, Code.accountDeactivated: return .make(.accountBlocked)
        case Code.locationServicesDisabled: return .make(.locationServices)
        case Code.notConnectedToReader, Code.readerNotAccessibleInBackground, Code.tapToPayFailedToPrepare: return .make(.readerDisconnected)
        default: return .make(.other)
        }
    }
}

// MARK: - Payment state machine

/// What the sheet shows as the result.
public struct POSReceipt: Sendable, Equatable {
    public let amount: Decimal
    public let cardLabel: String?
    public init(amount: Decimal, cardLabel: String?) {
        self.amount = amount
        self.cardLabel = cardLabel
    }
}

public enum POSPaymentPhase: Sendable, Equatable {
    case idle
    case creatingPayment
    case connectingReader
    case readyForCard
    case waitingForCard
    case processing
    case verifyingServer
    /// Stripe charged the card but the server has not confirmed the booking yet (the webhook will).
    case succeeded(POSReceipt)
    /// The server verified the payment with Stripe and recorded it on the invoice.
    case accountingRecorded(POSReceipt)
    case failed(POSFailure)

    public var title: String {
        switch self {
        case .idle: "Tarkista summa"
        case .creatingPayment: "Valmistellaan maksua…"
        case .connectingReader: "Valmistellaan Tap to Pay -maksua…"
        case .readyForCard: "Valmis vastaanottamaan kortin"
        case .waitingForCard: "Vie kortti iPhonen päälle"
        case .processing: "Käsitellään maksua…"
        case .verifyingServer: "Vahvistetaan maksua…"
        case .succeeded: "Maksu veloitettu · kirjaus vahvistuu"
        case .accountingRecorded(let receipt): ["✓ Maksu onnistui", receipt.cardLabel].compactMap { $0 }.joined(separator: " · ")
        case .failed(let failure): failure.title
        }
    }

    public var isBusy: Bool {
        switch self {
        case .creatingPayment, .connectingReader, .readyForCard, .waitingForCard, .processing, .verifyingServer: true
        case .idle, .succeeded, .accountingRecorded, .failed: false
        }
    }
}

/// One card payment for one invoice. Pure: the coordinator feeds it what the server and the
/// reader said and runs the command it hands back.
///
/// The rule it keeps: once a PaymentIntent exists, every retry works on that intent. A lost
/// answer after the card was presented is checked with the server (`finalize`) first, so a
/// customer is never charged twice.
public struct POSPaymentMachine: Sendable {
    public enum Event: Sendable, Equatable {
        case start(amount: Decimal, newKey: String? = nil)
        case paymentCreated(POSCreatedPayment)
        case readerConnected
        case waitingForCard
        case cardRead
        case processed
        /// The server's finalize answer: succeeded (recorded) or not yet (409, still processing).
        case finalized(succeeded: Bool, receipt: POSReceipt?)
        /// The reader says the intent still waits for a card (nothing was charged).
        case notCharged
        /// Charged, but the server could not confirm it after several tries.
        case verificationPending(POSReceipt)
        case failed(POSFailure)
        case retry
        case cancel
        case intentCanceled
    }

    public enum Command: Sendable, Equatable {
        case createPayment(key: String)
        case connectReader
        case process
        case finalize
        case cancelCollection
        case cancelIntent
    }

    /// Where a failure happened decides how to continue.
    enum Stage: Sendable { case none, creating, connecting, collecting, verifying }

    public private(set) var phase: POSPaymentPhase = .idle
    public private(set) var payment: POSCreatedPayment?
    public private(set) var idempotencyKey: String
    public private(set) var amount: Decimal?
    /// The key has been used for a payment that is gone (canceled) or was refused: reusing it would
    /// hand back the same answer, so the next start needs a new key.
    public private(set) var keySpent = false
    private var stage: Stage = .none
    /// A create whose answer was lost: the same key (and so the same amount) must be sent again.
    private var createUncertain = false
    private var cancelRequested = false

    public init(idempotencyKey: String) {
        self.idempotencyKey = idempotencyKey
    }

    public var amountEditable: Bool {
        payment == nil && !createUncertain && !phase.isBusy && !isFinished
    }

    public var isFinished: Bool {
        switch phase {
        case .succeeded, .accountingRecorded: true
        default: false
        }
    }

    /// Only before the card is read: after that the charge may already be on its way.
    public var canCancel: Bool {
        switch phase {
        case .connectingReader, .readyForCard, .waitingForCard: true
        default: false
        }
    }

    public mutating func send(_ event: Event) -> Command? {
        switch event {
        case .start(let amount, let newKey):
            guard amountEditable else { return nil }
            if let newKey {
                idempotencyKey = newKey
                keySpent = false
            }
            self.amount = amount
            stage = .creating
            phase = .creatingPayment
            cancelRequested = false
            return .createPayment(key: idempotencyKey)

        // Each answer counts only in the phase that asked for it: a reader that finishes
        // connecting after the owner canceled must not start collecting.
        case .paymentCreated(let created):
            guard phase == .creatingPayment else { return nil }
            payment = created
            createUncertain = false
            stage = .connecting
            phase = .connectingReader
            return .connectReader

        case .readerConnected:
            guard payment != nil, phase == .connectingReader else { return nil }
            stage = .collecting
            phase = .readyForCard
            return .process

        case .waitingForCard:
            guard phase == .readyForCard || phase == .waitingForCard else { return nil }
            phase = .waitingForCard
            return nil

        case .cardRead:
            guard phase == .readyForCard || phase == .waitingForCard else { return nil }
            stage = .collecting
            phase = .processing
            return nil

        case .processed:
            guard [.readyForCard, .waitingForCard, .processing].contains(phase) else { return nil }
            stage = .verifying
            phase = .verifyingServer
            return .finalize

        case .finalized(let succeeded, let receipt):
            guard phase == .verifyingServer else { return nil }
            if succeeded {
                phase = .accountingRecorded(receipt ?? POSReceipt(amount: payment?.amount ?? amount ?? 0, cardLabel: nil))
                return nil
            }
            stage = .verifying
            phase = .verifyingServer
            return .finalize

        case .notCharged:
            guard payment != nil, phase == .verifyingServer else { return nil }
            stage = .collecting
            phase = .readyForCard
            return .process

        case .verificationPending(let receipt):
            guard phase == .verifyingServer else { return nil }
            stage = .verifying
            phase = .succeeded(receipt)
            return nil

        case .failed(let failure):
            return fail(failure)

        case .retry:
            return retry()

        case .cancel:
            guard canCancel else { return nil }
            cancelRequested = true
            return .cancelCollection

        case .intentCanceled:
            payment = nil
            amount = nil
            keySpent = true
            stage = .none
            phase = .idle
            return nil
        }
    }

    private mutating func fail(_ failure: POSFailure) -> Command? {
        if failure.kind == .canceled {
            cancelRequested = false
            // A canceled collection charged nothing: drop the intent so a fresh start is clean.
            if payment != nil, stage != .verifying {
                phase = .idle
                return .cancelIntent
            }
            if stage == .creating && !createUncertain { phase = .idle; return nil }
        }
        switch stage {
        case .creating:
            if failure.uncertain {
                createUncertain = true
            } else {
                // Refused by the server: nothing was made, the owner may change the amount.
                createUncertain = false
                keySpent = true
            }
        case .none, .connecting, .collecting, .verifying:
            break
        }
        phase = .failed(failure)
        return nil
    }

    private mutating func retry() -> Command? {
        switch phase {
        case .failed, .succeeded: break
        default: return nil
        }
        guard let failure = currentFailure ?? (isFinished ? POSFailure.make(.network) : nil) else { return nil }
        switch stage {
        case .none:
            phase = .idle
            return nil
        case .creating:
            phase = .creatingPayment
            return .createPayment(key: idempotencyKey)
        case .connecting:
            phase = .connectingReader
            return .connectReader
        case .collecting:
            if failure.uncertain {
                phase = .verifyingServer
                stage = .verifying
                return .finalize
            }
            if failure.kind == .readerDisconnected {
                stage = .connecting
                phase = .connectingReader
                return .connectReader
            }
            phase = .readyForCard
            return .process
        case .verifying:
            phase = .verifyingServer
            return .finalize
        }
    }

    private var currentFailure: POSFailure? {
        if case .failed(let failure) = phase { return failure }
        return nil
    }
}

// MARK: - Readers and education

/// The reader kinds the payment code is shaped for; v1 ships Tap to Pay only.
public enum POSReaderKind: String, CaseIterable, Sendable {
    case tapToPay, wisePad3, smartReader

    public var availableInV1: Bool { self == .tapToPay }

    public var label: String {
        switch self {
        case .tapToPay: "Tap to Pay iPhonella"
        case .wisePad3: "BBPOS WisePad 3"
        case .smartReader: "Stripe-älylukija"
        }
    }
}

/// Apple wants merchants shown how to accept a tap before their first payment; remembered per owner.
public enum POSEducation {
    public static func key(userId: String) -> String { "pos.howToTap.shown.\(userId)" }
}
