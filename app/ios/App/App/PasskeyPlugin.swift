import AuthenticationServices
import Capacitor
import Foundation

/// OWN-21: passkeys inside the bundled app.
///
/// The WebView runs at `capacitor://localhost`, so `navigator.credentials`
/// cannot use the server's RP ID. This plugin calls AuthenticationServices
/// directly with the RP ID the server put in its options, and returns the
/// WebAuthn JSON shapes @simplewebauthn/server verifies (base64url fields).
///
/// The system only allows an RP ID listed in the app's
/// `com.apple.developer.associated-domains` entitlement
/// (`webcredentials:<host>`, see App.entitlements) and confirmed by the
/// server's `/.well-known/apple-app-site-association`. Without both, iOS
/// fails the request (mapped to NOT_ASSOCIATED below).
///
/// iOS 16+ (synced passkeys). The app's deployment target is 15.0, so every
/// use of the API is behind `#available`, and `isSupported` reports false on 15.
///
/// Registered from `MainViewController.capacitorDidLoad()`
/// (`bridge?.registerPluginInstance`), the Capacitor 8 way for a plugin that
/// lives in the app target rather than in an npm package.
@objc(LashKirjaPasskeyPlugin)
public class LashKirjaPasskeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LashKirjaPasskeyPlugin"
    public let jsName = "LashKirjaPasskey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise)
    ]

    /// The ceremony in flight. ASAuthorizationController holds its delegate
    /// weakly, so this strong reference keeps it alive until it completes.
    private var ceremony: AnyObject?

    @objc func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func register(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.reject("Passkeys need iOS 16 or later.", "UNSUPPORTED")
            return
        }
        guard let options = Self.options(from: call) else { return }
        guard
            let rp = options["rp"] as? [String: Any],
            let rpId = rp["id"] as? String, !rpId.isEmpty,
            let challenge = Self.decode(options["challenge"] as? String),
            let user = options["user"] as? [String: Any],
            let userId = Self.decode(user["id"] as? String),
            let userName = user["name"] as? String
        else {
            call.reject("Invalid registration options.", "INVALID_OPTIONS")
            return
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: userName,
            userID: userId
        )
        if let displayName = user["displayName"] as? String, !displayName.isEmpty {
            request.displayName = displayName
        }
        request.userVerificationPreference = .required
        if #available(iOS 17.4, *) {
            let excluded = (options["excludeCredentials"] as? [[String: Any]] ?? [])
                .compactMap { Self.decode($0["id"] as? String) }
                .map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
            if !excluded.isEmpty {
                request.excludedCredentials = excluded
            }
        }

        perform(call: call, request: request)
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.reject("Passkeys need iOS 16 or later.", "UNSUPPORTED")
            return
        }
        guard let options = Self.options(from: call) else { return }
        guard
            let rpId = options["rpId"] as? String, !rpId.isEmpty,
            let challenge = Self.decode(options["challenge"] as? String)
        else {
            call.reject("Invalid authentication options.", "INVALID_OPTIONS")
            return
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        // No allowedCredentials: a usernameless (discoverable) request, so the
        // system offers every passkey this device has for the domain.
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required

        perform(call: call, request: request)
    }

    @available(iOS 16.0, *)
    private func perform(call: CAPPluginCall, request: ASAuthorizationRequest) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.ceremony != nil {
                call.reject("Another passkey request is already open.", "BUSY")
                return
            }
            let anchor = self.bridge?.viewController?.view.window ?? ASPresentationAnchor()
            let ceremony = PasskeyCeremony(anchor: anchor) { [weak self] result in
                self?.ceremony = nil
                switch result {
                case .success(let payload):
                    call.resolve(payload)
                case .failure(let failure):
                    call.reject(failure.message, failure.code)
                }
            }
            self.ceremony = ceremony
            ceremony.start(request)
        }
    }

    /// Options arrive as one JSON string (`optionsJSON`), exactly what the
    /// server sent, so nothing is lost in Capacitor's argument bridging.
    private static func options(from call: CAPPluginCall) -> [String: Any]? {
        guard
            let raw = call.getString("optionsJSON"),
            let data = raw.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            call.reject("Invalid passkey options.", "INVALID_OPTIONS")
            return nil
        }
        return object
    }

    static func decode(_ base64url: String?) -> Data? {
        guard let value = base64url, !value.isEmpty else { return nil }
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64)
    }

    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

struct PasskeyFailure: Error {
    let code: String
    let message: String
}

/// One ASAuthorizationController request and its delegate callbacks.
@available(iOS 16.0, *)
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    private let completion: (Result<[String: Any], PasskeyFailure>) -> Void
    private var controller: ASAuthorizationController?
    private var finished = false

    init(anchor: ASPresentationAnchor, completion: @escaping (Result<[String: Any], PasskeyFailure>) -> Void) {
        self.anchor = anchor
        self.completion = completion
        super.init()
    }

    func start(_ request: ASAuthorizationRequest) {
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        controller.performRequests()
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        if let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            guard let attestation = registration.rawAttestationObject else {
                finish(.failure(PasskeyFailure(code: "FAILED", message: "The passkey returned no attestation.")))
                return
            }
            let id = LashKirjaPasskeyPlugin.encode(registration.credentialID)
            let response: [String: Any] = [
                "clientDataJSON": LashKirjaPasskeyPlugin.encode(registration.rawClientDataJSON),
                "attestationObject": LashKirjaPasskeyPlugin.encode(attestation),
                "transports": ["hybrid", "internal"]
            ]
            finish(.success([
                "id": id,
                "rawId": id,
                "type": "public-key",
                "authenticatorAttachment": "platform",
                "clientExtensionResults": [String: Any](),
                "response": response
            ]))
            return
        }

        if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            let id = LashKirjaPasskeyPlugin.encode(assertion.credentialID)
            var response: [String: Any] = [
                "clientDataJSON": LashKirjaPasskeyPlugin.encode(assertion.rawClientDataJSON),
                "authenticatorData": LashKirjaPasskeyPlugin.encode(assertion.rawAuthenticatorData),
                "signature": LashKirjaPasskeyPlugin.encode(assertion.signature)
            ]
            if let userID = assertion.userID, !userID.isEmpty {
                response["userHandle"] = LashKirjaPasskeyPlugin.encode(userID)
            }
            finish(.success([
                "id": id,
                "rawId": id,
                "type": "public-key",
                "authenticatorAttachment": "platform",
                "clientExtensionResults": [String: Any](),
                "response": response
            ]))
            return
        }

        finish(.failure(PasskeyFailure(code: "FAILED", message: "Unexpected credential type.")))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let nsError = error as NSError
        var code = "FAILED"
        if nsError.domain == ASAuthorizationError.errorDomain {
            switch nsError.code {
            case ASAuthorizationError.Code.canceled.rawValue:
                code = "CANCELLED"
            case 1006: // ASAuthorizationError.matchedExcludedCredential (iOS 18 SDK)
                code = "EXISTS"
            default:
                // An app whose associated domain is not confirmed (no entitlement
                // in the signed build, or no/invalid AASA file) fails with
                // .failed and a message naming the association.
                let text = nsError.localizedDescription.lowercased()
                if text.contains("associated") || text.contains("not associated") {
                    code = "NOT_ASSOCIATED"
                }
            }
        }
        finish(.failure(PasskeyFailure(code: code, message: nsError.localizedDescription)))
    }

    private func finish(_ result: Result<[String: Any], PasskeyFailure>) {
        guard !finished else { return }
        finished = true
        controller = nil
        completion(result)
    }
}
