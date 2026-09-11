# Unneeded (Re)Throws Keyword

Non-throwing functions/properties/closures should not be marked as `throws` or `rethrows`.

* **Identifier:** `unneeded_throws_rethrows`
* **Enabled by default:** No
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
  warning
  </td>
  </tr>
  </tbody>
  </table>

## Non Triggering Examples

```swift
func foo() throws {
    try bar()
}
```

```swift
func foo() throws {
    throw Example.failure
}
```

```swift
func foo() throws(Example) {
    throw Example.failure
}
```

```swift
func foo(_ bar: () throws -> T) rethrows -> Int {
    try items.map { try bar() }
}
```

```swift
func foo() {
    func bar() throws {
        try baz()
    }
    try? bar()
}
```

```swift
protocol Foo {
    func bar() throws
}
```

```swift
func foo() throws {
    guard false else {
        throw Example.failure
    }
}
```

```swift
func foo() throws {
    do { try bar() }
    catch {
        throw Example.failure
    }
}
```

```swift
func foo() throws {
    do { try bar() }
    catch {
        try baz()
    }
}
```

```swift
func foo() throws {
    do {
        throw Example.failure
    } catch {
        do {
            throw Example.failure
        } catch {
            throw Example.failure
        }
    }
}
```

```swift
func foo() throws {
    switch bar {
    case 1: break
    default: try bar()
    }
}
```

```swift
var foo: Int {
    get throws {
        try bar
    }
}
```

```swift
func foo() throws {
    let bar = Bar()

    if bar.boolean {
        throw Example.failure
    }
}
```

```swift
func foo() throws -> Bar? {
    Bar(try baz())
}
```

```swift
typealias Foo = () throws -> Void
```

```swift
enum Foo {
    case foo
    case bar(() throws -> Void)
}
```

```swift
func foo() async throws {
    for try await item in items {}
}
```

```swift
let foo: () throws -> Void
```

```swift
let foo: @Sendable () throws -> Void
```

```swift
let foo: (() throws -> Void)?
```

```swift
func foo(_ bar: () throws -> Void = {}) {}
```

```swift
func foo() async throws {
    func foo() {}
    for _ in 0..<count {
        foo()
        try await bar()
    }
}
```

```swift
func foo() throws {
    do { try bar() }
    catch Example.failure {}
}
```

```swift
func foo() throws {
    do { try bar() }
    catch is SomeError { throw AnotherError }
    catch is AnotherError {}
}
```

```swift
let s: S<() throws -> Void> = S()
```

```swift
let foo: (() throws -> Void, Int) = ({}, 1)
```

```swift
let foo: (Int, () throws -> Void) = (1, {})
```

```swift
let foo: (Int, Int, () throws -> Void) = (1, 1, {})
```

```swift
let foo: () throws -> Void = { try bar() }
```

```swift
let foo: () throws -> Void = bar
```

```swift
var foo: () throws -> Void = {}
```

```swift
let x = { () throws -> Void in try baz() }
```

```swift
func c() throws {
    b(text: try a()) { print("") }
}
```

```swift
func c() throws {
    b(text: try a())
}
```

```swift
func c() throws {
    [try f()].map { $0 }
}
```

## Triggering Examples

```swift
func foo() ↓throws {}
```

```swift
let foo: () ↓throws -> Void = {}
```

```swift
let foo: (() ↓throws -> Void) = {}
```

```swift
let foo: (() ↓throws -> Void)? = {}
```

```swift
let foo: @Sendable () ↓throws -> Void = {}
```

```swift
func foo(bar: () throws -> Void) ↓rethrows {}
```

```swift
init() ↓throws {}
```

```swift
func foo() ↓throws {
    bar()
}
```

```swift
func foo() ↓throws(Example) {
    bar()
}
```

```swift
func foo() {
    func bar() ↓throws {}
    bar()
}
```

```swift
func foo() {
    func bar() ↓throws {
        baz()
    }
    bar()
}
```

```swift
func foo() {
    func bar() ↓throws {
        baz()
    }
    try? bar()
}
```

```swift
func foo() ↓throws {
    func bar() ↓throws {
        baz()
    }
}
```

```swift
func foo() ↓throws {
    do { try bar() }
    catch {}
}
```

```swift
func foo() ↓throws {
    do {}
    catch {}
}
```

```swift
func foo() ↓throws(Example) {
    do {}
    catch {}
}
```

```swift
func foo() {
    do {
        func bar() ↓throws {}
        try bar()
    } catch {}
}
```

```swift
func foo() ↓throws {
    do {
        try bar()
        func baz() throws { try bar() }
        try baz()
    } catch {}
}
```

```swift
func foo() ↓throws {
    do {
        try bar()
    } catch {
        do {
            throw Example.failure
        } catch {}
    }
}
```

```swift
func foo() ↓throws {
    do {
        try bar()
    } catch {
        do {
            try bar()
            func baz() ↓throws {}
            try baz()
        } catch {}
    }
}
```

```swift
func foo() ↓throws {
    switch bar {
    case 1: break
    default: break
    }
}
```

```swift
func foo() ↓throws {
    _ = try? bar()
}
```

```swift
func foo() ↓throws {
    Task {
        try bar()
    }
}
```

```swift
func foo() throws {
    try bar()
    Task {
        func baz() ↓throws {}
    }
}
```

```swift
var foo: Int {
    get ↓throws {
        0
    }
}
```

```swift
func foo() ↓throws {
    do { try bar() }
    catch Example.failure {}
    catch is SomeError {}
    catch {}
}
```

```swift
func foo() ↓throws {
    bar(1) {
        try baz()
    }
}
```

```swift
let x = { () ↓throws -> Void in baz() }
```

```swift
func c() {
    b { (n: String) ↓throws -> String in n }
    d: { try foo() }
}
```