import XCTest
import LashKirjaCore
@testable import LashKirja

/// Owner 2026-10-23 (beta audit S6): a deleted receipt leaves the lists at once, and the server is
/// asked only when "Kumoa" has lapsed. The six seconds are not waited for here: the tests end the
/// window as the app going to the background does.
@MainActor
final class ReceiptDeleteUndoTests: XCTestCase {
    private final class Sends {
        var first = 0
        var second = 0
    }

    private func makeApp() -> AppModel {
        AppModel(baseURL: URL(string: "http://127.0.0.1:9")!, store: InMemoryTokenStore(), resources: ResourceCache())
    }

    private func spin(until done: () -> Bool, timeout: TimeInterval = 5) {
        let end = Date().addingTimeInterval(timeout)
        while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    }

    func testKumoaBringsTheRowsBackAndTheServerIsNeverAsked() {
        let app = makeApp()
        let sends = Sends()
        app.deleteWithUndo(["r1"]) { sends.first += 1; return ReceiptDeleteOutcome(deleted: 1) }
        XCTAssertTrue(app.removedIds.contains("r1"), "the receipt stayed on the lists")
        XCTAssertEqual(app.receiptDelete.waiting?.ids, ["r1"])

        app.undoReceiptDelete()
        XCTAssertFalse(app.removedIds.contains("r1"), "Kumoa left the receipt off the lists")
        XCTAssertFalse(app.receiptDelete.isWaiting)

        // What would send it: the window ending, or the app going to the background.
        app.flushReceiptDelete()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(sends.first, 0, "the server was asked for a delete the owner took back")
    }

    func testTheServerIsAskedOnceWhenTheWindowEnds() {
        let app = makeApp()
        let sends = Sends()
        let before = app.dataVersion
        app.deleteWithUndo(["r1"]) { sends.first += 1; return ReceiptDeleteOutcome(deleted: 1) }
        XCTAssertEqual(sends.first, 0, "the server was asked before the window ended")

        app.flushReceiptDelete()
        spin(until: { sends.first == 1 })
        XCTAssertEqual(sends.first, 1)
        // The timer and the background meeting on the same delete.
        app.flushReceiptDelete()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(sends.first, 1, "one delete was sent twice")
        XCTAssertTrue(app.removedIds.contains("r1"), "a delete the server took came back on the lists")
        XCTAssertGreaterThan(app.dataVersion, before, "the lists were not told to reload")
        XCTAssertNil(app.receiptDeleteFailure)
    }

    func testANewerDeleteSendsTheOlderOneAtOnce() {
        let app = makeApp()
        let sends = Sends()
        app.deleteWithUndo(["a"]) { sends.first += 1; return ReceiptDeleteOutcome(deleted: 1) }
        app.deleteWithUndo(["b"]) { sends.second += 1; return ReceiptDeleteOutcome(deleted: 1) }
        spin(until: { sends.first == 1 })
        XCTAssertEqual(sends.first, 1, "the first delete was not sent when the second took the toast")
        XCTAssertEqual(sends.second, 0, "the second delete was sent with no window")
        XCTAssertEqual(app.receiptDelete.waiting?.ids, ["b"])
        XCTAssertTrue(app.removedIds.isSuperset(of: ["a", "b"]))
    }

    func testARefusedDeleteBringsTheRowBackAndSaysWhy() {
        let app = makeApp()
        app.deleteWithUndo(["r1"]) {
            var outcome = ReceiptDeleteOutcome()
            outcome.fail(["r1"], reason: "Kausi on suljettu.")
            return outcome
        }
        app.flushReceiptDelete()
        spin(until: { app.receiptDeleteFailure != nil })
        XCTAssertEqual(app.receiptDeleteFailure, "Kuittia ei poistettu: Kausi on suljettu.")
        XCTAssertFalse(app.removedIds.contains("r1"), "the refused receipt stayed off the lists")
    }
}
