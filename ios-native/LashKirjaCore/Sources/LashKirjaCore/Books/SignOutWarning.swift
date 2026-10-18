/// The sign-out question's message (web `useSignOut.tsx`). Signing out deletes the receipts still on
/// the phone, as the web does; they are bookkeeping documents, so the question says how many first.
public enum SignOutWarning {
    /// Nil when nothing would be lost. `waiting` is the offline queue: its sent rows stay a day only
    /// for the card's "lähetetty" line and are already on the server, so they do not count.
    /// `unsavedReadings` are the capture rows a sign-out drops: on their way, or read and not saved.
    public static func message(waiting: [QueuedReceipt], unsavedReadings: Int) -> String? {
        let count = waiting.filter { $0.status != .done }.count + max(unsavedReadings, 0)
        guard count > 0 else { return nil }
        return queuedReceiptsCountLabel(count) + " Jos kirjaudut ulos, ne poistetaan tästä laitteesta."
    }

    /// "1 kuitti odottaa lähetystä." / "3 kuittia odottaa lähetystä." (web `queuedReceiptsCountLabel`)
    static func queuedReceiptsCountLabel(_ count: Int) -> String {
        count == 1 ? "1 kuitti odottaa lähetystä." : "\(count) kuittia odottaa lähetystä."
    }
}
