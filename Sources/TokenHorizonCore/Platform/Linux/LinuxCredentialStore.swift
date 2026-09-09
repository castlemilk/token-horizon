#if os(Linux)
import Foundation

/// Linux secret storage. Stub — returns nil until a libsecret/`secret-tool`
/// backend is implemented. Callers fall back to files/env vars.
public struct LinuxCredentialStore: CredentialStore {
    public init() {}

    public func genericPassword(service: String, account: String?) -> String? {
        nil
    }
}
#endif // os(Linux)
