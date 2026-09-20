import Foundation

/// Pseudonymous per-account identity for multi-account vendors.
///
/// One LLM vendor can be used through several accounts on the same machine
/// (two Anthropic profiles, a personal and a work Zhipu key, ...). Limits and
/// usage must consolidate against the SAME account, but raw credentials must
/// never be persisted — so an account is identified by a truncated SHA-256 of
/// the credential, namespaced by vendor:
///
///   AccountKey.forCredential(vendor: "claude", credential: "sk-ant-...")
///   → "claude:a3f19c2e7b4d8051"
///
/// Properties:
/// - stable: same credential → same key, across restarts and machines
/// - one-way: the key cannot be reversed into the credential
/// - vendor-scoped: the same credential reused across gateways yields
///   different account ids (deliberate — quota pools differ)
public enum AccountKey {

    /// Derive the account key for a credential. The credential may carry a
    /// scheme prefix ("Bearer ...") — it is stripped before hashing. Empty
    /// input yields the empty key (single-account / unknown account).
    public static func forCredential(vendor: String, credential: String) -> String {
        var c = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        if c.lowercased().hasPrefix("bearer ") { c = String(c.dropFirst(7)) }
        guard !c.isEmpty else { return "" }
        let digest = SHA256.hash(Data(c.utf8))
        let hex = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        return "\(Canonical.vendor(vendor)):\(hex)"
    }

    /// Derive the account key from meter-observed request headers.
    /// Checks the common credential carriers in order.
    public static func forRequestHeaders(vendor: String, headers: [String: String]) -> String {
        for name in ["authorization", "x-api-key", "api-key", "x-goog-api-key"] {
            if let value = headers[name], !value.isEmpty {
                return forCredential(vendor: vendor, credential: value)
            }
        }
        return ""
    }
}

/// Minimal pure-Swift SHA-256 (Foundation/CommonCrypto are not portable to
/// Linux/Windows; used only for credential pseudonymization).
public enum SHA256 {
    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    public static func hash(_ data: Data) -> [UInt8] {
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var msg = [UInt8](data)
        let bitLen = UInt64(msg.count) * 8
        msg.append(0x80)
        while msg.count % 64 != 56 { msg.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            msg.append(UInt8((bitLen >> UInt64(shift)) & 0xff))
        }
        for chunkStart in stride(from: 0, to: msg.count, by: 64) {
            var w = [UInt32](repeating: 0, count: 64)
            for i in 0..<16 {
                let o = chunkStart + i * 4
                w[i] = (UInt32(msg[o]) << 24) | (UInt32(msg[o + 1]) << 16)
                     | (UInt32(msg[o + 2]) << 8) | UInt32(msg[o + 3])
            }
            for i in 16..<64 {
                let s0 = rotate(w[i - 15], by: 7) ^ rotate(w[i - 15], by: 18) ^ (w[i - 15] >> 3)
                let s1 = rotate(w[i - 2], by: 17) ^ rotate(w[i - 2], by: 19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var a = h[0], b = h[1], c = h[2], d = h[3]
            var e = h[4], f = h[5], g = h[6], hh = h[7]
            for i in 0..<64 {
                let s1 = rotate(e, by: 6) ^ rotate(e, by: 11) ^ rotate(e, by: 25)
                let ch = (e & f) ^ (~e & g)
                let t1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
                let s0 = rotate(a, by: 2) ^ rotate(a, by: 13) ^ rotate(a, by: 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let t2 = s0 &+ maj
                hh = g; g = f; f = e; e = d &+ t1
                d = c; c = b; b = a; a = t1 &+ t2
            }
            h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
            h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
        }
        var out = [UInt8]()
        for word in h {
            out.append(UInt8((word >> 24) & 0xff))
            out.append(UInt8((word >> 16) & 0xff))
            out.append(UInt8((word >> 8) & 0xff))
            out.append(UInt8(word & 0xff))
        }
        return out
    }

    private static func rotate(_ x: UInt32, by n: UInt32) -> UInt32 {
        (x >> n) | (x << (32 - n))
    }
}
