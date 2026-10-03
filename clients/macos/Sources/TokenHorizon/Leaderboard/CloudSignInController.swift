import AppKit
import Combine
import CryptoKit
import Foundation
import Security

/// Browser consent is polled with PKCE. No local callback listener, browser
/// cookie, provider credential, or access token is passed through a deep link.
final class CloudSignInController: ObservableObject {
    static let shared = CloudSignInController()
    @Published var isPresented = false
    @Published private(set) var isWaiting = false
    @Published private(set) var message = ""
    @Published private(set) var error: String?
    @Published private(set) var handle = ""
    @Published private(set) var accountName: String?
    private var completions: [(Result<Void, Error>) -> Void] = []
    private var run: UUID?
    private var task: URLSessionDataTask?
    private var pollTimer: Timer?
    private var authorizationURL: URL?
    private let session = URLSession(configuration: .ephemeral, delegate: CloudPublishRedirectGuard(), delegateQueue: nil)

    func signIn(completion: @escaping (Result<Void, Error>) -> Void) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.signIn(completion: completion) }; return }
        completions.append(completion)
        guard run == nil else { return }
        run = UUID()
        handle = CloudPublishCredentials.effectiveHandle(SettingsStore.shared.leaderboardHandle.isEmpty
            ? NSUserName() : SettingsStore.shared.leaderboardHandle)
        error = nil; message = "Sign in, choose your profile, and connect this Mac. Sync will continue automatically."
        isPresented = true
        NotificationCenter.default.post(name: .openDashboard, object: DashboardTab.tokens)
    }

    func begin() {
        guard let run, !isWaiting else { return }
        let settings = SettingsStore.shared
        let configuredBaseURL = settings.leaderboardCloudURL
        guard let endpoint = CloudPublishCredentials.endpointURL(baseURL: configuredBaseURL),
              Self.isSecure(endpoint) else {
            error = "Use an HTTPS cloud URL in Settings before signing in."
            return
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            error = "Could not start a secure connection. Try again."
            return
        }
        let verifier = Self.base64URL(Data(bytes))
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var body: [String: Any] = ["handle": handle, "challenge": challenge]
        if let proof = settings.leaderboardClaimToken(endpoint: endpoint, handle: handle) { body["claimToken"] = proof }
        error = nil; isWaiting = true; message = "Opening secure sign-in…"
        request(endpoint: endpoint, action: "start", body: body) { result in
            guard self.run == run else { return }
            switch result {
            case .failure(let failure): self.failed(failure)
            case .success(let response):
                guard let id = response["id"] as? String,
                      let raw = response["authorizationUrl"] as? String, let url = URL(string: raw),
                      Self.isAuthorizationURL(url, endpoint: endpoint),
                      let expiry = response["expiresAt"] as? Double, expiry > Date().timeIntervalSince1970 * 1000 else {
                    self.failed(Self.failure("The cloud returned an invalid sign-in link. Try again.")); return
                }
                self.authorizationURL = url
                guard NSWorkspace.shared.open(url) else {
                    self.failed(Self.failure("Could not open your browser. Try opening sign-in again.")); return
                }
                self.message = "Finish signing in in your browser. Confirm your handle and choose Connect & sync."
                self.poll(run: run, endpoint: endpoint, id: id, verifier: verifier,
                          deadline: Date(timeIntervalSince1970: expiry / 1000), configuredBaseURL: configuredBaseURL)
            }
        }
    }

    func reopenBrowser() { if let authorizationURL { NSWorkspace.shared.open(authorizationURL) } }

    func disconnect() {
        let settings = SettingsStore.shared
        let currentHandle = settings.leaderboardHandle.isEmpty ? NSUserName() : settings.leaderboardHandle
        let account = DesktopCloudAccountStore.shared.account(baseURL: settings.leaderboardCloudURL, handle: currentHandle)
        do {
            try DesktopCloudAccountStore.shared.clear()
            accountName = nil
            if let account, let endpoint = URL(string: account.endpoint) {
                var request = URLRequest(url: Self.authURL(endpoint: endpoint, action: "revoke"))
                request.httpMethod = "POST"; request.timeoutInterval = 8
                request.setValue("Bearer \(account.accessToken)", forHTTPHeaderField: "Authorization")
                session.dataTask(with: request).resume()
            }
        } catch { self.error = error.localizedDescription }
    }

    func cancel() {
        guard run != nil else { isPresented = false; return }
        finish(.failure(Self.failure("Sign-in cancelled. Click Sync now when you’re ready to connect.")))
    }

    private func poll(run: UUID, endpoint: URL, id: String, verifier: String, deadline: Date, configuredBaseURL: String) {
        guard self.run == run else { return }
        guard Date() < deadline else {
            failed(Self.failure("This sign-in link expired. Choose Continue in browser to start again.")); return
        }
        request(endpoint: endpoint, action: "exchange", body: ["id": id, "verifier": verifier]) { result in
            guard self.run == run else { return }
            switch result {
            case .failure(let failure): self.failed(failure)
            case .success(let response):
                if response["status"] as? String == "pending" {
                    self.pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
                        self?.poll(run: run, endpoint: endpoint, id: id, verifier: verifier, deadline: deadline,
                                   configuredBaseURL: configuredBaseURL)
                    }
                    return
                }
                do {
                    let account = try Self.account(from: response, endpoint: endpoint)
                    try DesktopCloudAccountStore.shared.save(account)
                    SettingsStore.shared.leaderboardHandle = account.handle
                    // Authorizing cloud sync makes its destination explicit.
                    SettingsStore.shared.leaderboardCloudURL = configuredBaseURL
                    self.accountName = account.displayName
                    self.finish(.success(()))
                } catch { self.failed(error) }
            }
        }
    }

    private func request(endpoint: URL, action: String, body: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let url = Self.authURL(endpoint: endpoint, action: action)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        task = session.dataTask(with: request) { data, response, error in
            let result: Result<[String: Any], Error>
            if let error { result = .failure(Self.failure("Could not reach sign-in. Check your connection and try again. \(error.localizedDescription)")) }
            else if let data, data.count <= 65536, let http = response as? HTTPURLResponse,
                    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if (200..<300).contains(http.statusCode) { result = .success(object) }
                else {
                    let serverError = (object["error"] as? String).map { String($0.prefix(400)) }
                    result = .failure(Self.failure(serverError ?? "Sign-in is unavailable on this cloud server. Try again after the server is updated."))
                }
            } else { result = .failure(Self.failure("Sign-in is unavailable on this cloud server. Try again after the server is updated.")) }
            DispatchQueue.main.async { completion(result) }
        }
        task?.resume()
    }

    private func failed(_ failure: Error) {
        pollTimer?.invalidate(); pollTimer = nil
        authorizationURL = nil; isWaiting = false; error = failure.localizedDescription
        message = "Your usage stays on this Mac until you connect."
    }
    private func finish(_ result: Result<Void, Error>) {
        task?.cancel(); task = nil; pollTimer?.invalidate(); pollTimer = nil
        authorizationURL = nil; run = nil; isWaiting = false; isPresented = false
        let callbacks = completions; completions = []
        callbacks.forEach { $0(result) }
    }

    static func base64URL(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func authURL(endpoint: URL, action: String) -> URL {
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        let suffix = path.hasSuffix("/api/leaderboard") ? "/api/leaderboard" : "/leaderboard"
        if path.hasSuffix(suffix) { path.removeLast(suffix.count) }
        components.percentEncodedPath = path + "/api/desktop/" + action
        components.query = nil; components.fragment = nil
        return components.url!
    }
    static func isSecure(_ url: URL) -> Bool { url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) }
    static func isAuthorizationURL(_ url: URL, endpoint: URL) -> Bool {
        isSecure(url) && url.scheme == endpoint.scheme && url.host == endpoint.host && url.port == endpoint.port
            && url.user == nil && url.password == nil && url.path.hasSuffix("/connect") && url.fragment == nil
    }
    static func account(from response: [String: Any], endpoint: URL, now: Date = Date()) throws -> DesktopCloudAccount {
        guard let token = CloudPublishCredentials.validatedToken(response["accessToken"] as? String),
              token.range(of: "^thd_[a-f0-9]{64}$", options: .regularExpression) != nil,
              let raw = response["handle"] as? String,
              raw.range(of: "^[a-zA-Z0-9_.-]{1,64}$", options: .regularExpression) != nil, raw != ".", raw != "..",
              let expiry = response["expiresAt"] as? Double, expiry > (now.timeIntervalSince1970 + 30) * 1000,
              let userObject = response["user"] as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: userObject),
              let user = try? JSONDecoder().decode(DesktopCloudAccount.User.self, from: data),
              ["google", "github"].contains(user.provider), !user.sub.isEmpty else {
            throw failure("Your connection could not be verified. Start sign-in again.")
        }
        return DesktopCloudAccount(endpoint: endpoint.absoluteString, handle: CloudPublishCredentials.effectiveHandle(raw),
            accessToken: token, expiresAt: Date(timeIntervalSince1970: expiry / 1000), user: user)
    }
    private static func failure(_ message: String) -> Error { NSError(domain: "TokenHorizon", code: 401, userInfo: [NSLocalizedDescriptionKey: message]) }
}
