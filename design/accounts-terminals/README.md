# Native accounts and terminals

The macOS Terminals tab now combines Claude Code and Codex profiles with project
selection and Ghostty window navigation. Profile names, expected emails, defaults,
visibility, and terminal associations are metadata; credentials remain in the
selected CLI's own storage. Changing a default affects new windows.

Native SwiftUI/AppKit renders were checked at the notch's 740-point width and the
dashboard's 860-point width, plus the empty state. They cover multiple providers,
account defaults, quota headroom, a mismatched email, and a terminal association.
These use synthetic data and capture the account view's full content; the app's
existing vertical scroll view contains it. The temporary capture test was removed.

- [740-point account view](native-accounts-740.png)
- [860-point account view](native-accounts-860.png)
- [Empty state](native-accounts-empty.png)

The final focused run passed 127 tests, including the temporary capture. Permanent
regressions cover profile storage and boundaries, multi-account Codex quotas and
hydration, Claude credential-source selection, OAuth write-back, isolated launch
commands, and serialized terminal inventory/association writes. Native controls
fit both widths; mismatch recovery remains readable and the agent action is
disabled until the expected identity is restored.

The full Swift suite passed 938 tests with zero failures. After the final default
and cold-start refresh refinements, 69 launch/account/OAuth tests passed. They
cover an unavailable saved default refusing to switch to another account
implicitly. SwiftLint, whitespace checks, and 14 installation regressions passed.

Ghostty's three fixed AppleScripts compiled against the installed 1.3.1 scripting
dictionary. Window creation, inventory, focus, and failures are covered with mocked
script results. Automated live Ghostty interaction was blocked because computer
control denied access to that app in this session. The user subsequently confirmed
that **Terminals → Connect Ghostty** lists their windows in the installed app,
verifying live window discovery. Live focus and launch actions were not reported
as manually checked.

The canonical launcher installed and restarted version 0.4.2, commit
`9a5c53f-dirty`, built at `2026-10-15T11:07:08Z`. `/health` returned that stamp
with both sidecar ports, and `/limits` returned separate Gmail, Shorted, and Dorja
Claude quota rows plus the signed-in Codex quota. The installed app's signature,
Apple Events entitlement, and Automation permission description verified.
