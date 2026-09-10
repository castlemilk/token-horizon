# Vertical Whitespace Between Cases

Include a single empty line between switch cases

* **Identifier:** `vertical_whitespace_between_cases`
* **Enabled by default:** No
* **Supports autocorrection:** Yes
* **Kind:** style
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
  separation
  </td>
  <td>
  always
  </td>
  </tr>
  </tbody>
  </table>

## Non Triggering Examples

```swift
    switch x {
    case .a:
        print("a")

    // Comment 1
    // Comment 2
    case .b:
        print("b")
    }
```

```swift
    switch x {
    case .a:
        print("a")
        // Comment

    case .b:
        print("b")
    }
```

```swift
switch (i) {
case 1: 1

#if canImport(FoundationNetworking)
default: 2
#else
case 2:
    2

case 3:
    3
#endif
}
```

```swift
switch x {
case .a:
    // Comment inside
    print("a")

case .b:
    print("b")
}
```

```swift
switch x {
case .a:
    print("a")

#if DEBUG
case .b:
    print("b")
#endif

case .c:
    print("c")
}
```

```swift
switch x {
case .a:
    print("a")

/* Comment */
case .b:
    print("b")
}
```

```swift
switch x {
case .a:
    print("a")

/// Documentation
case .b:
    print("b")
}
```

```swift
switch x {
case .a:
    print("a")

case .b:
    print("b")

#if DEBUG
case .c:
    print("c")
#endif

case .d:
    print("d")

case .e:
    print("e")
}
```

```swift
//
// separation: never
//

switch x {
case .a:
    print("a")
// Comment
case .b:
    print("b")
    // Another Comment
case .c:
    print("c")
/*
 * Comment block
 */
case .d:
    print("d")
}

```

```swift
//
// separation: never
//

switch x {
case .first:
    print("first")
case .second:
    print("second")
}

```

```swift
switch x {
case .valid:
    print("multiple ...")
    print("... lines")

case .invalid:
    print("multiple ...")
    print("... lines")
}
```

```swift
switch x {
case .valid:
    print("x is valid")

case .invalid:
    print("x is invalid")
}
```

```swift
switch x {
case 0..<5:
    print("x is valid")

default:
    print("x is invalid")
}
```

```swift
switch x {
case 0..<5:
    return "x is valid"

default:
    return "x is invalid"

@unknown default:
    print("x is out of this world")
}
```

```swift
switch x {

case 0..<5:
    print("x is low")

case 5..<10:
    print("x is high")

default:
    print("x is invalid")

@unknown default:
    print("x is out of this world")
}
```

```swift
switch x {
case 0..<5:
    print("x is low")

case 5..<10:
    print("x is high")

default:
    print("x is invalid")
}
```

```swift
switch x {
case 0..<5: print("x is low")
case 5..<10: print("x is high")
default: print("x is invalid")
@unknown default: print("x is out of this world")
}
```

```swift
switch x {    
case 1:    
    print("one")    
    
default:    
    print("not one")    
}    
```

```swift
switch x {
case .a: print("a")

#if DEBUG
case .b: print("b")
#endif

case .c: print("c")
}
```

```swift
switch x {
case .a:
    print("a")

#if DEBUG
case .b:
    print("b")
#endif

case .c:
    print("c")
}
```

```swift
switch x {
case .a:
    print("a")

// Comment about case b
case .b:
    print("b")
}
```

```swift
switch x {
case .a:
    print("a")

/* Block comment */
case .b:
    print("b")
}
```

```swift
switch x {
case .a:
    // Comment inside case a
    print("a")

case .b:
    print("b")
}
```

```swift
//
// separation: never
//

switch x {
case .a:
    print("a")
case .b:
    print("b")
case .c:
    print("c")
}

```

```swift
//
// separation: never
//

switch x {
case .a:
    print("a")
// Comment
case .b:
    print("b")
}

```

```swift
switch x {
case .a:
    print("a")

/// Documentation
case .b:
    print("b")
}
```

```swift
switch x {
case .gamma:
    print("gamma")


case .delta:
    print("delta")
}
```

## Triggering Examples

```swift
    switch x {
    case .a:
        print("a")
        // Comment
    ↓case .b:
        print("b")
    }
```

```swift
    switch x {
    case .a:
        print("a")
    // Comment 1
    // Comment 2
    ↓case .b:
        print("b")
    }
```

```swift
switch (i) {
case 1: 1
↓#if canImport(FoundationNetworking)
default: 2
#else
case 2:
    2
↓case 3:
    3
#endif
}
```

```swift
switch x {
case .a:
    // Comment inside
    print("a")
↓case .b:
    print("b")
}
```

```swift
//
// separation: never
//

switch x {
case .a:
    print("a")


// Comment
↓case .b:
    print("b")
    // Another Comment


↓case .c:
    print("c")

/*
 * Comment block
 */

↓↓case .d:
    print("d")
}

```

```swift
switch x {
case .a:
    print("a")

#if DEBUG
case .b:
    print("b")
#endif
↓case .c:
    print("c")
}
```

```swift
switch x {
case .a:
    print("a")
/* Comment */
↓case .b:
    print("b")
}
```

```swift
switch x {
case .a:
    print("a")
/// Documentation
↓case .b:
    print("b")
}
```

```swift
switch x {
case .a:
    print("a")
↓case .b:
    print("b")

#if DEBUG
case .c:
    print("c")
#endif

case .d:
    print("d")
↓case .e:
    print("e")
}
```

```swift
//
// separation: never
//

switch x {
case .first:
    print("first")

↓case .second:
    print("second")
}

```

```swift
switch x {
case .valid:
    print("multiple ...")
    print("... lines")
↓case .invalid:
    print("multiple ...")
    print("... lines")
}
```

```swift
switch x {
case .valid:
    print("x is valid")
↓case .invalid:
    print("x is invalid")
}
```

```swift
switch x {
case 0..<5:
    print("x is valid")
↓default:
    print("x is invalid")
}
```

```swift
switch x {
case 0..<5:
    return "x is valid"
↓default:
    return "x is invalid"
↓@unknown default:
    print("x is out of this world")
}
```