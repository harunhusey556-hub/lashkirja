import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Why a screen's data did not arrive, told apart so the copy can say what to do next.
public enum LoadFailureKind: String, Sendable, Equatable {
    /// The phone has no network; the request never left it.
    case offline
    /// The server (or the gateway in front of it) took too long: a lost `URLError.timedOut` or a 504.
    case timeout
    /// The server could not be reached or the gateway answered for it (502/503, refused connection).
    case unavailable
    /// A 401 that ends the session; the app is signing the owner out.
    case sessionExpired
    /// The server answered something the app could not read.
    case unreadable
    /// The server refused with a sentence of its own (404, 409, 422, ...).
    case server
}

/// A failed load in Finnish: what failed and what to do next. No status codes or error names.
public struct LoadFailure: Sendable, Equatable {
    public let kind: LoadFailureKind
    public let title: String
    public let message: String

    /// Shown under the banner when older figures stay on screen.
    public static let staleNote = "Näytetään viimeksi haetut tiedot."

    public var canRetry: Bool { kind != .sessionExpired }

    public init(kind: LoadFailureKind, serverMessage: String? = nil) {
        self.kind = kind
        switch kind {
        case .offline:
            title = "Ei verkkoyhteyttä"
            message = "Tietoja ei voitu hakea, koska puhelin ei ole verkossa. Tarkista yhteys ja yritä uudelleen."
        case .timeout:
            title = "Palvelin ei vastannut ajoissa"
            message = "Haku kesti liian kauan. Yritä hetken päästä uudelleen."
        case .unavailable:
            title = "Palvelimeen ei saada yhteyttä"
            message = serverMessage ?? "LashKirjan palvelin ei juuri nyt vastaa. Yritä hetken päästä uudelleen."
        case .sessionExpired:
            title = "Istunto on päättynyt"
            message = "Kirjaudu uudelleen sisään. Tallennetut tiedot ovat tallessa."
        case .unreadable:
            title = "Tietoja ei voitu lukea"
            message = "Palvelimen vastaus oli odottamaton. Yritä uudelleen; jos virhe toistuu, päivitä sovellus."
        case .server:
            title = "Lataus epäonnistui"
            message = serverMessage ?? LKError.unreachable
        }
    }

    /// The failure of a load, or nil when it was only cancelled (the screen went away).
    public init?(_ error: Error) {
        if error is CancellationError { return nil }
        if let url = error as? URLError {
            switch url.code {
            case .cancelled: return nil
            case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: self.init(kind: .offline)
            case .timedOut: self.init(kind: .timeout)
            default: self.init(kind: .unavailable)
            }
            return
        }
        guard let lk = error as? LKError else {
            self.init(kind: .server)
            return
        }
        // The server's own sentence, unless it is only the generic "no connection" fallback.
        let own = lk.message == LKError.unreachable ? nil : lk.message
        if lk.endsSession {
            self.init(kind: .sessionExpired)
        } else if lk.status == 0 {
            switch lk.code {
            case "OFFLINE"?: self.init(kind: .offline)
            case "TIMEOUT"?: self.init(kind: .timeout)
            default: self.init(kind: .unavailable)
            }
        } else if lk.code == "DECODE" {
            self.init(kind: .unreadable)
        } else if lk.status == 504 {
            self.init(kind: .timeout)
        } else if lk.status == 502 || lk.status == 503 {
            self.init(kind: .unavailable, serverMessage: own)
        } else {
            self.init(kind: .server, serverMessage: own)
        }
    }
}

/// One network-backed screen's data and how its latest load went.
///
/// - The first load shows a spinner; a failed first load shows the failure with a retry.
/// - A later load (refresh) keeps what is shown; if it fails, the data stays and the failure is a
///   banner (`banner`) above it, never a full-screen replacement.
/// - A cancelled load changes nothing shown.
public struct ScreenLoad<Value> {
    public enum Phase: Sendable, Equatable {
        case idle, loading, refreshing, settled
    }

    public enum Display {
        case loading
        case failed(LoadFailure)
        case content(Value)
    }

    public private(set) var value: Value?
    public private(set) var phase: Phase = .idle
    public private(set) var failure: LoadFailure?

    public init() {}

    public var display: Display {
        if let value { return .content(value) }
        if let failure { return .failed(failure) }
        return .loading
    }

    /// The failure to show above data still on screen.
    public var banner: LoadFailure? { value == nil ? nil : failure }
    public var isRefreshing: Bool { phase == .refreshing }

    /// A load starts. With nothing shown yet it is the spinner (a retry clears the old failure);
    /// with data shown it is a background refresh that keeps both the data and any banner.
    public mutating func begin() {
        if value == nil {
            failure = nil
            phase = .loading
        } else {
            phase = .refreshing
        }
    }

    /// Another subject (a year, a month): the old figures must not stay under the new heading.
    public mutating func restart() {
        value = nil
        failure = nil
        phase = .loading
    }

    public mutating func succeed(_ value: Value) {
        self.value = value
        failure = nil
        phase = .settled
    }

    public mutating func fail(_ error: Error) {
        guard let failure = LoadFailure(error) else {
            phase = value == nil ? .idle : .settled
            return
        }
        self.failure = failure
        phase = .settled
    }

    /// A local edit to what is shown (a row removed after an action); nothing when nothing is shown.
    public mutating func update(_ edit: (inout Value) -> Void) {
        guard var current = value else { return }
        edit(&current)
        value = current
    }
}

extension ScreenLoad.Display: Equatable where Value: Equatable {}
extension ScreenLoad: Equatable where Value: Equatable {}
extension ScreenLoad: Sendable where Value: Sendable {}
extension ScreenLoad.Display: Sendable where Value: Sendable {}
