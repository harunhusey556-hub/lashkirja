import Testing
import Foundation
@testable import LashKirjaCore

// Testitila: Stripe's simulated reader and test cards, only behind a server Stripe test key.

private func readyStatus(testMode: Bool, enabled: Bool = true, posEnabled: Bool = true) -> POSStatus {
    POSStatus(enabled: enabled,
              account: .init(connected: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true),
              locationId: "tml_1", posEnabled: posEnabled, ready: enabled && posEnabled, testMode: testMode)
}

private let freeSignedPhone = POSDeviceCapability(supportsTapToPay: true, hasEntitlement: false)
private let oldPhone = POSDeviceCapability(supportsTapToPay: false, hasEntitlement: false)

@Test func posStatusDecodesTestModeAndDefaultsToFalse() throws {
    let withFlag = #"{"enabled":true,"locationId":null,"posEnabled":false,"ready":false,"testMode":true}"#
    #expect(try JSONDecoder().decode(POSStatusEnvelope.self, from: Data(withFlag.utf8)).status.testMode)
    let older = #"{"enabled":true,"locationId":null,"posEnabled":false,"ready":false}"#
    #expect(!(try JSONDecoder().decode(POSStatusEnvelope.self, from: Data(older.utf8)).status.testMode))
    #expect(!POSStatus.unavailable.testMode)
}

@Test func posTestModeNeedsTheServerTestKeyAndTheOwnersChoice() {
    #expect(POSTestMode.isActive(status: readyStatus(testMode: true), ownerEnabled: true))
    #expect(!POSTestMode.isActive(status: readyStatus(testMode: true), ownerEnabled: false))
    // A live key: the owner's stored choice is ignored.
    #expect(!POSTestMode.isActive(status: readyStatus(testMode: false), ownerEnabled: true))
    #expect(!POSTestMode.isActive(status: readyStatus(testMode: true, enabled: false), ownerEnabled: true))
    #expect(!POSTestMode.isActive(status: nil, ownerEnabled: true))
}

@Test func posTestModeKeyIsPerOwner() {
    #expect(POSTestMode.key(userId: "u1") != POSTestMode.key(userId: "u2"))
    #expect(POSTestMode.key(userId: "u1") != POSEducation.key(userId: "u1"))
}

@Test func posReadinessInTestModeSkipsOnlyTheDeviceRequirements() {
    let status = readyStatus(testMode: true)
    #expect(POSReadiness.missing(status: status, device: freeSignedPhone) == [.entitlement])
    #expect(POSReadiness.missing(status: status, device: freeSignedPhone, testMode: true).isEmpty)
    #expect(POSReadiness.missing(status: status, device: oldPhone, testMode: true).isEmpty)
    #expect(POSReadiness.canTakePayments(status: status, device: freeSignedPhone, testMode: true))
    #expect(!POSReadiness.canTakePayments(status: status, device: freeSignedPhone))
    // The account and the switch still count.
    #expect(POSReadiness.missing(status: readyStatus(testMode: true, posEnabled: false), device: oldPhone, testMode: true) == [.posDisabled])
}

@Test func posReadinessNeverSkipsDeviceChecksForALiveKey() {
    let live = readyStatus(testMode: false)
    #expect(POSReadiness.missing(status: live, device: freeSignedPhone, testMode: true) == [.entitlement])
    #expect(!POSReadiness.canTakePayments(status: live, device: oldPhone, testMode: true))
}

@Test func posSimulatedReaderFallsBackUnlessCanceledOrOffline() {
    // Without the Tap to Pay entitlement (a free-account install) Stripe refuses the simulated Tap to
    // Pay reader; the exact code is not documented, so any refusal falls back to the Bluetooth simulator.
    for code in [2900, 2910, 2920, 2960, 3910, 3920, 3930, 3940, 3960, 1100, 5000] {
        #expect(POSSimulatedReader.fallsBackToBluetooth(errorCode: code), "code \(code)")
    }
    // The owner canceled, or the network is down: changing readers would not help.
    for code in [2020, 9000, 9010, 9040, 9041, 9050, 9051, 9052] {
        #expect(!POSSimulatedReader.fallsBackToBluetooth(errorCode: code), "code \(code)")
    }
    #expect(POSSimulatedReader.tapToPay.label == "Simuloitu Tap to Pay")
    #expect(POSSimulatedReader.bluetooth.label == "Simuloitu kortinlukija (WisePad 3)")
}

@Test func posTestCardsCoverTheMainScenarios() {
    #expect(POSTestCard.defaultCard == .visa)
    #expect(POSTestCard.visa.title == "Onnistuu (Visa)")
    #expect(POSTestCard.declined.title == "Hylätty")
    #expect(POSTestCard.offlinePin.title == "Vaatii PIN-koodin")
    #expect(POSTestCard.visa.outcome == .succeeds)
    #expect(POSTestCard.mastercard.outcome == .succeeds)
    #expect(POSTestCard.declined.outcome == .declined)
    #expect(POSTestCard.insufficientFunds.outcome == .declined)
    #expect(POSTestCard.expired.outcome == .declined)
    #expect(POSTestCard.offlinePin.outcome == .pin)
    for card in POSTestCard.allCases {
        #expect(!card.title.isEmpty)
        #expect(!card.detail.isEmpty)
    }
}

@Test func posTestCardsKnowWhichSimulatedReaderSupportsThem() {
    // Stripe simulates PIN cards on a WisePad 3 only.
    #expect(POSTestCard.offlinePin.isSupported(on: .bluetooth))
    #expect(!POSTestCard.offlinePin.isSupported(on: .tapToPay))
    for card in POSTestCard.allCases where card != .offlinePin {
        #expect(card.isSupported(on: .tapToPay))
        #expect(card.isSupported(on: .bluetooth))
    }
}

@Test func posTestCardDeclinesMapToTheDeclinedFailure() {
    // The simulator's decline arrives as an ordinary Stripe decline: the same Finnish text as a real one.
    let failure = POSErrorMapping.failure(code: POSErrorMapping.Code.declinedByStripeAPI, declineCode: "insufficient_funds")
    #expect(failure.kind == .declined)
    #expect(POSTestCard.insufficientFunds.declineCode == "insufficient_funds")
    #expect(POSTestCard.visa.declineCode == nil)
}
