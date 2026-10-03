import Testing
import Foundation
@testable import LashKirjaCore

// MARK: - API models

@Test func posStatusDecodesContractShape() throws {
    let json = """
    {"enabled":true,"account":{"connected":true,"chargesEnabled":true,"payoutsEnabled":false,"detailsSubmitted":true},
     "locationId":"tml_123","posEnabled":true,"ready":true}
    """
    let status = try JSONDecoder().decode(POSStatus.self, from: Data(json.utf8))
    #expect(status.enabled)
    #expect(status.account.connected)
    #expect(status.account.chargesEnabled)
    #expect(!status.account.payoutsEnabled)
    #expect(status.locationId == "tml_123")
    #expect(status.posEnabled)
    #expect(status.ready)
    #expect(status.dashboardUrl == nil)
}

@Test func posStatusDecodesWrappedAndMissingAccount() throws {
    let wrapped = #"{"status":{"enabled":false,"locationId":null,"posEnabled":false,"ready":false}}"#
    let status = try JSONDecoder().decode(POSStatusEnvelope.self, from: Data(wrapped.utf8)).status
    #expect(!status.enabled)
    #expect(!status.account.connected)
    let bare = #"{"enabled":true,"account":{"connected":false,"chargesEnabled":false,"payoutsEnabled":false,"detailsSubmitted":false},"locationId":null,"posEnabled":false,"ready":false}"#
    #expect(try JSONDecoder().decode(POSStatusEnvelope.self, from: Data(bare.utf8)).status.enabled)
}

@Test func posCreatedPaymentDecodes() throws {
    let json = """
    {"payment":{"id":"pp_1","paymentIntentId":"pi_1","clientSecret":"pi_1_secret_x","locationId":"tml_1","amountCents":10500,"currency":"eur"}}
    """
    let created = try JSONDecoder().decode(POSCreatedPaymentResponse.self, from: Data(json.utf8)).payment
    #expect(created.id == "pp_1")
    #expect(created.paymentIntentId == "pi_1")
    #expect(created.clientSecret == "pi_1_secret_x")
    #expect(created.amountCents == 10500)
    #expect(created.amount == Decimal(string: "105")!)
}

