import SwiftUI

/// Account selection and terminal navigation extend the existing Shells
/// surface. Live CLI sessions remain independent of the selected default.
struct AccountsTerminalsView: View {
    @ObservedObject var manager: CLIAccountManager = .shared
    @State private var provider = "all"
    @State private var search = ""
    @State private var showHidden = false
    @State private var editor: CLIProfileEditorDraft?
    @State private var signOutProfile: ManagedCLIProfile?

    private var visibleAccounts: [CLIAccountRow] {
        manager.accounts.filter { row in
            (showHidden || !row.profile.isHidden)
                && (provider == "all" || row.profile.provider.rawValue == provider)
                && matches([row.name, row.email, row.profile.expectedEmail, row.profile.configDir])
        }
    }

    private var visibleTerminals: [GhosttyTerminal] {
        manager.terminals.filter { terminal in
            let session = manager.sessions.first { $0.id == terminal.id }
            let row = manager.accounts.first { $0.id == session?.profileID }
            return (provider == "all" || row?.profile.provider.rawValue == provider)
                && matches([terminal.title, terminal.tabTitle, terminal.workingDirectory,
                            row?.name ?? "", row?.email ?? ""])
        }
    }

    private func matches(_ values: [String]) -> Bool {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || values.contains { $0.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            projectPicker
            if let error = manager.errorMessage {
                message(error, symbol: "exclamationmark.triangle", color: .orange)
            } else if let notice = manager.notice {
                message(notice, symbol: "checkmark.circle", color: .green)
            }
            if let draft = editor {
                CLIProfileEditor(draft: draft, manager: manager) { editor = nil }
                    .id(draft.id)
            }
            accountList
            terminalList
        }
        .padding(.vertical, 4)
        .onAppear { manager.refreshAccounts() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("planLimitsUpdated"))) { _ in
            manager.refreshAccounts()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                if Task.isCancelled { break }
                manager.refreshAccounts()
                if manager.hasLoadedTerminals { manager.refreshTerminals(clearError: false) }
            }
        }
        .alert("Sign out of this profile?", isPresented: Binding(
            get: { signOutProfile != nil }, set: { if !$0 { signOutProfile = nil } })) {
            Button("Cancel", role: .cancel) { signOutProfile = nil }
            Button("Sign out", role: .destructive) {
                if let profile = signOutProfile { manager.launch(profile, action: .signOut) }
                signOutProfile = nil
            }
        } message: {
            Text("The CLI will remove the saved sign-in for \(signOutProfile?.name ?? "this profile"). Its history stays on disk.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Accounts & terminals").font(.system(size: 17, weight: .semibold))
                    Text("Choose an account and open your project in Ghostty.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Menu {
                    ForEach(CLIAccountProvider.allCases) { tool in
                        Button("New \(tool.title) profile") {
                            editor = CLIProfileEditorDraft(provider: tool)
                        }
                    }
                    Divider()
                    Button("Import an existing profile…") {
                        editor = CLIProfileEditorDraft(provider: .claude, importing: true)
                    }
                } label: {
                    Label("Add account", systemImage: "plus")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                Menu {
                    ForEach(CLIAccountProvider.allCases) { tool in
                        Button("New \(tool.title) window") { manager.launchDefault(tool) }
                            .disabled(!manager.accounts.contains { $0.profile.provider == tool && !$0.profile.isHidden && $0.directoryExists && !$0.hasIdentityMismatch })
                    }
                    Divider()
                    ForEach(manager.accounts.filter { !$0.profile.isHidden }) { row in
                        Button("\(row.profile.provider.title) · \(row.name)\(row.isDefault ? " (default)" : "")") {
                            manager.launch(row.profile)
                        }
                        .disabled(!row.directoryExists || row.hasIdentityMismatch)
                    }
                } label: {
                    Label("New window", systemImage: "macwindow.badge.plus")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(manager.accounts.isEmpty || manager.launchingProfileID != nil)
                Button {
                    manager.refreshAccounts(refreshQuotas: true)
                } label: {
                    if manager.isRefreshingAccounts {
                        ProgressView().controlSize(.small).frame(width: 18, height: 18)
                    } else {
                        Image(systemName: "arrow.clockwise").frame(width: 18, height: 18)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh account sign-ins and quotas")
                .disabled(manager.isRefreshingAccounts)
            }
            HStack(spacing: 12) {
                TextField("Find an account, project or terminal", text: $search)
                    .textFieldStyle(.roundedBorder)
                Picker("Accounts", selection: $provider) {
                    Text("All").tag("all")
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 220)
            }
        }
    }

    private var projectPicker: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder").foregroundStyle(.secondary)
            Text("Project").font(.system(size: 12, weight: .medium))
            TextField("Project folder", text: $manager.workingDirectory)
                .font(.system(size: 11, design: .monospaced))
                .textFieldStyle(.roundedBorder)
                .onSubmit { manager.persistProject() }
            Button("Choose…") { manager.chooseProject() }
                .controlSize(.small)
        }
    }

    private var accountList: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Accounts").font(.system(size: 13, weight: .semibold))
                Spacer()
                if manager.accounts.contains(where: { $0.profile.isHidden }) {
                    Toggle("Show hidden", isOn: $showHidden)
                        .toggleStyle(.checkbox).font(.system(size: 11))
                }
            }
            if visibleAccounts.isEmpty {
                Text(search.isEmpty
                     ? "Add a profile to keep a separate Claude or Codex sign-in."
                     : "No accounts match this search.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.vertical, 14)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(visibleAccounts.enumerated()), id: \.element.id) { index, row in
                        accountRow(row)
                        if index < visibleAccounts.count - 1 {
                            Divider().overlay(Color.white.opacity(0.05)).padding(.horizontal, 12)
                        }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.035)))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.09)))
            }
            Text("Defaults apply to new sessions. Each window keeps its own profile.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    private func accountRow(_ row: CLIAccountRow) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ProviderLogoView(provider: row.profile.provider.rawValue, size: 22).padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Text(row.name).font(.system(size: 13, weight: .semibold))
                    Text(row.profile.provider.title).font(.system(size: 10)).foregroundStyle(.secondary)
                    if row.isDefault {
                        Label("Default", systemImage: "checkmark.circle.fill")
                            .font(.system(size: 10)).foregroundStyle(.cyan)
                    }
                    if row.profile.isHidden {
                        Text("Hidden").font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
                Text(row.email.isEmpty ? "Sign-in has not been verified" : row.email)
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1).truncationMode(.middle)
                if row.hasIdentityMismatch {
                    Text("Signed in with a different account. Expected \(row.profile.expectedEmail).")
                        .font(.system(size: 11)).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                } else if !row.directoryExists {
                    Text("Profile folder is unavailable").font(.system(size: 11)).foregroundStyle(.orange)
                } else if let status = row.status, !status.isEmpty {
                    Text(status).font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                quotaLine(row)
                Text((row.profile.configDir as NSString).abbreviatingWithTildeInPath)
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .accessibilityLabel("Profile folder \(row.profile.configDir)")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 9) {
                if row.profile.isHidden {
                    Button("Show profile") { manager.setHidden(row.profile, hidden: false) }
                        .controlSize(.small)
                } else {
                    Button {
                        manager.launch(row.profile)
                    } label: {
                        HStack(spacing: 5) {
                            if manager.launchingProfileID == row.id {
                                ProgressView().controlSize(.mini)
                            } else {
                                Image(systemName: "terminal")
                            }
                            Text(row.profile.provider == .claude ? "Open Claude" : "Open Codex")
                        }
                    }
                    .controlSize(.small)
                    .disabled(manager.launchingProfileID != nil || !row.directoryExists || row.hasIdentityMismatch)
                }
                Menu {
                    Button("Open profile shell") { manager.launch(row.profile, action: .shell) }
                    Button("Sign in / reconnect…") { manager.launch(row.profile, action: .signIn) }
                    Divider()
                    Button("Use for new \(row.profile.provider.title) sessions") { manager.setDefault(row.profile) }
                    Button("Edit profile…") { editor = CLIProfileEditorDraft(profile: row.profile) }
                    Button(row.profile.isHidden ? "Show profile" : "Hide profile") {
                        manager.setHidden(row.profile, hidden: !row.profile.isHidden)
                    }
                    Divider()
                    Button("Sign out…") { signOutProfile = row.profile }
                } label: {
                    Label("Manage", systemImage: "ellipsis")
                        .font(.system(size: 11))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(manager.launchingProfileID != nil)
                .accessibilityLabel("Manage \(row.name)")
            }
        }
        .padding(12)
    }

    @ViewBuilder
    private func quotaLine(_ row: CLIAccountRow) -> some View {
        if row.burst != nil || row.cycle != nil {
            HStack(spacing: 14) {
                if let burst = row.burst { quota(burst) }
                if let cycle = row.cycle { quota(cycle) }
                if !row.plan.isEmpty { Text(row.plan).foregroundStyle(.secondary) }
            }
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .monospacedDigit()
        }
    }

    private func quota(_ limit: ProviderLimit) -> some View {
        Text("\(limit.label) · \(Int(max(0, 100 - limit.usedPercent)))% left")
            .foregroundStyle(limit.usedPercent >= 90 ? Color.orange : Color.white.opacity(0.75))
    }

    private var terminalList: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Ghostty terminals").font(.system(size: 13, weight: .semibold))
                if let version = manager.ghostty.installedVersion {
                    Text(version).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                }
                Spacer()
                if manager.isRefreshingTerminals { ProgressView().controlSize(.small) }
                Button(manager.hasLoadedTerminals ? "Refresh terminals" : "Connect Ghostty") {
                    manager.refreshTerminals()
                }
                .controlSize(.small)
                .disabled(manager.isRefreshingTerminals || !manager.ghostty.isInstalled)
            }
            if !manager.ghostty.isInstalled {
                HStack {
                    Text("Install Ghostty 1.3 or later to open and manage account windows.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    Link("Get Ghostty", destination: URL(string: "https://ghostty.org")!)
                        .font(.system(size: 12))
                }
            } else if !manager.hasLoadedTerminals {
                Text("Connect to list your windows and jump directly to a terminal.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            } else if visibleTerminals.isEmpty {
                Text(search.isEmpty && provider == "all"
                     ? "No Ghostty windows are open. Launch an account above to start."
                     : "No terminals match this account or search.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(visibleTerminals) { terminal in
                        terminalRow(terminal)
                        if terminal.id != visibleTerminals.last?.id {
                            Divider().overlay(Color.white.opacity(0.05))
                        }
                    }
                }
            }
        }
    }

    private func terminalRow(_ terminal: GhosttyTerminal) -> some View {
        let session = manager.sessions.first { $0.id == terminal.id }
        let account = manager.accounts.first { $0.id == session?.profileID }
        return HStack(spacing: 12) {
            Image(systemName: "macwindow").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(terminal.tabTitle.isEmpty ? terminal.title : terminal.tabTitle)
                    .font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 8) {
                    if let account {
                        Text(account.name).font(.system(size: 10, weight: .medium)).foregroundStyle(.cyan)
                    }
                    Text((terminal.workingDirectory as NSString).abbreviatingWithTildeInPath)
                        .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
            Button("Focus") { manager.focus(terminal) }.controlSize(.small)
        }
        .padding(.vertical, 10)
    }

    private func message(_ text: String, symbol: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(color)
            Text(text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button { manager.dismissMessage() } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).accessibilityLabel("Dismiss account message")
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.08)))
    }
}

