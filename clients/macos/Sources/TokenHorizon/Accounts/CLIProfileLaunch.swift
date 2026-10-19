import Foundation

enum CLIProfileLaunchAction: String, Codable, CaseIterable {
    case agent, shell, signIn, signOut

    var title: String {
        switch self {
        case .agent: return "Launch"
        case .shell: return "Open shell"
        case .signIn: return "Sign in"
        case .signOut: return "Sign out"
        }
    }
}

/// Builds an isolated process launch. It never copies credentials or swaps a CLI's default auth file.
enum CLIProfileLaunch {
    static func request(profile: ManagedCLIProfile, action: CLIProfileLaunchAction,
                        workingDirectory: String,
                        useDefaultClaudeEnvironment: Bool = false) throws -> GhosttyLaunchRequest {
        try validate(profile: profile, workingDirectory: workingDirectory)
        if useDefaultClaudeEnvironment {
            guard profile.provider == .claude,
                  ClaudeProfileIdentity.keychainServices(for: profile.configDir).first == "Claude Code-credentials" else {
                throw ManagedCLIProfileError.invalidInput("Only the default Claude profile can use its unscoped sign-in.")
            }
        }
        let executable: String
        var arguments: [String] = []
        if action == .shell {
            // The outer launch shell has already loaded normal startup files and then
            // reasserted the selected account. Do not load them again and lose that choice.
            executable = "/bin/zsh"
            arguments = ["-f", "-i"]
        } else {
            executable = profile.provider.executable
            switch profile.provider {
            case .claude:
                switch action {
                case .agent: break
                case .signIn:
                    arguments = ["auth", "login"]
                    if !profile.expectedEmail.isEmpty { arguments += ["--email", profile.expectedEmail] }
                case .signOut: arguments = ["auth", "logout"]
                case .shell: break
                }
            case .codex:
                // Only profiles created here opt into per-directory file auth storage.
                // Imported configurations keep their existing keychain/file policy.
                if profile.createdByApp { arguments = ["-c", "cli_auth_credentials_store=\"file\""] }
                switch action {
                case .agent: break
                case .signIn: arguments += ["login", "--device-auth"]
                case .signOut: arguments += ["logout"]
                case .shell: break
                }
            }
        }
        var unsetEnvironment: [String]
        switch profile.provider {
        case .claude:
            unsetEnvironment = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
        case .codex:
            unsetEnvironment = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]
        }
        if useDefaultClaudeEnvironment { unsetEnvironment.append("CLAUDE_CONFIG_DIR") }
        var titleParts = [profile.provider.title, profile.name]
        let project = URL(fileURLWithPath: workingDirectory).lastPathComponent
        if !project.isEmpty && project != "/" { titleParts.append(project) }
        if action != .agent { titleParts.append(action.title) }
        return GhosttyLaunchRequest(
            executable: executable, arguments: arguments,
            environment: useDefaultClaudeEnvironment ? [:] : [profile.provider.environmentKey: profile.configDir],
            unsetEnvironment: unsetEnvironment, workingDirectory: workingDirectory,
            title: titleParts.joined(separator: " · "), destination: .window,
            keepOpenAfterExit: true)
    }

    private static func validate(profile: ManagedCLIProfile, workingDirectory: String) throws {
        let name = profile.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name == profile.name, name.count <= 80,
              name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
              !containsControlCharacters(name) else {
            throw ManagedCLIProfileError.invalidInput("Choose an account name without slashes or line breaks.")
        }
        try validatePath(profile.configDir, profileDirectory: true)
        try validatePath(workingDirectory, profileDirectory: false)
        let email = profile.expectedEmail
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard email.count <= 254, !email.hasPrefix("-"),
              !email.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }),
              email.isEmpty || (parts.count == 2 && parts.allSatisfy { !$0.isEmpty }) else {
            throw ManagedCLIProfileError.invalidInput("Enter a valid expected account email, or leave it empty.")
        }
    }

    private static func validatePath(_ path: String, profileDirectory: Bool) throws {
        guard path.hasPrefix("/"), path.utf8.count <= 4096,
              path == path.trimmingCharacters(in: .whitespacesAndNewlines),
              !containsControlCharacters(path),
              !profileDirectory || URL(fileURLWithPath: path).standardizedFileURL.path != "/" else {
            throw ManagedCLIProfileError.invalidInput("Choose an absolute folder path without line breaks or surrounding whitespace.")
        }
    }

    private static func containsControlCharacters(_ value: String) -> Bool {
        value.unicodeScalars.contains { CharacterSet.controlCharacters.union(.newlines).contains($0) }
    }
}
