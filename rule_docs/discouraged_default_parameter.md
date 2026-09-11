# Discouraged Default Parameter

Default parameter values should not be used in functions with certain access levels.

* **Identifier:** `discouraged_default_parameter`
* **Enabled by default:** No
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
  disallowed_access_levels
  </td>
  <td>
  [internal, package]
  </td>
  </tr>
  </tbody>
  </table>

## Rationale

By discouraging default parameter values in functions that are exposed to other source files in the module
or package and their consumers, we can promote call sites and reduce the likelihood of bugs caused by
unexpected (or changed) default values being used.

## Non Triggering Examples

```swift
public func foo(bar: Int = 0) {}
```

```swift
open func foo(bar: Int = 0) {}
```

```swift
public extension Foo { func foo(bar: Int = 0) {} }
```

```swift
extension E { public func foo(bar: Int = 0) {} }
```

```swift
func outer() { func inner(bar: Int = 0) {} }
```

```swift
func foo(bar: Int) {}
```

```swift
private func foo(bar: Int = 0) {}
```

```swift
fileprivate func foo(bar: Int = 0) {}
```

```swift
public init(value: Int = 42) {}
```

```swift
//
// disallowed_access_levels: [private]
//

func foo(bar: Int = 0) {}

```

## Triggering Examples

```swift
func foo(bar: Int ↓= 0) {}
```

```swift
internal func foo(bar: Int ↓= 0) {}
```

```swift
package func foo(bar: Int ↓= 0) {}
```

```swift
func foo(bar: Int ↓= 0, baz: String ↓= "") {}
```

```swift
init(value: Int ↓= 42) {}
```

```swift
class C { public func foo(bar: Int ↓= 0) {} }
```

```swift
struct S { public init(value: Int ↓= 42) {} }
```

```swift
//
// disallowed_access_levels: [private]
//

private func foo(bar: Int ↓= 0) {}

```

```swift
//
// disallowed_access_levels: [fileprivate]
//

fileprivate func foo(bar: Int ↓= 0) {}

```