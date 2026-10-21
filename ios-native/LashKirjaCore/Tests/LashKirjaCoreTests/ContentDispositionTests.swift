import Testing
import Foundation
@testable import LashKirjaCore

// X084: a download is kept under the name the server gives it, so the shared CSV is
// 'tuloslaskelma-2026.csv', not the API's type key 'profit-loss-2026.csv'.

@Test func dispositionNamesTheFile() {
    #expect(ContentDisposition.fileName(#"attachment; filename="tuloslaskelma-2026.csv""#, fallback: "profit-loss-2026.csv") == "tuloslaskelma-2026.csv")
    #expect(ContentDisposition.fileName("attachment; filename=asiakkaat.csv", fallback: "customers-2026.csv") == "asiakkaat.csv")
}

@Test func noDispositionKeepsTheGivenName() {
    #expect(ContentDisposition.fileName(nil, fallback: "profit-loss-2026.csv") == "profit-loss-2026.csv")
    #expect(ContentDisposition.fileName("inline", fallback: "kuitti") == "kuitti")
    #expect(ContentDisposition.fileName(#"attachment; filename="""#, fallback: "kuitti") == "kuitti")
}

@Test func extendedNameWinsAsOnTheWeb() {
    // inlineContentDisposition: an ASCII stand-in, then the original name percent-encoded.
    #expect(ContentDisposition.fileName(#"inline; filename="kuitti_s__p.jpg"; filename*=UTF-8''kuitti%20s%C3%A4%C3%A4p.jpg"#, fallback: "kuitti") == "kuitti sääp.jpg")
}

@Test func dispositionNameNeverLeavesItsFolder() {
    #expect(ContentDisposition.fileName(#"attachment; filename="../../Library/x.csv""#, fallback: "f.csv") == "x.csv")
    #expect(ContentDisposition.fileName(#"attachment; filename="..""#, fallback: "f.csv") == "f.csv")
    #expect(ContentDisposition.fileName("attachment; filename*=UTF-8''..%2F..%2Fx.zip", fallback: "f.zip") == "x.zip")
}
