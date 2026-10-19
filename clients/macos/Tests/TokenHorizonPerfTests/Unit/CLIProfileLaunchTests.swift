import XCTest
@testable import TokenHorizon

final class CLIProfileLaunchTests: XCTestCase {
    func testClaudeActionsUseOnlyTheSelectedProfile() throws {
        let account = profile(provider: .claude)
        let cases: [(CLIProfileLaunchAction, [String])] = [
            (.agent, []),
            (.signIn, ["auth", "login", "--email", "ben@dorja.com"]),
            (.signOut, ["auth", "logout"])
        ]
        for (action, arguments) in cases {
            let request = try CLIProfileLaunch.request(profile: account, action: action, workingDirectory: "/projects/horizon")
            XCTAssertEqual(request.executable, "claude")
            XCTAssertEqual(request.arguments, arguments)
            XCTAssertEqual(request.environment, ["CLAUDE_CONFIG_DIR": "/profiles/claude-dorja"])
            XCTAssertEqual(request.unsetEnvironment, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
            XCTAssertEqual(request.workingDirectory, "/projects/horizon")
            XCTAssertEqual(request.destination, .window)
            XCTAssertTrue(request.keepOpenAfterExit)
        }
    }

    func testClaudeSignInOmitsEmailFlagWhenNoExpectedEmailIsSaved() throws {
        var account = profile(provider: .claude)
        account.expectedEmail = ""
        let request = try CLIProfileLaunch.request(profile: account, action: .signIn, workingDirectory: "/projects/horizon")
        XCTAssertEqual(request.arguments, ["auth", "login"])
    }

    func testCanonicalUnscopedClaudeLoginKeepsTheSameStoreForEveryAction() throws {
        // Construct a path string only: no host files or Keychain items are read.
        let account = ManagedCLIProfile(provider: .claude, name: "Default", configDir: NSHomeDirectory() + "/.claude")
        for action in CLIProfileLaunchAction.allCases {
            let request = try CLIProfileLaunch.request(profile: account, action: action,
                                                       workingDirectory: "/projects/horizon",
                                                       useDefaultClaudeEnvironment: true)
            XCTAssertTrue(request.environment.isEmpty)
            XCTAssertTrue(request.unsetEnvironment.contains("CLAUDE_CONFIG_DIR"))
            let plan = try GhosttyScriptPlan.launch(request)
            XCTAssertTrue(plan.arguments.contains("CLAUDE_CONFIG_DIR="))
            XCTAssertFalse(plan.arguments.contains("CLAUDE_CONFIG_DIR=\(account.configDir)"))
        }
        let scoped = try CLIProfileLaunch.request(profile: account, action: .agent, workingDirectory: "/projects/horizon")
        XCTAssertEqual(scoped.environment, ["CLAUDE_CONFIG_DIR": account.configDir])
        XCTAssertFalse(scoped.unsetEnvironment.contains("CLAUDE_CONFIG_DIR"))
    }

    func testDefaultClaudeEnvironmentOverrideCannotEscapeAnotherProfileOrProvider() {
        for account in [profile(provider: .claude), profile(provider: .codex)] {
            XCTAssertThrowsError(try CLIProfileLaunch.request(profile: account, action: .agent,
                                                             workingDirectory: "/projects/horizon",
                                                             useDefaultClaudeEnvironment: true))
        }
    }

    func testManagedCodexActionsOverrideCredentialStorageBeforeSubcommand() throws {
        let account = profile(provider: .codex, createdByApp: true)
        let prefix = ["-c", "cli_auth_credentials_store=\"file\""]
        let cases: [(CLIProfileLaunchAction, [String])] = [
            (.agent, prefix),
            (.signIn, prefix + ["login", "--device-auth"]),
            (.signOut, prefix + ["logout"])
        ]
        for (action, arguments) in cases {
            let request = try CLIProfileLaunch.request(profile: account, action: action, workingDirectory: "/projects/horizon")
            XCTAssertEqual(request.executable, "codex")
            XCTAssertEqual(request.arguments, arguments)
            XCTAssertEqual(request.environment, ["CODEX_HOME": "/profiles/codex-dorja"])
            XCTAssertEqual(request.unsetEnvironment, ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"])
            XCTAssertEqual(request.destination, .window)
            XCTAssertTrue(request.keepOpenAfterExit)
        }
    }

    func testImportedCodexActionsKeepExistingCredentialStoragePolicy() throws {
        let account = profile(provider: .codex)
        let cases: [(CLIProfileLaunchAction, [String])] = [
            (.agent, []),
            (.signIn, ["login", "--device-auth"]),
            (.signOut, ["logout"])
        ]
        for (action, arguments) in cases {
            let request = try CLIProfileLaunch.request(profile: account, action: action, workingDirectory: "/projects/horizon")
            XCTAssertEqual(request.arguments, arguments)
            XCTAssertFalse(request.arguments.joined(separator: " ").contains("cli_auth_credentials_store"))
            XCTAssertEqual(request.environment, ["CODEX_HOME": account.configDir])
        }
    }

    func testShellPreservesSelectedEnvironmentAfterOuterShellStartup() throws {
        for provider in CLIAccountProvider.allCases {
            let account = profile(provider: provider, createdByApp: true)
            let request = try CLIProfileLaunch.request(profile: account, action: .shell, workingDirectory: "/projects/horizon")
            XCTAssertEqual(request.executable, "/bin/zsh")
            XCTAssertEqual(request.arguments, ["-f", "-i"])
            XCTAssertEqual(request.environment, [provider.environmentKey: account.configDir])
            XCTAssertFalse(request.arguments.contains("-l"))
            XCTAssertFalse(request.arguments.contains("--login"))
            let plan = try GhosttyScriptPlan.launch(request)
            let assignment = "\(provider.environmentKey)=\(account.configDir)"
            XCTAssertTrue(plan.arguments[2].contains(provider.environmentKey + "="))
            XCTAssertTrue(plan.arguments.contains(assignment))
            XCTAssertFalse(request.unsetEnvironment.contains(provider.environmentKey))
        }
    }

    func testDisplayTitlesShowProviderAccountAndProject() throws {
        let account = profile(provider: .claude)
        XCTAssertEqual(try CLIProfileLaunch.request(profile: account, action: .agent,
                                                   workingDirectory: "/projects/horizon").title,
                       "Claude Code · Dorja · horizon")
        XCTAssertEqual(try CLIProfileLaunch.request(profile: account, action: .signIn,
                                                   workingDirectory: "/projects/horizon").title,
                       "Claude Code · Dorja · horizon · Sign in")
        XCTAssertEqual(try CLIProfileLaunch.request(profile: account, action: .shell,
                                                   workingDirectory: "/").title,
                       "Claude Code · Dorja · Open shell")
    }

    func testMetacharactersStayDataAndCannotAddAnEnvironmentKeyOrCommand() throws {
        var account = profile(provider: .claude)
        account.name = "O'Brien $(id)"
        account.configDir = "/profiles/O'Brien $(touch bad); CODEX_HOME=other"
        let directory = "/projects/a \"quoted\" project; $(touch bad)"
        let request = try CLIProfileLaunch.request(profile: account, action: .agent, workingDirectory: directory)
        XCTAssertEqual(request.executable, "claude")
        XCTAssertEqual(request.arguments, [])
        XCTAssertEqual(request.environment.count, 1)
        XCTAssertEqual(request.environment["CLAUDE_CONFIG_DIR"], account.configDir)
        XCTAssertNil(request.environment["CODEX_HOME"])
        let plan = try GhosttyScriptPlan.launch(request)
        XCTAssertEqual(plan.script, GhosttyScriptPlan.launchScript)
        XCTAssertFalse(plan.script.contains("$(touch bad)"))
        XCTAssertEqual(plan.arguments[1], directory)
        XCTAssertTrue(plan.arguments.contains("CLAUDE_CONFIG_DIR=\(account.configDir)"))
    }

    func testInvalidMetadataIsRejectedBeforeCreatingALaunchPlan() {
        let base = profile(provider: .claude)
        var cases: [(ManagedCLIProfile, String)] = []
        var account = base; account.name = ""; cases.append((account, "/projects/horizon"))
        account = base; account.name = "Dorja\nGmail"; cases.append((account, "/projects/horizon"))
        account = base; account.name = "Dorja\u{2028}Gmail"; cases.append((account, "/projects/horizon"))
        account = base; account.name = "../Dorja"; cases.append((account, "/projects/horizon"))
        account = base; account.configDir = "relative/profile"; cases.append((account, "/projects/horizon"))
        account = base; account.configDir = "/profiles/../"; cases.append((account, "/projects/horizon"))
        account = base; account.configDir = "/profiles/secret\0"; cases.append((account, "/projects/horizon"))
        account = base; account.expectedEmail = "--email=other@example.com"; cases.append((account, "/projects/horizon"))
        account = base; account.expectedEmail = "invalid"; cases.append((account, "/projects/horizon"))
        account = base; account.expectedEmail = "ben@dorja.com\n"; cases.append((account, "/projects/horizon"))
        cases.append((base, "relative/project"))
        cases.append((base, "/projects/horizon\n"))
        cases.append((base, "/projects/horizon\u{2028}other"))
        for (invalid, directory) in cases {
            XCTAssertThrowsError(try CLIProfileLaunch.request(profile: invalid, action: .signIn,
                                                             workingDirectory: directory))
        }
    }

    func testLaunchPlansNeverContainAuthSecretsOrGlobalAuthFileOperations() throws {
        for provider in CLIAccountProvider.allCases {
            for action in CLIProfileLaunchAction.allCases {
                let account = profile(provider: provider, createdByApp: true)
                let request = try CLIProfileLaunch.request(profile: account, action: action, workingDirectory: "/projects/horizon")
                XCTAssertEqual(Set(request.environment.keys), [provider.environmentKey])
                XCTAssertTrue(request.environment.values.allSatisfy { $0 == account.configDir })
                XCTAssertFalse(request.arguments.contains("--with-api-key"))
                XCTAssertFalse(request.arguments.contains("--api-key"))
                let command = request.arguments.joined(separator: " ")
                for operation in ["auth.json", ".credentials.json", "security", "cp ", "mv ", "ln ", "token"] {
                    XCTAssertFalse(command.contains(operation))
                }
            }
        }
    }

    func testLaunchActionRawValuesAreStableForSavedTerminalAssociations() throws {
        for action in CLIProfileLaunchAction.allCases {
            let data = try JSONEncoder().encode(action)
            XCTAssertEqual(try JSONDecoder().decode(CLIProfileLaunchAction.self, from: data), action)
            XCTAssertFalse(action.title.isEmpty)
        }
    }

    private func profile(provider: CLIAccountProvider, createdByApp: Bool = false) -> ManagedCLIProfile {
        ManagedCLIProfile(provider: provider, name: "Dorja", configDir: "/profiles/\(provider.rawValue)-dorja",
                          expectedEmail: "ben@dorja.com", createdByApp: createdByApp)
    }
}
