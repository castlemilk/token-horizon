import Foundation

/// Keep unsaved text in memory when the hover surface closes. Saved toggles
/// are reloaded from SettingsStore so other app surfaces remain authoritative.
struct CompactSettingsDraft {
    var cookie: String
    var handle: String
    var team: String
    var cloudURL: String
    var appToken: String
    var claimToken: String
    var sheetsURL: String
    var destination: String
    var profileNotice: String?
    var connectionNotice: String?
}
