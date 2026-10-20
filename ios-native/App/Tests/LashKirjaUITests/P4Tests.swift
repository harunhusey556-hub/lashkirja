import XCTest

/// P4: assistant without an AI provider (the demo server has none), and retry after a lost answer.
final class P4Tests: WalkTestCase {
    func openAssistant() { app.buttons["Avustaja"].firstMatch.tap(); taps += 1; sleep(3) }
    var composer: XCUIElement { app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch }

    func testA_UnavailableStateIsCalm() {
        openAssistant(); shot("p4-assistant"); dump(app, "p4-assistant")
        check("P4 assistant opens with a composer", composer.waitForExistence(timeout: 10))
        // U016 U053 (B11): the shortcuts were cut mid-word at the conversation's margin ('Tämän kuur').
        assertChipRowEdge("assistant-shortcuts", "P4 assistant shortcuts")
    }

    /// U059: the question reaches the server and only its answer is lost, so the retry is a real
    /// repeat for the message's clientId to catch. The server's own messages are counted.
    func testB_RetryDoesNotDuplicate() {
        // The demo API itself, past the proxy (the runner shares the Mac's loopback). Test values
        // from app/scripts/demo-seed.ts; only ever against the throwaway demo API.
        func call(_ path: String, _ body: [String: String]?, _ bearer: String?) -> [String: Any]? {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3999\(path)")!)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            if let body {
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            }
            if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization") }
            var result: [String: Any]?
            let done = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { data, _, _ in
                result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                done.signal()
            }.resume()
            _ = done.wait(timeout: .now() + 30)
            return result
        }
        guard let bearer = call("/api/auth/token", ["email": "demo@lashkirja.fi", "password": "demo123"], nil)?["token"] as? String else {
            XCTFail("the demo API gave no token"); return
        }
        defer { _ = call("/api/auth/logout", [:], bearer) }
        let question = "Paljonko myyntiä tässä kuussa?"
        // The question's stored user messages in every conversation that holds it: a repeat the
        // server did not catch can land in a second conversation.
        func storedQuestions() -> Int? {
            guard let q = question.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
                  let conversations = call("/api/ai/conversations?q=\(q)", nil, bearer)?["conversations"] as? [[String: Any]] else { return nil }
            var count = 0
            for conversation in conversations {
                guard let id = conversation["id"] as? String,
                      let messages = call("/api/ai/chat?conversationId=\(id)", nil, bearer)?["messages"] as? [[String: Any]] else { return nil }
                count += messages.filter { $0["role"] as? String == "user" && $0["content"] as? String == question }.count
            }
            return count
        }

        openAssistant()
        guard composer.waitForExistence(timeout: 10) else { check("P4 composer exists", false); return }
        // The assistant reopens the latest conversation: earlier runs' questions may already be in
        // it. What matters is that this send and its retry add exactly one bubble.
        let before = questionBubbles()
        guard let stored = storedQuestions() else { XCTFail("the demo API did not list the stored messages"); return }
        loseAnswers()
        type(composer, question)
        // The composer is multi-line: Return adds a line, the arrow button sends.
        app.buttons["Lähetä"].firstMatch.tap()
        let retry = app.buttons["Yritä uudelleen"].firstMatch
        let offered = retry.waitForExistence(timeout: 30)
        shot("p4-failed"); dump(app, "p4-failed")
        check("P4 failed answer offers Yritä uudelleen", offered)
        var now = storedQuestions()
        for _ in 0..<10 where now != stored + 1 { sleep(1); now = storedQuestions() }
        XCTAssertEqual(now, stored + 1, "the question whose answer was lost is not one stored message (before: \(stored))")
        keepAnswers()
        guard offered else { return }
        retry.tap()
        // The retry has its answer once the send button is back (Pysäytä while the reply streams).
        let streaming = app.buttons["Pysäytä"].firstMatch
        let done = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: streaming)], timeout: 60)
        shot("p4-after-retry")
        check("P4 retry finished", done == .completed)
        let added = questionBubbles() - before
        check("P4 retry keeps one question bubble (added \(added))", added == 1)
        check("P4 retry is answered (\(retry.exists ? "Yritä uudelleen still offered" : "answered"))", !retry.exists)
        XCTAssertEqual(storedQuestions(), stored + 1, "the retry stored the question again (before: \(stored))")
    }

    /// The question's bubbles in the message list; the conversation's title repeats it in the
    /// navigation bar, which is not a bubble.
    func questionBubbles() -> Int {
        let question = NSPredicate(format: "label == 'Paljonko myyntiä tässä kuussa?'")
        return app.staticTexts.matching(question).count - app.navigationBars.staticTexts.matching(question).count
    }
}
