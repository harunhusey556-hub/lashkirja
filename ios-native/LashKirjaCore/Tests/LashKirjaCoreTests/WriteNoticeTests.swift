import Testing
import Foundation
@testable import LashKirjaCore

actor Seen { var paths: [String] = []; func add(_ p: String) { paths.append(p) } }

@Test func successfulWritesAreAnnouncedReadsAndFailuresAreNot() async throws {
    let ok = HTTPResponse(status: 200, headers: ["X-LashKirja-Api-Version": "1"], body: Data("{}".utf8))
    let refused = HTTPResponse(status: 409, headers: ["X-LashKirja-Api-Version": "1"], body: Data(#"{"error":"x"}"#.utf8))
    let t = FakeTransport([ok, ok, refused])
    let c = APIClient(baseURL: URL(string: "https://example.test")!, transport: t, tokens: FixedToken(value: "t"), sleep: { _ in })
    let seen = Seen()
    await c.setOnWrite { path in await seen.add(path) }
    let _: Ignored = try await c.get("/api/invoices")
    let _: Ignored = try await c.send("POST", "/api/invoices/1/send", body: EmptyBody())
    _ = try? await c.send("PATCH", "/api/receipts/2", body: EmptyBody()) as Ignored
    #expect(await seen.paths == ["/api/invoices/1/send"])
}
