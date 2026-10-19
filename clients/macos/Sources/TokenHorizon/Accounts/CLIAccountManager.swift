import AppKit
import Combine
import Foundation

struct CLIAccountRow: Identifiable {
    var id: String { profile.id }
    var profile: ManagedCLIProfile
    var email: String
    var plan: String
    var status: String?
    var limits: [ProviderLimit]
    var isDefault: Bool
    var directoryExists: Bool

    var name: String { profile.name }
    var hasIdentityMismatch: Bool {
        !profile.expectedEmail.isEmpty && !email.isEmpty
            && profile.expectedEmail.caseInsensitiveCompare(email) != .orderedSame
    }
    var burst: ProviderLimit? {
        limits.first { !$0.isWeekly && !$0.label.contains("·") }
    }
    var cycle: ProviderLimit? {
        limits.first { $0.label == "weekly" || $0.label == "7d" }
            ?? limits.first { $0.isWeekly && !$0.label.contains("·") }
    }
}

/// One controller is shared by the notch and dashboard. Files, provider calls,
/// and Apple Events run off-main; published state changes stay on main.
final class CLIAccountManager: ObservableObject {
    static let shared = CLIAccountManager()
    @Published private(set) var accounts: [CLIAccountRow] = []
    @Published private(set) var terminals: [GhosttyTerminal] = []
    @Published private(set) var sessions: [ManagedTerminalSession] = []
    @Published private(set) var isRefreshingAccounts = false
    @Published private(set) var isRefreshingTerminals = false
    @Published private(set) var launchingProfileID: String?
    @Published private(set) var hasLoadedTerminals = false
    @Published private(set) var notice: String?
    @Published private(set) var errorMessage: String?
    @Published var workingDirectory: String
    let ghostty: GhosttyAutomation
    let profileStore: ManagedCLIProfileStore
    private let sessionStore: ManagedTerminalSessionStore
    private let accountReader: (() -> [CLIAccountRow])?
    /// Inventory/reconciliation and launch/remember must share one queue: an old
    /// inventory must never remove the association for a newly created surface.
    private let terminalQueue = DispatchQueue(label: "dev.token-horizon.ghostty", qos: .userInitiated)

    init(profileStore: ManagedCLIProfileStore = .shared,
         sessionStore: ManagedTerminalSessionStore = .shared,
         ghostty: GhosttyAutomation = GhosttyAutomation(),
         accountReader: (() -> [CLIAccountRow])? = nil) {
        self.profileStore = profileStore
        self.sessionStore = sessionStore
        self.ghostty = ghostty
        self.accountReader = accountReader
        self.workingDirectory = sessionStore.workingDirectory()
        self.sessions = sessionStore.sessions()
        self.errorMessage = profileStore.loadError ?? sessionStore.loadError
        if let accountReader { self.accounts = accountReader() }
    }

    func refreshAccounts(refreshQuotas: Bool = false) {
        guard !isRefreshingAccounts else { return }
        isRefreshingAccounts = true
        DispatchQueue.global(qos: .utility).async {
            if refreshQuotas && self.accountReader == nil {
                _ = ClaudeDiscovery.shared.fetchAllLimits(force: true)
                _ = CodexAccountDiscovery.shared.fetchAllLimits(force: true)
            }
            let rows = self.accountReader?() ?? self.discoveredAccounts()
            DispatchQueue.main.async {
                self.accounts = rows
                self.isRefreshingAccounts = false
            }
        }
    }

