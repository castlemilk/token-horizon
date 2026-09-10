# Unneeded Escaping

The `@escaping` attribute should only be used when the closure actually escapes.

* **Identifier:** `unneeded_escaping`
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
func outer(completion: @escaping () -> Void) { inner(completion: completion) }
```

```swift
func f(completion: @escaping [Int] -> Void) {
    g {
        let result = [1].map { _ in 0 }
        completion(result)
    }
}
```

```swift
func outer(closure: @escaping @autoclosure () -> String) {
    inner(closure: closure())
}
```

```swift
func outer(closure: @escaping () -> String) {
    inner(tuple: (closure, 42))
}
```

```swift
func returning(_ work: @escaping () -> Void) -> () -> Void { return work }
```

```swift
func implicitlyReturning(g: @escaping () -> Void) -> () -> Void { g }
```

```swift
struct S {
    var closure: (() -> Void)?
    mutating func setClosure(_ newValue: @escaping () -> Void) {
        closure = newValue
    }
    mutating func setToSelf(_ newValue: @escaping () -> Void) {
        self.closure = newValue
    }
}
```

```swift
func closure(completion: @escaping () -> Void) {
    DispatchQueue.main.async { completion() }
}
```

```swift
func capture(completion: @escaping () -> Void) {
    let closure = { completion() }
    closure()
}
```

```swift
func assignToLocal(completion: @escaping () -> Void) {
    let (local, _) = (completion, 17)
    self.local = local
}
```

```swift
func assignToLocal(completion: @escaping () -> Void) {
    let local = (completion, 17)
    self.local = local
}
```

```swift
func assignToLocal(completion: @escaping () -> Void) {
    let local = (completion, 17)
    let (c, n) = local
    self.c = c
}
```

```swift
func reassignLocal(completion: @escaping () -> Void) -> () -> Void {
    var local = { print("initial") }
    local = completion
    return local
}
```

```swift
func global(completion: @escaping () -> Void) {
    Global.completion = completion
}
```

```swift
func chain(c: @escaping () -> Void) -> () -> Void {
    let c1 = c
    if condition {
        let c2 = c1
        return c2
    }
    let c3 = c1
    return c3
}
```

```swift
func f(c: @escaping () -> Void) {
    f(true ? c : { })
}
```

## Triggering Examples

```swift
func f(c: ↓@escaping () -> Int) {
    print(c())
}
```

```swift
func forEach(action: ↓@escaping (Int) -> Void) {
    for i in 0..<10 {
        action(i)
    }
}
```

```swift
func process(completion: ↓@escaping () -> Void) {
    completion()
}
```

```swift
func apply(_ transform: ↓@escaping (Int) -> Int) -> Int {
    return transform(5)
}
```

```swift
func optional(completion: (↓@escaping () -> Void)?) {
    completion?()
}
```

```swift
func multiple(first: ↓@escaping () -> Void, second: ↓@escaping () -> Void) {
    first()
    second()
}
```

```swift
subscript(transform: ↓@escaping (Int) -> String) -> String {
    transform(42)
}
```

```swift
func assignToLocal(completion: ↓@escaping () -> Void) {
    let local = completion
    local()
}
```

```swift
func assignToLocal(completion: ↓@escaping () -> Void) {
    let (local, _) = (completion, 17)
    local()
}
```

```swift
func reassignLocal(completion: ↓@escaping () -> Void) {
    var local = { print("initial") }
    local = completion
    local()
}
```

```swift
func assignToLocal(completion: ↓@escaping () -> Void) {
    _ = completion
}
```