@Test func posPaymentViewDecodesAndLabelsCard() throws {
    let json = """
    {"id":"pp_1","invoiceId":"inv_1","status":"succeeded","amount":105.5,"refunded":0,"cardBrand":"visa","cardLast4":"4242",
     "createdAt":"2026-10-03T10:00:00.000Z","succeededAt":"2026-10-03T10:00:09.000Z"}
    """
    let view = try JSONDecoder().decode(POSPaymentView.self, from: Data(json.utf8))
    #expect(view.amount == Decimal(string: "105.5")!)
    #expect(view.refunded == 0)
    #expect(view.cardLabel == "Visa •••• 4242")
    #expect(view.isRefundable)
    let minimal = try JSONDecoder().decode(POSPaymentView.self, from: Data(#"{"id":"pp_2","status":"refunded","amount":10,"refunded":10,"createdAt":"x"}"#.utf8))
    #expect(minimal.cardLabel == nil)
    #expect(!minimal.isRefundable)
}

@Test func posCardLabelBrands() {
    #expect(POSCard.label(brand: "mastercard", last4: "0005") == "Mastercard •••• 0005")
    #expect(POSCard.label(brand: "amex", last4: "1000") == "American Express •••• 1000")
    #expect(POSCard.label(brand: nil, last4: "1234") == "Kortti •••• 1234")
    #expect(POSCard.label(brand: "visa", last4: nil) == "Visa")
    #expect(POSCard.label(brand: nil, last4: nil) == nil)
}

@Test func posPaymentIntentRequestEncodesAmountAsNumber() throws {
    let body = POSPaymentIntentRequest(invoiceId: "inv_1", amount: Decimal(string: "105.50")!)
    let json = String(data: try JSONEncoder().encode(body), encoding: .utf8)!
    #expect(json.contains("\"invoiceId\":\"inv_1\""))
    #expect(json.contains("\"amount\":105.5"))
}

@Test func invoicePaymentDecodesOptionalPosFields() throws {
    let card = #"{"id":"p1","paidDate":"2026-10-03","amount":105,"source":"stripe_terminal","transactionId":null,"note":null,"posPaymentId":"pp_1"}"#
    let payment = try JSONDecoder().decode(Invoice.Payment.self, from: Data(card.utf8))
    #expect(payment.isCardPayment)
    #expect(payment.posPaymentId == "pp_1")
    let old = #"{"id":"p2","paidDate":"2026-10-03","amount":5,"transactionId":null,"note":null}"#
    let manual = try JSONDecoder().decode(Invoice.Payment.self, from: Data(old.utf8))
    #expect(manual.source == "manual")
    #expect(!manual.isCardPayment)
}

// MARK: - Readiness

private func status(enabled: Bool = true, connected: Bool = true, details: Bool = true, charges: Bool = true,
                    location: String? = "tml_1", posEnabled: Bool = true) -> POSStatus {
    POSStatus(enabled: enabled,
              account: .init(connected: connected, chargesEnabled: charges, payoutsEnabled: charges, detailsSubmitted: details),
              locationId: location, posEnabled: posEnabled,
              ready: enabled && charges && location != nil && posEnabled)
}

@Test func posReadinessAllMet() {
    let device = POSDeviceCapability(supportsTapToPay: true, hasEntitlement: true)
    #expect(POSReadiness.missing(status: status(), device: device).isEmpty)
    #expect(POSReadiness.canTakePayments(status: status(), device: device))
}

@Test func posReadinessNamesEachMissingStep() {
    let device = POSDeviceCapability(supportsTapToPay: true, hasEntitlement: true)
    #expect(POSReadiness.missing(status: status(enabled: false), device: device) == [.server])
    #expect(POSReadiness.missing(status: status(connected: false, details: false, charges: false, location: nil, posEnabled: false), device: device).first == .stripeAccount)
    #expect(POSReadiness.missing(status: status(details: false, charges: false), device: device).contains(.onboarding))
    #expect(POSReadiness.missing(status: status(charges: false), device: device) == [.charges])
    #expect(POSReadiness.missing(status: status(location: nil), device: device) == [.location])
    #expect(POSReadiness.missing(status: status(posEnabled: false), device: device) == [.posDisabled])
    #expect(POSReadiness.missing(status: status(), device: .init(supportsTapToPay: false, hasEntitlement: true)) == [.deviceSupport])
    #expect(POSReadiness.missing(status: status(), device: .init(supportsTapToPay: true, hasEntitlement: false)) == [.entitlement])
}

@Test func posReadinessTextIsFinnishAndSaysWhereToFix() {
    #expect(POSMissing.server.title == "Korttimaksut eivät ole käytössä palvelimella")
    #expect(!POSMissing.server.fixInSettings)
    #expect(POSMissing.stripeAccount.title == "Stripe-tiliä ei ole yhdistetty")
    #expect(POSMissing.stripeAccount.fixInSettings)
    #expect(POSMissing.posDisabled.fixInSettings)
    #expect(!POSMissing.deviceSupport.fixInSettings)
    #expect(POSMissing.entitlement.detail.contains("Tap to Pay"))
    for item in POSMissing.allCases {
        #expect(!item.title.isEmpty)
        #expect(!item.detail.isEmpty)
    }
}

// MARK: - Amount

@Test func posAmountParsesFinnishInput() {
    #expect(POSAmount.validate("105,00", open: 105) == .success(Decimal(105)))
    #expect(POSAmount.validate("1 234,5", open: 2000) == .success(Decimal(string: "1234.5")!))
    #expect(POSAmount.validate("50.25 €", open: 105) == .success(Decimal(string: "50.25")!))
}

@Test func posAmountRejectsBadInput() {
    #expect(POSAmount.validate("", open: 105) == .failure(.empty))
    #expect(POSAmount.validate("abc", open: 105) == .failure(.empty))
    #expect(POSAmount.validate("0", open: 105) == .failure(.notPositive))
    #expect(POSAmount.validate("-5", open: 105) == .failure(.notPositive))
    #expect(POSAmount.validate("10,555", open: 105) == .failure(.tooManyDecimals))
    #expect(POSAmount.validate("105,01", open: 105) == .failure(.overOpen(105)))
    #expect(POSAmount.validate("0,49", open: 105) == .failure(.belowMinimum))
}

@Test func posAmountMessagesAndLabels() {
    #expect(POSAmountError.empty.message == "Anna summa.")
    #expect(POSAmountError.tooManyDecimals.message == "Summassa voi olla enintään kaksi desimaalia.")
    #expect(POSAmountError.overOpen(105).message == "Summa on suurempi kuin avoin saldo 105,00\u{00A0}€.")
    #expect(POSAmountError.belowMinimum.message == "Korttimaksun vähimmäissumma on 0,50\u{00A0}€.")
    #expect(POSAmount.payLabel(Decimal(105)) == "Maksa 105,00\u{00A0}€")
    #expect(POSAmount.editText(Decimal(string: "1234.5")!) == "1234,50")
    #expect(POSAmount.cents(Decimal(string: "105.5")!) == 10550)
}

// MARK: - Error mapping

@Test func posErrorMapsOfflinePinOnlyCards() {
    for code in ["offline_pin_required", "online_or_offline_pin_required"] {
        let failure = POSErrorMapping.failure(code: POSErrorMapping.Code.declinedByStripeAPI, declineCode: code)
        #expect(failure.kind == .offlinePinRequired)
        #expect(failure.title == "Korttia ei voitu veloittaa lähimaksulla.")
        #expect(failure.actions == [.tryAnotherCard, .sendInvoiceByEmail])
        #expect(failure.actions.map(\.title) == ["Yritä toisella kortilla", "Lähetä lasku sähköpostilla"])
        #expect(!failure.uncertain)
    }
}

@Test func posErrorMapsCancelDeclineAndNetwork() {
    #expect(POSErrorMapping.failure(code: POSErrorMapping.Code.canceled, declineCode: nil).kind == .canceled)
    let declined = POSErrorMapping.failure(code: POSErrorMapping.Code.declinedByStripeAPI, declineCode: "insufficient_funds")
    #expect(declined.kind == .declined)
    #expect(declined.actions.contains(.tryAnotherCard))
    #expect(!declined.uncertain)
    #expect(POSErrorMapping.failure(code: POSErrorMapping.Code.declinedByReader, declineCode: nil).kind == .declined)
    let network = POSErrorMapping.failure(code: POSErrorMapping.Code.requestTimedOut, declineCode: nil)
    #expect(network.kind == .network)
    #expect(network.uncertain)
    #expect(network.actions.first == .retry)
    #expect(POSErrorMapping.failure(code: POSErrorMapping.Code.notConnectedToInternet, declineCode: nil).kind == .network)
}

@Test func posErrorMapsDeviceAndAccountProblems() {
    #expect(POSErrorMapping.failure(code: 2920, declineCode: nil).kind == .passcodeRequired)
    #expect(POSErrorMapping.failure(code: 2910, declineCode: nil).kind == .deviceUnsupported)
    #expect(POSErrorMapping.failure(code: 2930, declineCode: nil).kind == .duringCall)
    #expect(POSErrorMapping.failure(code: 2970, declineCode: nil).kind == .termsNotAccepted)
    #expect(POSErrorMapping.failure(code: 2960, declineCode: nil).kind == .iCloudRequired)
    #expect(POSErrorMapping.failure(code: 3950, declineCode: nil).kind == .accountBlocked)
    #expect(POSErrorMapping.failure(code: 2200, declineCode: nil).kind == .locationServices)
    #expect(POSErrorMapping.failure(code: 1100, declineCode: nil).kind == .readerDisconnected)
    let other = POSErrorMapping.failure(code: 5000, declineCode: nil)
    #expect(other.kind == .other)
    #expect(other.actions.contains(.retry))
    for kind in POSFailure.Kind.allCases where kind != .canceled {
        #expect(!POSFailure.make(kind).title.isEmpty)
    }
}

// MARK: - Payment state machine

private let created = POSCreatedPayment(id: "pp_1", paymentIntentId: "pi_1", clientSecret: "pi_1_secret", locationId: "tml_1", amountCents: 10500, currency: "eur")
private let receipt = POSReceipt(amount: 105, cardLabel: "Visa •••• 4242")

@Test func posMachineHappyPath() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    #expect(m.phase == .idle)
    #expect(m.amountEditable)
    #expect(m.send(.start(amount: 105)) == .createPayment(key: "k1"))
    #expect(m.phase == .creatingPayment)
    #expect(!m.amountEditable)
    #expect(m.send(.paymentCreated(created)) == .connectReader)
    #expect(m.phase == .connectingReader)
    #expect(m.send(.readerConnected) == .process)
    #expect(m.phase == .readyForCard)
    #expect(m.send(.waitingForCard) == nil)
    #expect(m.phase == .waitingForCard)
    #expect(m.send(.cardRead) == nil)
    #expect(m.phase == .processing)
    #expect(m.send(.processed) == .finalize)
    #expect(m.phase == .verifyingServer)
    #expect(m.send(.finalized(succeeded: true, receipt: receipt)) == nil)
    #expect(m.phase == .accountingRecorded(receipt))
    #expect(m.isFinished)
    #expect(m.payment == created)
}

@Test func posMachineDeclineRetriesSameIntentWithAnotherCard() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.cardRead)
    let declined = POSErrorMapping.failure(code: POSErrorMapping.Code.declinedByStripeAPI, declineCode: "generic_decline")
    #expect(m.send(.failed(declined)) == nil)
    #expect(m.phase == .failed(declined))
    // The intent stays: another card is collected on the same PaymentIntent.
    #expect(m.send(.retry) == .process)
    #expect(m.payment == created)
    #expect(m.phase == .readyForCard)
}

