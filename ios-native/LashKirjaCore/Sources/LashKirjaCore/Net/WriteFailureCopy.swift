import Foundation

/// Finnish copy for a write that did not come back as a success: what was (not) saved and what
/// the person can do. A server refusal keeps the server's own sentence.
public enum WriteFailureCopy {
    /// - Parameters:
    ///   - notDone: said when the request never left the phone ("Kopiota ei luotu.").
    ///   - maybeDone: said when it may have reached the server ("Kopio on voinut tallentua.").
    ///   - retrySafe: the retry carries the same Idempotency-Key, so repeating cannot double it.
    public static func message(for error: Error, notDone: String, maybeDone: String, retrySafe: Bool) -> String {
        guard let lk = error as? LKError else { return unknown(maybeDone, retrySafe) }
        if lk.code == "OFFLINE" {
            return "Ei verkkoyhteyttä. \(notDone) Yritä uudelleen, kun yhteys palaa."
        }
        let lostAnswer = lk.status == 0 && (lk.code == "NETWORK" || lk.code == "TIMEOUT")
        let gateway = [502, 503, 504].contains(lk.status) && lk.message == LKError.unreachable
        if lostAnswer || gateway { return unknown(maybeDone, retrySafe) }
        return lk.message
    }

    private static func unknown(_ maybeDone: String, _ retrySafe: Bool) -> String {
        let tail = retrySafe
            ? "Tarkista tilanne ennen uutta yritystä; saman yrityksen toisto ei tee tuplaa."
            : "Tarkista tilanne ennen uutta yritystä."
        return "Yhteys katkesi kesken pyynnön. \(maybeDone) \(tail)"
    }
}
