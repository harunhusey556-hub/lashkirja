import XCTest
@testable import LashKirja
import LashKirjaCore

final class KeychainTokenStoreTests: XCTestCase {
    func testRoundTrip() async {
        let store = KeychainTokenStore(account: "test.\(UUID().uuidString)")
        let token = StoredToken(token: "T", expiresAt: Date(timeIntervalSince1970: 2_000_000_000), issuedAt: Date(timeIntervalSince1970: 1_000_000_000), userId: "u")
        await store.save(token)
        let loaded = await store.load()
        XCTAssertEqual(loaded, token)
        await store.savePendingRevoke("R")
        let pending = await store.loadPendingRevoke()
        XCTAssertEqual(pending, "R")
        await store.clear()
        await store.savePendingRevoke(nil)
        let cleared = await store.load()
        XCTAssertNil(cleared)
        let noPending = await store.loadPendingRevoke()
        XCTAssertNil(noPending)
    }
}