@Test func posMachineUncertainFailureNeverCreatesNewIntent() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.cardRead)
    let network = POSErrorMapping.failure(code: POSErrorMapping.Code.requestTimedOut, declineCode: nil)
    _ = m.send(.failed(network))
    // The card may have been charged: ask the server first, on the same intent.
    #expect(m.send(.retry) == .finalize)
    #expect(m.phase == .verifyingServer)
    // The server answers "not succeeded yet" (409): keep checking the same intent, no new one.
    #expect(m.send(.finalized(succeeded: false, receipt: nil)) == .finalize)
    #expect(m.phase == .verifyingServer)
    #expect(m.payment == created)
}

@Test func posMachineUncertainCreateRetriesWithSameKey() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    let network = POSErrorMapping.failure(code: POSErrorMapping.Code.notConnectedToInternet, declineCode: nil)
    _ = m.send(.failed(network))
    #expect(!m.amountEditable) // the same key must keep the same amount
    #expect(m.send(.retry) == .createPayment(key: "k1"))
}

@Test func posMachineRejectedCreateAllowsNewAmountAndKey() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    let refused = POSFailure.make(.rejected, message: "Summa ylittää avoimen saldon.")
    _ = m.send(.failed(refused))
    #expect(m.amountEditable)
    #expect(m.send(.start(amount: 50, newKey: "k2")) == .createPayment(key: "k2"))
}