    private func discoveredAccounts() -> [CLIAccountRow] {
        let saved = profileStore.profiles()
        var profiles = Dictionary(uniqueKeysWithValues: saved.map { ($0.id, $0) })
        func add(_ provider: CLIAccountProvider, _ directories: [String]) {
            for directory in directories {
                let id = ManagedCLIProfileStore.profileID(provider: provider, configDir: directory)
                if profiles[id] == nil {
                    let basename = (directory as NSString).lastPathComponent
                    profiles[id] = ManagedCLIProfile(
                        provider: provider, name: basename.hasPrefix(".") ? String(basename.dropFirst()) : basename,
                        configDir: directory, expectedEmail: "", workingDirectory: nil, createdByApp: false)
                }
            }
        }
        add(.claude, ClaudeDiscovery.discoverDirectories())
        add(.codex, CodexAccountDiscovery.discoverDirectories())
        return profiles.values.map { profile in
            let email: String
            let plan: String
            let status: String?
            let limits: [ProviderLimit]
            switch profile.provider {
            case .claude:
                let account = ClaudeDiscovery.shared.accountMetadata(for: profile.configDir)
                email = account.email
                plan = account.organizationType.replacingOccurrences(of: "claude_", with: "").capitalized
                limits = ClaudeDiscovery.shared.cachedLimits(for: profile.configDir)
                status = account.quotaStatus
            case .codex:
                let account = CodexAccountDiscovery.shared.account(forConfigDir: profile.configDir)
                email = account?.email ?? ""
                plan = account?.planType.capitalized ?? ""
                limits = account?.limits ?? []
                status = account?.profileStatuses[profile.configDir] ?? account?.quotaStatus
            }
            return CLIAccountRow(profile: profile, email: email, plan: plan, status: status,
                                 limits: limits,
                                 isDefault: profileStore.defaultProfileID(for: profile.provider) == profile.id,
                                 directoryExists: HomeDiscovery.isDirectory(profile.configDir))
        }.sorted {
            if $0.profile.provider != $1.profile.provider {
                return $0.profile.provider.rawValue < $1.profile.provider.rawValue
            }
            if $0.isDefault != $1.isDefault { return $0.isDefault }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    func refreshTerminals(clearError: Bool = true) {
        guard !isRefreshingTerminals else { return }
        isRefreshingTerminals = true
        if clearError { errorMessage = nil }
        terminalQueue.async {
            do {
                let terminals = try self.ghostty.inventory()
                try self.sessionStore.reconcile(terminalIDs: Set(terminals.map(\.id)))
                let sessions = self.sessionStore.sessions()
                DispatchQueue.main.async {
                    self.terminals = terminals
                    self.sessions = sessions
                    self.hasLoadedTerminals = true
                    self.isRefreshingTerminals = false
                }
            } catch {
                DispatchQueue.main.async {
                    self.errorMessage = error.localizedDescription
                    self.isRefreshingTerminals = false
                }
            }
        }
    }

    func focus(_ terminal: GhosttyTerminal) {
        errorMessage = nil
        terminalQueue.async {
            do {
                try self.ghostty.focus(terminalID: terminal.id)
            } catch {
                DispatchQueue.main.async { self.errorMessage = error.localizedDescription }
            }
        }
    }

    func launch(_ profile: ManagedCLIProfile, action: CLIProfileLaunchAction = .agent) {
        guard launchingProfileID == nil else { return }
        let projectInput = workingDirectory
        let observedEmail = accounts.first(where: { $0.id == profile.id })?.email ?? ""
        launchingProfileID = profile.id
        errorMessage = nil
        notice = nil
        terminalQueue.async {
            do {
                let project = ManagedCLIProfileStore.normalizedPath(
                    projectInput.trimmingCharacters(in: .whitespacesAndNewlines))
                guard HomeDiscovery.isDirectory(project) else {
                    throw ManagedCLIProfileError.invalidInput("Choose an existing project folder before opening a terminal.")
                }
                guard HomeDiscovery.isDirectory(profile.configDir) else {
                    throw ManagedCLIProfileError.invalidInput(
                        "This profile folder is unavailable. Restore it, or use Add account → Import an existing profile… to choose another folder.")
                }
                let isCanonicalClaude = profile.provider == .claude
                    && ClaudeProfileIdentity.keychainServices(for: profile.configDir).first == "Claude Code-credentials"
                if action == .agent, !profile.expectedEmail.isEmpty,
                   !(isCanonicalClaude && self.accountReader == nil) {
                    let email: String
                    if self.accountReader != nil {
                        email = observedEmail
                    } else {
                        switch profile.provider {
                        case .claude: email = ClaudeDiscovery.shared.accountMetadata(for: profile.configDir).email
                        case .codex: email = CodexAccountDiscovery.shared.account(forConfigDir: profile.configDir)?.email ?? ""
                        }
                    }
                    guard email.isEmpty || profile.expectedEmail.caseInsensitiveCompare(email) == .orderedSame else {
                        throw ManagedCLIProfileError.invalidInput(
                            "This profile is signed in as \(email), but expects \(profile.expectedEmail). Use Manage → Sign in / reconnect… before opening \(profile.provider.title).")
                    }
                }
                let useDefaultClaudeEnvironment: Bool
                if isCanonicalClaude && self.accountReader == nil && action == .agent {
                    let matchingEmail = profile.expectedEmail.isEmpty ? observedEmail : profile.expectedEmail
                    useDefaultClaudeEnvironment = try ClaudeDiscovery.shared.verifiedDefaultEnvironmentForAgentLaunch(
                        for: profile.configDir, matchingEmail: matchingEmail)
                } else {
                    useDefaultClaudeEnvironment = profile.provider == .claude && self.accountReader == nil
                        && ClaudeDiscovery.shared.usesDefaultEnvironmentForLaunch(for: profile.configDir)
                }
                let request = try CLIProfileLaunch.request(profile: profile, action: action, workingDirectory: project,
                                                          useDefaultClaudeEnvironment: useDefaultClaudeEnvironment)
                let terminal = try self.ghostty.launch(request)
                let session = ManagedTerminalSession(terminal: terminal, profileID: profile.id,
                                                    action: action, workingDirectory: project)
                var persistenceError: String?
                do { try self.sessionStore.remember(session) }
                catch { persistenceError = "The window opened, but its account label could not be saved." }
                let sessions = self.sessionStore.sessions()
                DispatchQueue.main.async {
                    self.sessions = sessions
                    self.launchingProfileID = nil
                    self.notice = action == .signIn
                        ? "Complete sign-in in the new Ghostty window, then refresh accounts."
                        : "Opened \(profile.name) in a new Ghostty window."
                    self.errorMessage = persistenceError
                    self.refreshTerminals(clearError: false)
                    self.refreshAccounts()
                }
            } catch {
                DispatchQueue.main.async {
                    self.launchingProfileID = nil
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }

    /// Hidden, missing and mismatched profiles cannot become an implicit agent launch.
    /// Explicit shell/reconnect actions can still use a profile with a different identity.
    func defaultProfile(for provider: CLIAccountProvider,
                        action: CLIProfileLaunchAction = .agent) -> ManagedCLIProfile? {
        let eligible = accounts.filter {
            $0.profile.provider == provider && !$0.profile.isHidden && $0.directoryExists
                && (action != .agent || !$0.hasIdentityMismatch)
        }
        if let id = profileStore.defaultProfileID(for: provider) {
            // A missing or mismatched default must never silently select a
            // different billing account. Another row can still be launched explicitly.
            return eligible.first(where: { $0.id == id })?.profile
        }
        return eligible.first?.profile
    }

    func launchDefault(_ provider: CLIAccountProvider, action: CLIProfileLaunchAction = .agent) {
        guard let profile = defaultProfile(for: provider, action: action) else {
            errorMessage = profileStore.defaultProfileID(for: provider) == nil
                ? "No \(provider.title) profile is ready. Add or show a profile, and reconnect it if its sign-in needs attention."
                : "Your default \(provider.title) profile is unavailable. Show or reconnect it, or choose another default from Manage."
            return
        }
        launch(profile, action: action)
    }

    func setDefault(_ profile: ManagedCLIProfile) {
        mutate {
            try self.profileStore.save(profile)
            try self.profileStore.setDefault(profileID: profile.id, provider: profile.provider)
        }
    }

    func setHidden(_ profile: ManagedCLIProfile, hidden: Bool) {
        mutate {
            try self.profileStore.save(profile)
            try self.profileStore.setHidden(profileID: profile.id, hidden: hidden)
        }
    }

    func saveProfile(_ profile: ManagedCLIProfile, completion: @escaping (Bool) -> Void) {
        mutate(completion: completion) { try self.profileStore.save(profile) }
    }

    func addProfile(provider: CLIAccountProvider, name: String, email: String,
                    path: String?, project: String?, completion: @escaping (Bool) -> Void) {
        mutate(completion: completion) {
            if let path {
                _ = try self.profileStore.importProfile(provider: provider, path: path, name: name,
                                                       expectedEmail: email, workingDirectory: project)
            } else {
                _ = try self.profileStore.create(provider: provider, name: name,
                                                expectedEmail: email, workingDirectory: project)
            }
            HomeDiscovery.resetCache()
        }
    }

    private func mutate(completion: ((Bool) -> Void)? = nil, _ mutation: @escaping () throws -> Void) {
        errorMessage = nil
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try mutation()
                DispatchQueue.main.async {
                    self.refreshAccounts()
                    completion?(true)
                }
            } catch {
                DispatchQueue.main.async {
                    self.errorMessage = error.localizedDescription
                    completion?(false)
                }
            }
        }
    }

    func chooseProject() {
        let picker = NSOpenPanel()
        picker.title = "Choose a project folder"
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.directoryURL = URL(fileURLWithPath: workingDirectory)
        NSApp.activate(ignoringOtherApps: true)
        picker.begin { response in
            guard response == .OK, let url = picker.url else { return }
            self.workingDirectory = url.path
            self.persistProject()
        }
    }

    func persistProject() {
        let projectInput = workingDirectory
        terminalQueue.async {
            let directory = ManagedCLIProfileStore.normalizedPath(projectInput)
            guard HomeDiscovery.isDirectory(directory) else { return }
            try? self.sessionStore.setWorkingDirectory(directory)
        }
    }

    func dismissMessage() {
        errorMessage = nil
        notice = nil
    }
}
