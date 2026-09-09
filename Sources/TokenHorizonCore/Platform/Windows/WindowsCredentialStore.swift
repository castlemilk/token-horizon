#if os(Windows)
import Foundation

/// Windows secret storage. Stub — returns nil until a Credential Manager
/// (wincred) backend is implemented. Callers fall back to files/env vars.
public struct WindowsCredentialStore: CredentialStore {
    public init() {}

    public func genericPassword(service: String, account: String?) -> String? {
        nil
    }
}
#endif // os(Windows)
