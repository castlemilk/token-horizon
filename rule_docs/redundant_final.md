# Redundant Final

`final` is redundant

* **Identifier:** `redundant_final`
* **Enabled by default:** No
* **Supports autocorrection:** Yes
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

## Rationale

Actors in Swift currently do not support inheritance, making `final` redundant on both actor declarations
and their members. Note that this may change in future Swift versions if actor inheritance is introduced.

Additionally, `final` is redundant on members of a `final class` since they cannot be overridden.

## Non Triggering Examples

```swift
actor MyActor {}
```

```swift
final class MyClass {}
```

```swift
@globalActor
actor MyGlobalActor {}
```

```swift
actor MyActor {
    func doWork() {}
    final class C1 {}
    class C2 {
        final func doWork() {}
    }
}
```

```swift
class MyClass {
    final func doWork() {}
}
```

## Triggering Examples

```swift
↓final actor MyActor {}
```

```swift
public ↓final actor DataStore {}
```

```swift
@globalActor
↓final actor MyGlobalActor {}
```

```swift
actor MyActor {
    ↓final func doWork() {}
}
```

```swift
actor MyActor {
    ↓final var value: Int { 0 }
}
```

```swift
final class C1 {
    ↓final actor A1 {
        ↓final func doWork() {}
    }
    ↓final func doWork() {}
    final class C2 {
        ↓final func doWork() {}
    }
}
```