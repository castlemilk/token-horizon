import Foundation

/// Fixed programs plus argv data keep profile paths, titles and arguments out of AppleScript source.
/// Only launch creates a surface; there are deliberately no input/paste/close commands.
struct GhosttyScriptPlan {
    let script: String
    let arguments: [String]

    static func launch(_ request: GhosttyLaunchRequest) throws -> GhosttyScriptPlan {
        guard !request.executable.isEmpty,
              !request.executable.hasPrefix("-"),
              !request.executable.contains("\0") else {
            throw GhosttyError.invalidRequest("Choose a valid command to launch.")
        }
        guard request.workingDirectory.hasPrefix("/"), !request.workingDirectory.contains("\0") else {
            throw GhosttyError.invalidRequest("Choose an absolute working directory.")
        }
        guard !request.title.contains(where: { $0.isNewline || $0 == "\0" }),
              !request.arguments.contains(where: { $0.contains("\0") }) else {
            throw GhosttyError.invalidRequest("Terminal titles and arguments contain unsupported characters.")
        }
        for (key, value) in request.environment {
            guard isEnvironmentName(key),
                  !value.contains("\0") else {
                throw GhosttyError.invalidRequest("The account environment contains an invalid variable.")
            }
        }
        guard request.unsetEnvironment.allSatisfy(isEnvironmentName) else {
            throw GhosttyError.invalidRequest("The account environment contains an invalid variable to remove.")
        }
        let environment = request.environment.keys.sorted().map { "\($0)=\(request.environment[$0]!)" }
        let removedVariables = Set(request.unsetEnvironment).sorted()
        let removalArguments = removedVariables.flatMap { ["-u", $0] }
        // Ghostty interprets an empty assignment as removing an inherited variable.
        let surfaceEnvironment = removedVariables.filter { request.environment[$0] == nil }.map { "\($0)=" } + environment
        // A login shell gets the user's normal CLI PATH. Reassert account variables after
        // startup files so an exported default profile cannot silently change the account.
        let invocation = (["exec", "/usr/bin/env"] + removalArguments + environment + [request.executable] + request.arguments)
            .enumerated().map { $0.offset == 0 ? $0.element : shellQuote($0.element) }.joined(separator: " ")
        let command = "/bin/zsh -l -i -c \(shellQuote(invocation))"
        return GhosttyScriptPlan(script: launchScript,
                                 arguments: [request.destination.rawValue, request.workingDirectory,
                                             command, request.title, request.keepOpenAfterExit ? "true" : "false"] + surfaceEnvironment)
    }

    private static func isEnvironmentName(_ name: String) -> Bool {
        name.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) == name.startIndex..<name.endIndex
    }

    static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func parseInventory(_ output: String) throws -> [GhosttyTerminal] {
        guard let data = output.data(using: .utf8),
              let terminals = try? JSONDecoder().decode([GhosttyTerminal].self, from: data),
              terminals.allSatisfy({ UUID(uuidString: $0.id) != nil && !$0.windowID.isEmpty && !$0.tabID.isEmpty }),
              Set(terminals.map(\.id)).count == terminals.count else { throw GhosttyError.invalidResponse }
        return terminals
    }

    static func parseSession(_ output: String) throws -> GhosttySession {
        guard let data = output.data(using: .utf8),
              let session = try? JSONDecoder().decode(GhosttySession.self, from: data),
              UUID(uuidString: session.terminalID) != nil,
              !session.windowID.isEmpty, !session.tabID.isEmpty else { throw GhosttyError.invalidResponse }
        return session
    }

    static let inventoryScript = #"""
    use framework "Foundation"
    use scripting additions
    on run argv
        if application id "com.mitchellh.ghostty" is not running then return "[]"
        set rows to current application's NSMutableArray's array()
        tell application id "com.mitchellh.ghostty"
            -- A value record checks scripting availability without creating a terminal.
            -- Disabled scripting otherwise silently reports an empty windows collection.
            set scriptingCheck to new surface configuration
            repeat with win in windows
                set winID to id of win as text
                set winTitle to name of win as text
                repeat with ghostTab in tabs of win
                    set tabID to id of ghostTab as text
                    set tabTitle to name of ghostTab as text
                    set selectedTab to selected of ghostTab
                    repeat with term in terminals of ghostTab
                        set row to current application's NSMutableDictionary's dictionary()
                        row's setObject:(id of term as text) forKey:"id"
                        row's setObject:winID forKey:"windowID"
                        row's setObject:tabID forKey:"tabID"
                        row's setObject:(name of term as text) forKey:"title"
                        row's setObject:(working directory of term as text) forKey:"workingDirectory"
                        row's setObject:winTitle forKey:"windowTitle"
                        row's setObject:tabTitle forKey:"tabTitle"
                        row's setObject:(current application's NSNumber's numberWithBool:selectedTab) forKey:"isSelected"
                        rows's addObject:row
                    end repeat
                end repeat
            end repeat
        end tell
        set jsonData to current application's NSJSONSerialization's dataWithJSONObject:rows options:0 |error|:(missing value)
        return (current application's NSString's alloc()'s initWithData:jsonData encoding:4) as text
    end run
    """#

    static let focusScript = #"""
    on run argv
        set terminalID to item 1 of argv
        if application id "com.mitchellh.ghostty" is not running then error number -600
        tell application id "com.mitchellh.ghostty"
            focus terminal id terminalID
        end tell
    end run
    """#

    static let launchScript = #"""
    use framework "Foundation"
    use scripting additions
    on run argv
        set destination to item 1 of argv
        set accountDirectory to item 2 of argv
        set launchCommand to item 3 of argv
        set terminalTitle to item 4 of argv
        set keepOpen to (item 5 of argv is "true")
        set accountEnvironment to {}
        if (count of argv) > 5 then set accountEnvironment to items 6 thru -1 of argv
        tell application id "com.mitchellh.ghostty"
            set cfg to new surface configuration
            set initial working directory of cfg to accountDirectory
            set command of cfg to launchCommand
            set environment variables of cfg to accountEnvironment
            set wait after command of cfg to keepOpen
            if destination is "tab" and (count of windows) > 0 then
                set win to front window
                set ghostTab to new tab in win with configuration cfg
            else
                set win to new window with configuration cfg
                set ghostTab to selected tab of win
            end if
            set term to focused terminal of ghostTab
            try
                activate window win
            end try
            if terminalTitle is not "" then
                try
                    perform action ("set_tab_title:" & terminalTitle) on term
                end try
            end if
            set row to current application's NSMutableDictionary's dictionary()
            row's setObject:(id of win as text) forKey:"windowID"
            row's setObject:(id of ghostTab as text) forKey:"tabID"
            row's setObject:(id of term as text) forKey:"terminalID"
        end tell
        set jsonData to current application's NSJSONSerialization's dataWithJSONObject:row options:0 |error|:(missing value)
        return (current application's NSString's alloc()'s initWithData:jsonData encoding:4) as text
    end run
    """#
}
