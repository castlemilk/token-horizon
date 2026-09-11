# Optional Data -> String Conversion

Prefer failable `String(bytes:encoding:)` initializer when converting `Data` to `String`

* **Identifier:** `optional_data_string_conversion`
* **Enabled by default:** Yes
* **Supports autocorrection:** No
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
  warning
  </td>
  </tr>
  <tr>
  <td>
  include_implicit_init
  </td>
  <td>
  false
  </td>
  </tr>
  <tr>
  <td>
  allow_implicit_init
  </td>
  <td>
  false
  </td>
  </tr>
  </tbody>
  </table>

## Non Triggering Examples

```swift
String(data: data, encoding: .utf8)
```

```swift
String(bytes: data, encoding: .utf8)
```

```swift
String(UTF8.self)
```

```swift
String(a, b, c, UTF8.self)
```

```swift
String(decoding: data, encoding: UTF8.self)
```

```swift
String(data: data, encoding: .ascii)
```

```swift
String(bytes: data, encoding: .utf16LittleEndian)
```

```swift
String(decoding: data, as: UTF16.self)
```

```swift
String.init(bytes: data, encoding: .utf8)
```

```swift
let text: String = .init(bytes: data, encoding: .utf8)
```

```swift
let text: String = .init(data)
```

```swift
let text: Int = .init(decoding: data, as: UTF8.self)
```

```swift
let n: Int = .init(0)
```

```swift
String(repeating: "a", count: 3)
```

```swift
String(format: "%d", 3)
```

```swift
let text = .init(decoding: data, as: UTF8.self)
```

## Triggering Examples

```swift
↓String(decoding: data, as: UTF8.self)
```

```swift
↓String.init(decoding: data, as: UTF8.self)
```

```swift
let text: String = ↓.init(decoding: data, as: UTF8.self)
```

```swift
//
// include_implicit_init: true
//

let text = ↓.init(decoding: data, as: UTF8.self)

```

```swift
//
// include_implicit_init: true
//

f(↓.init(decoding: data, as: UTF8.self))

```