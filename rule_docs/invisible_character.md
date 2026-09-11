# Invisible Character

Disallows invisible characters like zero-width space (U+200B), zero-width non-joiner (U+200C), and FEFF formatting character (U+FEFF) in string literals as they can cause hard-to-debug issues.

* **Identifier:** `invisible_character`
* **Enabled by default:** Yes
* **Supports autocorrection:** Yes
* **Kind:** lint
* **Analyzer rule:** No
* **Minimum Swift compiler version:** 5.0.0
* **Default configuration:**
  <table>
  <thead>
  <tr><th>Key</th><th>Value</th></tr>
  </thead>
  <tbody>
  <tr>
  <td>
  severity
  </td>
  <td>
  error
  </td>
  </tr>
  <tr>
  <td>
  additional_code_points
  </td>
  <td>
  []
  </td>
  </tr>
  </tbody>
  </table>

## Non Triggering Examples

```swift
let s = "HelloWorld"
```

```swift
let s = "Hello World"
```

```swift
let url = "https://example.com/api"
```

```swift
let s = #"Hello World"#
```

```swift
let multiline = """
Hello
World
"""
```

```swift
let empty = ""
```

```swift
let tab = "Hello\tWorld"
```

```swift
let newline = "Hello\nWorld"
```

```swift
let unicode = "Hello 👋 World"
```

## Triggering Examples

```swift
let s = "Hello↓​World" // U+200B zero-width space
```

```swift
let s = "Hello↓‌World" // U+200C zero-width non-joiner
```

```swift
let s = "Hello↓﻿World" // U+FEFF formatting character
```

```swift
let url = "https://example↓​.com" // U+200B in URL
```

```swift
// U+200B in multiline string
let multiline = """
Hello↓​World
"""
```

```swift
let s = "Test↓​String↓﻿Here" // Multiple invisible characters
```

```swift
let s = "Hel↓‌lo" + "World" // string concatenation with U+200C
```

```swift
let s = "Hel↓‌lo \(name)" // U+200C in interpolated string
```

```swift
//
// additional_code_points: ["AD"]
//

let s = "Hello↓­World"

```

```swift
//
// additional_code_points: ["200D"]
//

let s = "Hello↓‍World"

```