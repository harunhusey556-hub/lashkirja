import Testing
import Foundation
@testable import LashKirjaCore

private func statements(_ count: Int) throws -> [Statement] {
    let items = (0..<count).map { i in
        #"{"id":"s\#(i)","fileName":"f\#(i).csv","fileType":"csv","periodMonth":"2026-\#(String(format: "%02d", 12 - i))","uploadedAt":"2026-10-01T00:00:00Z","bankAccount":null,"transactions":[],"totals":{"income":0,"expenses":0,"net":0,"txCount":\#(i)}}"#
    }
    return try JSONDecoder().decode(StatementList.self, from: Data(#"{"statements":[\#(items.joined(separator: ","))]}"#.utf8)).statements
}

@Test func statementFilesShowSixRecentUntilAskedForAll() throws {
    let list = try statements(8)
    #expect(StatementFiles.visible(list, showAll: false).map(\.id) == ["s0", "s1", "s2", "s3", "s4", "s5"])
    #expect(StatementFiles.visible(list, showAll: true).count == 8)
    #expect(StatementFiles.toggleLabel(count: 8, showAll: false) == "Näytä kaikki (8)")
    #expect(StatementFiles.toggleLabel(count: 8, showAll: true) == "Näytä vähemmän")
    #expect(StatementFiles.toggleLabel(count: 6, showAll: false) == nil)
}

@Test func statementFileRowLine() throws {
    let s = try JSONDecoder().decode(Statement.self, from: Data(#"{"id":"s","fileName":"x.pdf","fileType":"enablebanking","periodMonth":"2026-09","uploadedAt":"u","bankAccount":{"id":"a","name":"Käyttötili"},"transactions":[{"id":"t","statementId":"s","type":"meno","amount":-5,"matchStatus":"unmatched"}],"totals":{"income":0,"expenses":5,"net":-5,"txCount":3}}"#.utf8))
    // The title says the month ("Pankkiyhteys · Syyskuu 2026"); a bank feed has no file to name.
    #expect(StatementFiles.secondary(s) == "Käyttötili · 3 tapahtumaa")
    #expect(StatementFiles.isBankFeed(s))
    let bare = try JSONDecoder().decode(Statement.self, from: Data(#"{"id":"s","fileName":"x.pdf","periodMonth":null,"uploadedAt":"u","transactions":[{"id":"t","statementId":"s","type":"meno","amount":-5,"matchStatus":"unmatched"}]}"#.utf8))
    // Without a month the title is only "Tiliote": the line still says so.
    #expect(StatementFiles.secondary(bare) == "Ei kuukautta · x.pdf · 1 tapahtumaa")
    #expect(StatementFiles.net(bare) == -5)
}

@Test func filesOfOneMonthReadApartByTheirNames() throws {
    // X095: three October files read "Tiliote · Lokakuu 2026" over "Lokakuu 2026 · Käyttötili · N tapahtumaa".
    let october = try ["tiliote-pitka.csv", "tiliote-abc.csv", "tiliote-audit.csv"].map { name in
        try JSONDecoder().decode(Statement.self, from: Data(#"{"id":"\#(name)","fileName":"\#(name)","fileType":"csv","periodMonth":"2026-10","uploadedAt":"u","bankAccount":{"id":"a","name":"Käyttötili"},"transactions":[],"totals":{"income":0,"expenses":0,"net":0,"txCount":5}}"#.utf8))
    }
    let lines = october.map(StatementFiles.secondary)
    #expect(lines == ["tiliote-pitka.csv · Käyttötili · 5 tapahtumaa", "tiliote-abc.csv · Käyttötili · 5 tapahtumaa",
                      "tiliote-audit.csv · Käyttötili · 5 tapahtumaa"])
    #expect(lines.allSatisfy { !$0.contains("Lokakuu") && !$0.contains("lokakuu") })
    #expect(october.allSatisfy { StatementText.title($0) == "Tiliote · Lokakuu 2026" })
}

@Test func statementUploadAnswer() throws {
    let r = try JSONDecoder().decode(StatementUploadResult.self, from: Data(#"{"ok":true,"statement":{"id":"s1"},"count":4,"notice":"Kaksi riviä oli jo tuotu."}"#.utf8))
    #expect(r.statementId == "s1")
    #expect(r.message == "Tuotiin 4 tapahtumaa. Kaksi riviä oli jo tuotu.")
    let bare = try JSONDecoder().decode(StatementUploadResult.self, from: Data(#"{"count":0}"#.utf8))
    #expect(bare.statementId == nil)
    #expect(bare.message == "Tuotiin 0 tapahtumaa.")
}
