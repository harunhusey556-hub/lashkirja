import CoreSpotlight
import UniformTypeIdentifiers
import LashKirjaCore

/// Customers and invoices in system search, kept on the device: nothing here talks to the server,
/// and a tap comes back as a `lashkirja://customer|invoice/<id>` link through `AppModel.handle`.
/// Adds only; a row that disappeared stays until sign-out clears the whole index.
enum SpotlightIndexer {
    static func index(_ entries: [SpotlightEntry]) {
        let items = entries.map { entry -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: .content)
            attributes.title = entry.title
            attributes.contentDescription = entry.detail
            attributes.keywords = entry.keywords
            return CSSearchableItem(uniqueIdentifier: entry.identifier, domainIdentifier: "fi.tiyouba.lashkirja.items", attributeSet: attributes)
        }
        guard !items.isEmpty else { return }
        CSSearchableIndex.default().indexSearchableItems(items) { error in
            if let error { NSLog("Spotlight: indexing failed: \(error.localizedDescription)") }
        }
    }

    /// Everything of the signed-out owner's leaves system search.
    static func clear() {
        CSSearchableIndex.default().deleteAllSearchableItems { error in
            if let error { NSLog("Spotlight: clearing failed: \(error.localizedDescription)") }
        }
    }

    /// The link a tapped result carries, if the activity is one of ours.
    static func url(from activity: NSUserActivity) -> URL? {
        guard let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return nil }
        return URL(string: id)
    }
}
