# Unused Import

All imported modules should be required to make the file compile

* **Identifier:** `unused_import`
* **Enabled by default:** No
* **Supports autocorrection:** Yes
* **Kind:** lint
* **Analyzer rule:** Yes
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
  require_explicit_imports
  </td>
  <td>
  false
  </td>
  </tr>
  <tr>
  <td>
  allowed_transitive_imports
  </td>
  <td>
  []
  </td>
  </tr>
  <tr>
  <td>
  always_keep_imports
  </td>
  <td>
  []
  </td>
  </tr>
  </tbody>
  </table>

## Non Triggering Examples

```swift
import Dispatch // This is used
dispatchMain()
```

```swift
@testable import Dispatch
dispatchMain()
```

```swift
import Foundation
@objc
class A {}
```

```swift
import UnknownModule
func foo(error: Swift.Error) {}
```

```swift
@_exported import UnknownModule
```

```swift
import Foundation
let 👨‍👩‍👧‍👦 = #selector(NSArray.contains(_:))
👨‍👩‍👧‍👦 == 👨‍👩‍👧‍👦
```

```swift
//
// allowed_transitive_imports: [Foundation: ["CoreFoundation"]]
//

import Foundation
enum E {
    static let min: CGFloat = 44
}

```

## Triggering Examples

```swift
↓import Dispatch
struct A {
  static func dispatchMain() {}
}
A.dispatchMain()
```

```swift
↓import Foundation // This is unused
struct A {
  static func dispatchMain() {}
}
A.dispatchMain()
↓import Dispatch

```

```swift
↓import Foundation
dispatchMain()
```

```swift
↓import Foundation
// @objc
class A {}
```

```swift
↓public import Foundation
import UnknownModule
func foo(error: Swift.Error) {}
```

```swift
↓internal import Swift
↓private import SwiftShims
func foo(error: Swift.Error) {}
```