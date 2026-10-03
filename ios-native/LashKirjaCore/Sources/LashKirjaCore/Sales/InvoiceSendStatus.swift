import Foundation

/// Whether the invoice went to the customer, in one line on the invoice screen, and the send
/// attempts in Historia. Wording from the web (`lib/send-history.ts sendAttemptView`); the raw
/// mail-server error is English and internal, so it is never shown (web L5).
public enum InvoiceSendState {
    /// Stored on an attempt the server closed after a restart (`CRASHED_SEND_NOTE`).
    public static let crashedNote = "Lähetys keskeytyi, kun palvelin käynnistyi uudelleen kesken lähetyksen."

    public enum Tone: Sendable, Equatable { case muted, warning, danger }

    public struct Line: Sendable, Equatable {
        public let text: String
        public let tone: Tone
        /// A plain failed send: "Yritä uudelleen" opens the send sheet. Not offered when the mail
        /// may have left (interrupted, unrecorded), so a tap cannot mail the invoice twice.
        public let canRetry: Bool
    }

    /// The attempt as web Historia names it.
    public static func title(status: String, error: String?) -> (title: String, reason: String?, tone: Tone) {
        switch status {
        case "sent": return ("Lähetetty sähköpostilla", nil, .muted)
        case "failed" where error == crashedNote:
            return ("Lähetys keskeytyi", "palvelin käynnistyi uudelleen kesken lähetyksen, viesti on voinut mennä perille", .warning)
        case "failed": return ("Lähetys epäonnistui", "vastaanottajan palvelin ei ottanut viestiä vastaan", .danger)
        case "ambiguous": return ("Lähetys jäi epäselväksi", "viesti lähti, mutta kirjausta ei saatu tallennettua", .warning)
        default: return ("Lähetys kesken", nil, .muted)
        }
    }

    /// The latest attempt decides. Without any e-mail attempt: "Merkitty lähetetyksi" when the
    /// invoice was marked sent by hand, "Ei lähetetty" when it is out of draft and never went.
    /// A draft says nothing unless an attempt on it failed or is open.
    public static func line(status: String, sentAt: String?, sends: [Invoice.Send]) -> Line? {
        let newestFirst = sends.sorted { (APIDate.instant($0.createdAt) ?? .distantPast) > (APIDate.instant($1.createdAt) ?? .distantPast) }
        guard let latest = newestFirst.first else {
            if let sentAt { return Line(text: "Merkitty lähetetyksi \(APIDate.displayDay(sentAt))", tone: .muted, canRetry: false) }
            return status == "draft" ? nil : Line(text: "Ei lähetetty", tone: .muted, canRetry: false)
        }
        let delivered = newestFirst.filter { $0.status == "sent" }
        if latest.status == "sent" {
            let times = delivered.count > 1 ? " · \(delivered.count) kertaa" : ""
            return Line(text: "Lähetetty sähköpostilla \(APIDate.timestamp(latest.createdAt)) → \(latest.toAddress)\(times)",
                        tone: .muted, canRetry: false)
        }
        let view = title(status: latest.status, error: latest.error)
        var text = "\(view.title) \(APIDate.displayDay(latest.createdAt))"
        if let reason = view.reason { text += ": \(reason)" }
        // An earlier send did reach the customer: the failure is not the whole story.
        if let earlier = delivered.first { text += " · aiemmin lähetetty \(APIDate.displayDay(earlier.createdAt))" }
        return Line(text: text, tone: view.tone, canRetry: latest.status == "failed" && latest.error != crashedNote)
    }

    public struct HistoryItem: Identifiable, Sendable, Equatable {
        public let id: String
        public let title: String
        public let meta: String
        public let tone: Tone
    }

    /// Activity and send attempts in one feed, newest first (web `historyItems`).
    public static func history(activity: [Invoice.Activity], sends: [Invoice.Send]) -> [HistoryItem] {
        var dated: [(at: Date, item: HistoryItem)] = []
        for send in sends {
            let view = title(status: send.status, error: send.error)
            let meta = [APIDate.timestamp(send.createdAt), send.toAddress, send.attachmentName,
                        send.gross.map { Money.format($0) }, view.reason]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
            dated.append((APIDate.instant(send.createdAt) ?? .distantPast,
                          HistoryItem(id: "send-\(send.id)", title: view.title, meta: meta, tone: view.tone)))
        }
        for entry in activity {
            dated.append((APIDate.instant(entry.createdAt) ?? .distantPast,
                          HistoryItem(id: "activity-\(entry.id)", title: entry.summary, meta: APIDate.timestamp(entry.createdAt), tone: .muted)))
        }
        // Stable for equal times: the order the server gave.
        return dated.enumerated()
            .sorted { $0.element.at != $1.element.at ? $0.element.at > $1.element.at : $0.offset < $1.offset }
            .map(\.element.item)
    }
}
