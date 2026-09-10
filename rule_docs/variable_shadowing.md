# Variable Shadowing

Do not shadow variables declared in outer scopes

* **Identifier:** `variable_shadowing`
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
  ignore_parameters
  </td>
  <td>
  true
  </td>
  </tr>
  </tbody>
  </table>

## Non Triggering Examples

```swift
//
// ignore_parameters: true
//

var a: String?
func test(a: String?) {
    print(a)
}

```

```swift
var a: String = "hello"
if let b = a {
    print(b)
}
```

```swift
var a: String?
func test() {
    if let b = a {
        print(b)
    }
}
```

```swift
for i in 1...10 {
    print(i)
}
for i in 1...10 {
    print(i)
}
```

```swift
func test() {
    var a: String = "hello"
    func nested() {
        var b: String = "world"
        print(a, b)
    }
}
```

```swift
class Test {
    var a: String?
    func test(a: String?) {
        print(a)
    }
}
```

```swift
let a: Int?
if let a { print(a) }
```

```swift
let a: Int?
guard let a else { return }
```

```swift
let a: Int?
while let a { print(a) }
```

```swift
var a = 1
if let a = a {
    print(a)
}
```

```swift
var a = 1
if let a = self.a {
    print(a)
}
```

```swift
struct S {
    static let c: Int? = nil
    var a: Int?
    var b: Int {
        if let a = self.a { a }
        else if let c = Self.c { c }
        else { 0 }
    }
}
```

## Triggering Examples

```swift
var foo = 1
do {
    let ↓foo = 2
}
```

```swift
var a = 1
if let ↓a = Optional(2) {
    let ↓a = 3
    print(a)
}
```

```swift
var i = 1
for ↓i in 1...3 {
    let ↓i = 2
    print(i)
}
```

```swift
var a = 1
func test() {
    do {
        var ↓a = 2
        print(a)
    }
}
```

```swift
func test() {
    var a = 1
    if var ↓a = Optional(2) {
        var ↓a = 2
        print(a)
    }
}
```

```swift
func test() {
    var a = 1
    for ↓a in 0..<1 {
        var ↓a = 2
        print(a)
    }
}
```

```swift
func test() {
    var a = 1
    while true {
        var ↓a = 2
        break
    }
}
```

```swift
//
// ignore_parameters: false
//

var a: String?
func test(↓a: String?) {
    let ↓a = ""
    print(a)
}

```

```swift
struct S {
    var a = 1
    var b: Int {
        let ↓a = 2
        return a
    }
}
```

```swift
var a: String?
while let ↓a = Optional("hello") {}
```

```swift
var a = "outer"
let (↓a, c) = ("first", "second")
```