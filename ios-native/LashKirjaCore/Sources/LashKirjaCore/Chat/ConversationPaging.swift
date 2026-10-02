import Foundation

/// The conversation list pages by the last row it holds (`before` + `beforeId`, 50 at a time);
/// `PagedShowMore` decides when the next page is asked for.
public enum ConversationPaging {
    /// `GET /api/ai/conversations` query; `after` asks for the page older than that row.
    /// Nil when `after` has no timestamp to page from.
    public static func query(archived: Bool, search: String, after last: Conversation? = nil) -> [String: String]? {
        var query: [String: String] = [:]
        if archived { query["archived"] = "1" }
        if !search.isEmpty { query["q"] = search }
        if let last {
            guard let updatedAt = last.updatedAt else { return nil }
            query["before"] = updatedAt
            query["beforeId"] = last.id
        }
        return query
    }
}
