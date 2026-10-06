import Foundation
import MetricKit
import UIKit
import LashKirjaCore

extension ObserveAppInfo {
    static var current: ObserveAppInfo {
        let info = Bundle.main.infoDictionary
        return ObserveAppInfo(
            version: info?["CFBundleShortVersionString"] as? String ?? "?",
            build: info?["CFBundleVersion"] as? String ?? "?",
            os: UIDevice.current.systemVersion)
    }
}

/// Receives MetricKit diagnostics and passes a compact summary to the reporter (which drops it
/// when nobody is signed in). No UI, no third-party SDK.
final class DiagnosticsObserver: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = DiagnosticsObserver()
    private var reporter: ObserveReporter?

    func start(reporter: ObserveReporter) {
        self.reporter = reporter
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        guard let reporter else { return }
        let diagnostics = payloads.flatMap(Self.summaries)
        guard !diagnostics.isEmpty else { return }
        Task.detached(priority: .utility) {
            for (diagnostic, app) in diagnostics { await reporter.reportDiagnostic(diagnostic, app: app) }
        }
    }

    private static func summaries(_ payload: MXDiagnosticPayload) -> [(NativeDiagnostic, ObserveAppInfo)] {
        func frames(_ tree: MXCallStackTree) -> [NativeDiagnostic.Frame] {
            NativeDiagnostic.frames(fromCallStackTree: tree.jsonRepresentation(), limit: 5)
        }
        var out: [(NativeDiagnostic, ObserveAppInfo)] = []
        for d in payload.crashDiagnostics ?? [] {
            out.append((NativeDiagnostic(kind: .crash, exceptionType: d.exceptionType?.intValue, exceptionCode: d.exceptionCode?.intValue,
                                         signal: d.signal?.intValue, frames: frames(d.callStackTree)), app(d.metaData)))
        }
        for d in payload.hangDiagnostics ?? [] {
            out.append((NativeDiagnostic(kind: .hang, exceptionType: nil, exceptionCode: nil, signal: nil, frames: frames(d.callStackTree)), app(d.metaData)))
        }
        for d in payload.cpuExceptionDiagnostics ?? [] {
            out.append((NativeDiagnostic(kind: .cpu, exceptionType: nil, exceptionCode: nil, signal: nil, frames: frames(d.callStackTree)), app(d.metaData)))
        }
        for d in payload.diskWriteExceptionDiagnostics ?? [] {
            out.append((NativeDiagnostic(kind: .disk, exceptionType: nil, exceptionCode: nil, signal: nil, frames: frames(d.callStackTree)), app(d.metaData)))
        }
        return out
    }

    /// The build the diagnostic was recorded on, which can be an earlier one than the running app.
    private static func app(_ meta: MXMetaData) -> ObserveAppInfo {
        let now = ObserveAppInfo.current
        let os = meta.osVersion.split(separator: " ").first(where: { $0.first?.isNumber == true }).map(String.init) ?? now.os
        return ObserveAppInfo(version: meta.applicationBuildVersion == now.build ? now.version : "?",
                              build: meta.applicationBuildVersion, os: os)
    }
}
