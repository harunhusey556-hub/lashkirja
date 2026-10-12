import XCTest
import LashKirjaCore
@testable import LashKirja

/// W22 (owner, 2026-10-12): going back from the form, or closing "Lisää kuitti", threw the other
/// files away. The queue now lives in `CaptureQueueModel` and only the edited form is ever dropped.
@MainActor
final class CaptureQueueModelTests: XCTestCase {
    private func reading(_ id: String) -> UnfinishedReading {
        var draft = ReceiptDraft(uploadId: "u-\(id)")
        draft.vendor = "K-Market"
        return UnfinishedReading(id: id, name: "\(id).jpg", draft: draft, readAt: Date(), previewName: nil)
    }

    private func modelWithThreeReadings() -> CaptureQueueModel {
        let model = CaptureQueueModel()
        model.restore(["a", "b", "c"].map { reading($0) })
        return model
    }

    func testBackFromTheFormKeepsEveryRow() throws {
        let model = modelWithThreeReadings()
        let row = try XCTUnwrap(model.queue.row("b"))
        model.openForm(row)
        XCTAssertTrue(model.editing)
        model.leaveForm()
        XCTAssertFalse(model.editing)
        guard case .queue = model.step else { return XCTFail("back from the form lands on the queue") }
        XCTAssertEqual(model.queue.rows.map(\.id), ["a", "b", "c"])
        XCTAssertTrue(model.queue.rows.allSatisfy { $0.status == .ready && $0.draft != nil })
    }

    func testClosingTheScreenKeepsTheQueue() throws {
        let model = modelWithThreeReadings()
        model.openForm(try XCTUnwrap(model.queue.row("a")))
        model.screenClosed()
        XCTAssertEqual(model.queue.rows.count, 3)
        XCTAssertEqual(model.unfinishedCount, 3)
        // Reopened later (Kuitit's "Jatka"): the queue, not the form left open.
        guard case .queue = model.step else { return XCTFail("a closed screen reopens on the queue") }
    }

    func testDiscardingTheUnsavedIsTheOwnersChoiceOnly() {
        let model = modelWithThreeReadings()
        model.discardUnsaved()
        XCTAssertTrue(model.queue.rows.isEmpty)
        XCTAssertEqual(model.unfinishedCount, 0)
        guard case .pick = model.step else { return XCTFail("an empty queue starts over") }
    }

    func testABankRowMatchEndsWithItsScreen() {
        let model = CaptureQueueModel(transactionId: "t1")
        model.restore([reading("a")])
        model.screenClosed()
        XCTAssertTrue(model.queue.rows.isEmpty)
    }

    // W23: a bill saved from the form is said aloud and its screen stays until "Valmis".
    func testABillSavedFromTheFormKeepsTheScreenAndSaysSo() throws {
        let model = CaptureQueueModel()
        model.restore([reading("a")])
        model.openForm(try XCTUnwrap(model.queue.row("a")))
        model.saved("a", autoApproved: true, invoiceNote: "ostolasku luotu, eräpäivä 14.10.2026")
        XCTAssertFalse(model.closeRequested)
        XCTAssertEqual(model.notice, "Tallennettu · ostolasku luotu, eräpäivä 14.10.2026")
        XCTAssertEqual(model.queue.row("a")?.outcomeText, "Hyväksytty automaattisesti · ostolasku luotu, eräpäivä 14.10.2026")
        guard case .queue = model.step else { return XCTFail("the saved row is shown on the queue") }
        model.screenClosed()
        XCTAssertNil(model.notice)
    }

    func testAPlainLastSaveStillClosesTheScreen() throws {
        let model = CaptureQueueModel()
        model.restore([reading("a")])
        model.openForm(try XCTUnwrap(model.queue.row("a")))
        model.saved("a", autoApproved: true)
        XCTAssertTrue(model.closeRequested)
        XCTAssertNil(model.notice)
    }
}
