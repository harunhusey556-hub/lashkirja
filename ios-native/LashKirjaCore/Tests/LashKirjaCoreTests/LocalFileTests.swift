import Testing
import Foundation
@testable import LashKirjaCore

// Codex review item 15: picked files are sized before they are read or copied, off the main actor.

@Suite struct LocalFileTests {
    private func temp(_ bytes: Int) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("lf-\(UUID().uuidString).pdf")
        try Data(repeating: 7, count: bytes).write(to: url)
        return url
    }

    @Test func readsAFileWithinTheLimit() async throws {
        let url = try temp(10)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(await LocalFile.read(url, maxBytes: 10) == .success(Data(repeating: 7, count: 10)))
    }

    @Test func refusesTooLargeAndEmptyFilesWithoutReading() async throws {
        let big = try temp(11)
        let empty = try temp(0)
        defer { try? FileManager.default.removeItem(at: big); try? FileManager.default.removeItem(at: empty) }
        #expect(await LocalFile.read(big, maxBytes: 10) == .failure(.tooLarge))
        #expect(await LocalFile.read(empty, maxBytes: 10) == .failure(.empty))
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("lf-missing-\(UUID().uuidString)")
        #expect(await LocalFile.read(missing, maxBytes: 10) == .failure(.unreadable))
    }

    @Test func copiesOnlyWhatFits() async throws {
        let small = try temp(5)
        let big = try temp(50)
        defer { try? FileManager.default.removeItem(at: small); try? FileManager.default.removeItem(at: big) }
        guard case .success(let copy) = await LocalFile.copyToTemporary(small, prefix: "kuitti", maxBytes: 10) else {
            Issue.record("copy failed"); return
        }
        defer { try? FileManager.default.removeItem(at: copy.url) }
        #expect(copy.size == 5)
        #expect(copy.url.pathExtension == "pdf")
        #expect(try Data(contentsOf: copy.url) == Data(repeating: 7, count: 5))
        #expect(await LocalFile.copyToTemporary(big, prefix: "kuitti", maxBytes: 10) == .failure(.tooLarge))
    }

    @Test func statementLimitIsTheServers() {
        // app/src/lib/storage.ts MAX_STATEMENT_BYTES
        #expect(LocalFile.statementMaxBytes == 20 * 1024 * 1024)
        #expect(LocalFile.Problem.tooLarge.message(maxBytes: LocalFile.statementMaxBytes) == "Tiedosto on liian suuri (enintään 20 Mt)")
        #expect(LocalFile.Problem.empty.message(maxBytes: 1) == "Tiedosto on tyhjä")
        #expect(LocalFile.Problem.unreadable.message(maxBytes: 1) == "Tiedostoa ei voitu lukea.")
    }
}