@Test func posMachineFinalizeAfterProcessingFailsRetriesFinalize() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.cardRead)
    _ = m.send(.processed)
    let network = POSErrorMapping.failure(code: POSErrorMapping.Code.requestTimedOut, declineCode: nil)
    _ = m.send(.failed(network))
    #expect(m.send(.retry) == .finalize)
}

@Test func posMachineChargedButUnverifiedEndsSucceeded() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.cardRead)
    _ = m.send(.processed)
    #expect(m.send(.verificationPending(receipt)) == nil)
    #expect(m.phase == .succeeded(receipt))
    #expect(m.isFinished)
    #expect(m.send(.retry) == .finalize)
}

@Test func posMachineCancelBeforeChargeCancelsIntent() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.waitingForCard)
    #expect(m.canCancel)
    #expect(m.send(.cancel) == .cancelCollection)
    #expect(m.send(.failed(POSFailure.make(.canceled))) == .cancelIntent)
    #expect(m.send(.intentCanceled) == nil)
    #expect(m.phase == .idle)
    #expect(m.payment == nil)
    #expect(m.amountEditable)
}

@Test func posMachineNoCancelWhileProcessingOrVerifying() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.cardRead)
    #expect(!m.canCancel)
    #expect(m.send(.cancel) == nil)
    #expect(m.phase == .processing)
    _ = m.send(.processed)
    #expect(!m.canCancel)
}

