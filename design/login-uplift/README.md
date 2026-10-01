# Login and account design exploration

Generated with the built-in imagegen tool. These are visual concepts, not production screenshots or authentication records. The implementation retains the official Google account button and uses server-verified identity; it cannot read arbitrary Chrome profile data. The black-hole animation is implemented in code and follows the mineral/graphite/mint palette.

## Login page

Asset: `login-page-v1.png`

Final prompt:

```text
Use case: ui-mockup
Asset type: high-fidelity desktop login page concept for Token Horizon.
Primary request: Redesign Token Horizon sign-in to align with its bespoke crisp Apple HIG-inspired public profile, with real provider choice and a memorable ASCII black hole.
Input images: Image 1 (/tmp/token-horizon-login-before.jpg) is the existing sign-in reference only; Image 2 (token-horizon-profile-live.jpg) is the approved brand palette and typography reference only. Do not replicate the old dense modal.
Composition: straight-on shippable desktop website at 1440-wide proportions, graphite public header with Token Horizon logo, quiet Models / Community / Docs navigation. Centered large two-column login surface: graphite visual panel with a beautifully resolved mint animated-ASCII/dither black hole, restrained orbital hairline and small caption; mineral white form panel with generous whitespace, compact horizon mark, 'Welcome back.' heading and short purpose text. Two clear full-width provider actions 'Continue with Google' and 'Continue with GitHub', recognizable official provider marks. A subtle remembered account row with avatar and 'Ben Ebsworth', 'Use another account'. Bottom compact plain-language privacy note and link 'Explore without signing in'. No passwords or email form.
Style: precise flat 1px lines, slightly squared 8px controls, Hubot Sans-like distinctive geometric grotesk headings, JetBrains Mono for tiny incidental detail. Colors mineral #F3F5EF, graphite #101710, forest #235E43, mint #C9F0D2, muted #68746A. The art is ASCII characters and Bayer dither, no blue/gold/purple glow.
Text (verbatim): 'Token Horizon', 'Welcome back.', 'Your workspace, team and shared reports.', 'Continue with Google', 'Continue with GitHub', 'Ben Ebsworth', 'Use another account', 'Explore without signing in', 'Your local prompts and traces stay on your device.'
Constraints: front-on UI concept, readable practical account controls, no invented token data, no watermarks, no perspective/device mockup. Account personalization is supplied by supported provider sign-in, never reading a raw Chrome profile.
```

## Modal and mobile

Asset: `login-modal-mobile-v1.png`

Final prompt:

```text
Use case: ui-mockup
Asset type: high-fidelity Token Horizon sign-in modal and mobile login concept board.
Primary request: Refine the desktop sign-in modal and responsive mobile login as one coherent design system, keeping the animated ASCII black-hole identity and Google plus GitHub choices.
Input images: Image 1 is the old login reference only; Image 2 is the approved live Token Horizon profile for palette and typography.
Composition: one clean design presentation on mineral backdrop containing a large desktop modal above/left and a compact mobile login view beside it, both flat front-on with no device shells. Desktop modal about 820px wide: narrow graphite ASCII black-hole art panel, roomy mineral sign-in panel, clear top-right close button, headline 'Sign in to continue', one small action context line 'Share your usage report', Google and GitHub full-width buttons, remembered account chip, three quiet benefits using clean line symbols for workspace, team, reports. Mobile stacks compact art strip above the same login controls and an unobtrusive back control. Show an accessible deliberate hierarchy and generous touch targets.
Style: restrained mineral/graphite/forest/mint Token Horizon brand, Hubot-like grotesk headings, thin crisp borders, 8px corner radius. Use ASCII/dither orbital black hole only as the art centerpiece; no gradients/glass/purple glow. Modal backdrop is subtly dimmed profile UI with no fabricated metrics.
Text (verbatim): 'Sign in to continue', 'Share your usage report', 'Continue with Google', 'Continue with GitHub', 'Your workspace', 'Your team', 'Your reports', 'Not now', 'Your local data stays local.'
Constraints: readable UI concept, no browser chrome, no invented usage or private content, no watermark. Keep Google recognizable and provider button clear.
```

## Account states

Asset: `account-states-v1.png`

Final prompt:

```text
Use case: ui-mockup
Asset type: Token Horizon account and authentication component states concept board.
Primary request: Design polished practical small authentication elements to accompany the new login page and modals.
Composition: flat front-on six component samples on a mineral canvas: remembered Google account row with avatar Ben Ebsworth and change-account button; remembered GitHub account row with avatar @castlemilk; compact signed-in account dropdown with 'Workspace', 'Manage connections', 'Use another account', 'Sign out'; skeleton provider loader with geometric placeholder rows and small ASCII orbit progress; clear retry state 'Sign-in could not load' and 'Try again'; success state 'You’re signed in' with a quiet forest check and 'Open workspace'. Arrange with precise grid alignment and ample spacing, no decorative labels except concise state names.
Style: same bespoke Token Horizon mineral #F3F5EF, graphite #101710, forest #235E43 and pale mint palette, crisp 1px rules, Hubot-like grotesk and small JetBrains Mono typography, 8px controls. Actual Google/GitHub marks, no emojis, no purple, no neon glow, no giant cards.
Constraints: professional shippable component visual exploration, readable text, no password/secret fields, no token data, no watermark, no device mockup. Remembered identity is a display hint, authentication is verified separately.
```
