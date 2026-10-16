import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                Theme.canvas.ignoresSafeArea()
            case .signedOut(let notice):
                LoginView(notice: notice)
            case .signedIn:
                MainTabView()
                    .background(LockWindowHost(locked: AppLock.shared.isLocked, app: app))
            }
        }
        .motion(.default, value: app.phase)
        .overlay(alignment: .topLeading) {
            if UITestHooks.launchPhase { LaunchPhaseMarker(phase: app.phase) }
        }
    }
}

/// UI tests only: the phase the launch is in, so a walk waits for what the app decided instead of
/// a fixed window. A token stored by an earlier walk paints the tabs first and drops to the sign-in
/// screen once the server refuses it (7–9 s later on a CI runner before w49's session check).
/// The label carries when (ms after the process started) the tabs and then the sign-in screen were
/// first built, for the revoked-session walk (StabilityTests.test10).
private struct LaunchPhaseMarker: View {
    let phase: AppModel.Phase

    var body: some View {
        let value = value
        return Color.clear
            .frame(width: 1, height: 1)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityIdentifier("lk.launch-phase")
            .accessibilityLabel(UITestHooks.launchTimeline)
            .accessibilityValue(value)
    }

    private var value: String {
        switch phase {
        case .launching: return "launching"
        case .signedOut:
            UITestHooks.firstBuilt("signedOut")
            return "signedOut"
        // AuthService.restore() knows only the user id; /api/auth/me fills in the email once the
        // server has accepted the stored token.
        case .signedIn(let user):
            UITestHooks.firstBuilt("tabs")
            return user.email.isEmpty ? "restored" : "signedIn"
        }
    }
}
