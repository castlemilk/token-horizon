# Incompatible Concurrency Annotation

Declaration should be @preconcurrency to maintain compatibility with Swift 5

* **Identifier:** `incompatible_concurrency_annotation`
* **Enabled by default:** No
* **Supports autocorrection:** Yes
* **Kind:** lint
* **Analyzer rule:** No
* **Minimum Swift compiler version:** 6.0.0
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
  global_actors
  </td>
  <td>
  [&quot;MainActor&quot;]
  </td>
  </tr>
  </tbody>
  </table>

## Rationale

Declarations that use concurrency features such as `@Sendable` closures, `Sendable` generic type
arguments or `@MainActor` (or other global actors) should be annotated with `@preconcurrency`
to ensure compatibility with Swift 5.

This rule detects public declarations that require `@preconcurrency` and can automatically add
the annotation.

## Non Triggering Examples

```swift
public struct S: Sendable {}
```

```swift
public class C: Sendable {}
```

```swift
public actor A {}
```

```swift
private @MainActor struct S { }
```

```swift
@MainActor struct S { }
```

```swift
internal @MainActor func globalActor()
```

```swift
private @MainActor init() {}
```

```swift
internal subscript(index: Int) -> String where String: Sendable { get }
```

```swift
@preconcurrency @MainActor public struct S {}
```

```swift
@preconcurrency @MainActor public class C {}
```

```swift
@preconcurrency @MainActor public enum E { case a }
```

```swift
@preconcurrency @MainActor public protocol P {}
```

```swift
@preconcurrency @MainActor public func globalActor()
```

```swift
@preconcurrency public func sendableClosure(_ block: @Sendable () -> Void)
```

```swift
@preconcurrency public func globalActorClosure(_ block: @MainActor () -> Void)
```

```swift
@preconcurrency public init(_ block: @Sendable () -> Void)
```

```swift
@preconcurrency public subscript(index: Int) -> String where String: Sendable { get }
```

```swift
@preconcurrency public func sendableReturningClosure() -> @Sendable () -> Void
```

```swift
@preconcurrency public func globalActorReturningClosure() -> @MainActor () -> Void
```

```swift
@preconcurrency public func sendingParameter(_ value: sending MyClass)
```

```swift
@preconcurrency public func tupleParameterClosures(
    _ handlers: (@Sendable () -> Void, @MainActor () -> Void)
)
```

```swift
@preconcurrency public func tupleReturningClosures() -> (
    @Sendable () -> Void,
    @MainActor () -> Void
)
```

```swift
@preconcurrency public func closureWithSendingArgument(
    _ handler: (_ value: sending MyClass) -> Void
)
```

```swift
public func nonSendableClosure(_ block: () -> Void)
```

```swift
public func generic<T>() where T: Equatable
```

```swift
public func generic<T: Hashable>()
```

```swift
public init<T: Hashable>()
```

```swift
public @MyActor enum E { case a }
```

```swift
public func customActor(_ block: @MyActor () -> Void)
```

## Triggering Examples

```swift
@MainActor public ↓struct S {}
```

```swift
@MainActor public ↓class C {}
```

```swift
@MainActor public ↓enum E { case a }
```

```swift
@MainActor public ↓protocol GlobalActor {}
```

```swift
@MainActor public ↓func globalActor()
```

```swift
class C {
    @MainActor public ↓init() {}
}
```

```swift
@MainActor public ↓init<T>()
```

```swift
struct S {
    @MainActor public ↓subscript(index: Int) -> String { get }
}
```

```swift
public ↓subscript<T>(index: T) -> Int where T: ExpressibleByIntegerLiteral & Sendable { get }
```

```swift
public ↓func sendableClosure(_ block: @Sendable () -> Void)
```

```swift
public ↓func globalActorClosure(_ block: @MainActor () -> Void)
```

```swift
public struct S { public ↓func sendableClosure(_ block: @Sendable () -> Void) }
```

```swift
public ↓init(_ block: @Sendable () -> Void)
```

```swift
public ↓init(param: @MainActor () -> Void)
```

```swift
public ↓func tupleParameter(
    _ handlers: (@Sendable () -> Void, @MainActor () -> Void)
)
```

```swift
public ↓func tupleWithSending(
    _ handlers: ((_ value: sending MyClass) -> Void, @MainActor () -> Void)
)
```

```swift
public ↓func generic<T>() where T: Sendable {}
```

```swift
public ↓struct S<T> where T: Sendable {}
```

```swift
public ↓class C<T> where T: Sendable {}
```

```swift
public ↓enum E<T> where T: Sendable { case a }
```

```swift
public ↓init<T>() where T: Sendable {}
```

```swift
public ↓func returnsSendableClosure() -> @Sendable () -> Void
```

```swift
public ↓func returnsActorClosure() -> @MainActor () -> Void
```

```swift
public ↓func returnsClosureTuple() -> (@Sendable () -> Void, @MainActor () -> Void)
```

```swift
//
// global_actors: ["MainActor", "MyActor"]
//

@MyActor public ↓struct S {}

```

```swift
//
// global_actors: ["MainActor", "MyActor"]
//

public ↓func globalActorClosure(_ block: @MyActor () -> Void)

```

```swift
//
// global_actors: ["MainActor", "MyActor"]
//

@MyActor public ↓func customGlobalActor()

```

```swift
//
// global_actors: ["MainActor", "MyActor"]
//

@MyActor public ↓init()

```