private struct CLIProfileEditorDraft {
    let id = UUID()
    var profile: ManagedCLIProfile?
    var provider: CLIAccountProvider
    var importing = false
    var name = ""
    var email = ""
    var path = ""

    init(provider: CLIAccountProvider, importing: Bool = false) {
        self.provider = provider
        self.importing = importing
    }
    init(profile: ManagedCLIProfile) {
        self.profile = profile
        provider = profile.provider
        name = profile.name
        email = profile.expectedEmail
        path = profile.configDir
    }
}

private struct CLIProfileEditor: View {
    @State var draft: CLIProfileEditorDraft
    @ObservedObject var manager: CLIAccountManager
    var onClose: () -> Void
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(draft.profile != nil ? "Edit profile" : draft.importing ? "Import a profile" : "Add an account")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Cancel", action: onClose).controlSize(.small).disabled(saving)
            }
            if draft.profile == nil {
                Picker("Tool", selection: $draft.provider) {
                    ForEach(CLIAccountProvider.allCases) { tool in Text(tool.title).tag(tool) }
                }.pickerStyle(.segmented)
            }
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Profile name").font(.system(size: 11)).foregroundStyle(.secondary)
                    TextField("Personal, Work, Dorja…", text: $draft.name).textFieldStyle(.roundedBorder)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text("Expected email (optional)").font(.system(size: 11)).foregroundStyle(.secondary)
                    TextField("you@example.com", text: $draft.email).textFieldStyle(.roundedBorder)
                }
            }
            if draft.importing {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Existing profile folder").font(.system(size: 11)).foregroundStyle(.secondary)
                    TextField("~/…", text: $draft.path)
                        .font(.system(size: 11, design: .monospaced)).textFieldStyle(.roundedBorder)
                }
            } else if draft.profile == nil {
                Text("Creates a separate configuration folder. Sign in from the profile’s Manage menu after creating it.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Button(draft.profile != nil ? "Save changes" : draft.importing ? "Import profile" : "Create profile") {
                    save()
                }
                .controlSize(.small)
                .disabled(saving || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if saving { ProgressView().controlSize(.small) }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
    }

    private func save() {
        saving = true
        let completion: (Bool) -> Void = { saved in
            saving = false
            if saved { onClose() }
        }
        if var profile = draft.profile {
            profile.name = draft.name
            profile.expectedEmail = draft.email
            manager.saveProfile(profile, completion: completion)
        } else {
            manager.addProfile(provider: draft.provider, name: draft.name, email: draft.email,
                               path: draft.importing ? draft.path : nil, project: nil, completion: completion)
        }
    }
}
