# Pattern Matching Keywords

Combine multiple pattern matching bindings by moving binding keywords out of tuples and associated values
in enum cases to reduce visual noise.

* **Identifier:** `pattern_matching_keywords`
* **Enabled by default:** No
* **Supports autocorrection:** No
* **Kind:** idiomatic
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
switch foo {
    default: break
}
```

```swift
switch foo {
    case 1: break
}
```

```swift
switch foo {
    case bar: break
}
```

```swift
switch foo {
    case let (x, y): break
}
```

```swift
switch foo {
    case .foo(let x): break
}
```

```swift
switch foo {
    case let .foo(x, y): break
}
```

```swift
switch foo {
    case .foo(let x), .bar(let x): break
}
```

```swift
switch foo {
    case .foo(let x, var y): break
}
```

```swift
switch foo {
    case var (x, y): break
}
```

```swift
switch foo {
    case .foo(var x): break
}
```

```swift
switch foo {
    case var .foo(x, y): break
}
```

```swift
switch foo {
    case (y, let x, z): break
}
```

```swift
switch foo {
    case (foo, let x): break
}
```

```swift
switch foo {
    case (foo, let x, let y): break
}
```

```swift
switch foo {
    case .foo(bar, let x): break
}
```

```swift
switch foo {
    case (let x, y): break
}
```

```swift
switch foo {
    case .foo(let x, y): break
}
```

```swift
switch foo {
    case (.foo(let x), y): break
}
```

```swift
switch foo {
    case let .foo(x, y), let .bar(x, y): break
}
```

```swift
switch foo {
    case var .foo(x, y), var .bar(x, y): break
}
```

```swift
switch foo {
    case let .foo(x, y), let .bar(x, y), let .baz(x, y): break
}
```

```swift
switch foo {
    case .foo(bar: let x, baz: var y): break
}
```

```swift
switch foo {
    case (.yamlParsing(var x), (.yamlParsing(var y), z)): break
}
```

```swift
switch foo {
    case (.foo(let x), (y, let z)): break
}
```

```swift
if case let (x, y) = foo {}
```

```swift
guard case let (x, y) = foo else { return }
```

```swift
while case let (x, y) = foo {}
```

```swift
for case let (x, y) in foos {}
```

```swift
if case (foo, let x) = value {}
```

```swift
guard case .foo(bar, let x) = value else { return }
```

```swift
do {} catch let Pattern.error(x, y) {}
```

```swift
do {} catch (foo, let x) {}
```

## Triggering Examples

```swift
switch foo {
    case (↓let x, ↓let y): break
}
```

```swift
switch foo {
    case (↓let x, ↓let y, .foo): break
}
```

```swift
switch foo {
    case (↓let x, ↓let y, _): break
}
```

```swift
switch foo {
    case (↓let x, ↓let y, 1): break
}
```

```swift
switch foo {
    case (↓let x, ↓let y, f()): break
}
```

```swift
switch foo {
    case (↓let x, ↓let y, s.f()): break
}
```

```swift
switch foo {
    case (↓let x, ↓let y, s.t): break
}
```

```swift
switch foo {
    case .foo(↓let x, ↓let y): break
}
```

```swift
switch foo {
    case .foo(bar: ↓let x, baz: ↓let y): break
}
```

```swift
switch foo {
    case .foo(↓var x, ↓var y): break
}
```

```swift
switch foo {
    case .foo(bar: ↓var x, baz: ↓var y): break
}
```

```swift
switch foo {
    case (.yamlParsing(↓let x), .yamlParsing(↓let y)): break
}
```

```swift
switch foo {
    case (.yamlParsing(↓var x), (.yamlParsing(↓var y), _)): break
}
```

```swift
switch foo {
    case ((↓let x, ↓let y), z): break
}
```

```swift
switch foo {
    case .foo((↓let x, ↓let y), z): break
}
```

```swift
switch foo {
    case (.foo(↓let x, ↓let y), z): break
}
```

```swift
switch foo {
    case .foo(.bar(↓let x), .bar(↓let y)): break
}
```

```swift
switch foo {
    case .foo(.bar(↓let x), .bar(↓let y), .baz): break
}
```

```swift
switch foo {
    case .foo(↓let x, ↓let y), .bar(↓let x, ↓let y): break
}
```

```swift
switch foo {
    case .foo(↓var x, ↓var y), .bar(↓var x, ↓var y): break
}
```

```swift
if case (↓let x, ↓let y) = foo {}
```

```swift
guard case (↓let x, ↓let y) = foo else { return }
```

```swift
while case (↓let x, ↓let y) = foo {}
```

```swift
for case (↓let x, ↓let y) in foos {}
```

```swift
if case .foo(bar: ↓let x, baz: ↓let y) = value {}
```

```swift
do {} catch Pattern.error(↓let x, ↓let y) {}
```

```swift
do {} catch (↓let x, ↓let y) {}
```

```swift
do {} catch Foo.outer(.inner(↓let x), .inner(↓let y)) {}
```