@Test func posMachineReaderLostDuringConnectRetriesConnection() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.failed(POSErrorMapping.failure(code: 1100, declineCode: nil)))
    #expect(m.send(.retry) == .connectReader)
    #expect(m.phase == .connectingReader)
}

@Test func posPhaseFinnishCopy() {
    #expect(POSPaymentPhase.waitingForCard.title == "Vie kortti iPhonen päälle")
    #expect(POSPaymentPhase.creatingPayment.title == "Valmistellaan maksua…")
    #expect(POSPaymentPhase.verifyingServer.title == "Vahvistetaan maksua…")
    #expect(POSPaymentPhase.accountingRecorded(receipt).title == "✓ Maksu onnistui · Visa •••• 4242")
    #expect(POSPaymentPhase.accountingRecorded(POSReceipt(amount: 5, cardLabel: nil)).title == "✓ Maksu onnistui")
    #expect(POSPaymentPhase.processing.isBusy)
    #expect(!POSPaymentPhase.idle.isBusy)
}

@Test func posReaderKindsOnlyTapToPayInV1() {
    #expect(POSReaderKind.allCases.filter(\.availableInV1) == [.tapToPay])
    #expect(POSReaderKind.tapToPay.label == "Tap to Pay iPhonella")
}

@Test func posEducationKeyIsPerUser() {
    #expect(POSEducation.key(userId: "u1") != POSEducation.key(userId: "u2"))
}

@Test func posMachineUncertainButNotChargedCollectsAgainOnSameIntent() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.cardRead)
    _ = m.send(.failed(POSErrorMapping.failure(code: POSErrorMapping.Code.requestTimedOut, declineCode: nil)))
    #expect(m.send(.retry) == .finalize)
    #expect(m.send(.finalized(succeeded: false, receipt: nil)) == .finalize)
    // The SDK reads the intent as still waiting for a card: collect again, same intent.
    #expect(m.send(.notCharged) == .process)
    #expect(m.phase == .readyForCard)
    #expect(m.payment == created)
}

@Test func posMachineKeyIsSpentAfterCancelOrRejection() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    #expect(!m.keySpent)
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    _ = m.send(.readerConnected)
    _ = m.send(.cancel)
    _ = m.send(.failed(POSFailure.make(.canceled)))
    _ = m.send(.intentCanceled)
    // The old key would hand back the canceled intent: a new payment needs a new key.
    #expect(m.keySpent)
    #expect(m.send(.start(amount: 105, newKey: "k2")) == .createPayment(key: "k2"))
    #expect(!m.keySpent)
}

@Test func posCardNotReadIsNotUncertain() {
    let failure = POSErrorMapping.failure(code: 2830, declineCode: nil)
    #expect(failure.kind == .cardNotRead)
    #expect(!failure.uncertain)
    #expect(failure.actions.first == .retry)
}

@Test func posMachineIgnoresLateAnswersAfterCancel() {
    var m = POSPaymentMachine(idempotencyKey: "k1")
    _ = m.send(.start(amount: 105))
    _ = m.send(.paymentCreated(created))
    #expect(m.send(.cancel) == .cancelCollection)
    #expect(m.send(.failed(POSFailure.make(.canceled))) == .cancelIntent)
    // The connect that was already under way finishes now: it must not start collecting.
    #expect(m.send(.readerConnected) == nil)
    #expect(m.send(.processed) == nil)
    #expect(m.send(.finalized(succeeded: true, receipt: receipt)) == nil)
    #expect(m.phase == .idle)
}

@Test func posFinalizeReadsThePaymentEvenWithoutAnInvoice() throws {
    let json = #"{"payment":{"id":"pp_1","invoiceId":null,"status":"succeeded","amount":105,"refunded":0,"createdAt":"x"},"invoice":null}"#
    let response = try JSONDecoder().decode(POSFinalizeResponse.self, from: Data(json.utf8))
    #expect(response.payment.status == "succeeded")
    #expect(response.invoice == nil)
}
