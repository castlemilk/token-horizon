# Multiline Call Arguments

Enforces one-argument-per-line for multi-line calls and requires a newline after commas when arguments are split across lines;
optionally limits or forbids multi-argument single-line calls via configuration.

* **Identifier:** `multiline_call_arguments`
* **Enabled by default:** No
* **Supports autocorrection:** No
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
  allows_single_line
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
// max_number_of_single_line_parameters: 1
//

foo(param1: 1,
    param2: false,
    param3: [])

```

```swift
func foo(one: [Int], animated: Bool) {}
add(one: [
    1,
    2,
    3
], animated: true)
```

```swift
//
// allows_single_line: false
//

foo(
    param1: 1,
    param2: 2,
    param3: 3
)

```

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(param1: 1, param2: false)

```

```swift
//
// max_number_of_single_line_parameters: 2
//

Enum.foo(param1: 1, param2: false)

```

```swift
//
// allows_single_line: false
//

foo()

```

```swift
//
// allows_single_line: false
//

foo(param1: 1)

```

```swift
//
// allows_single_line: false
//

Enum.foo(param1: 1)

```

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(1, 2)

```

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(1, b: 2)

```

```swift
//
// max_number_of_single_line_parameters: 3
//

foo(1, b: 2, c: 3)

```

```swift
//
// allows_single_line: true
//

enum EnumCase {
    case first(one: Int, two: Int, three: Int, four: Int)
}
EnumCase.first(one: 1, two: 2, three: 3, four: 4)

```

```swift
//
// allows_single_line: false
//

enum EnumCase {
    case first(one: Int, two: Int, three: Int, four: Int)
}
let test = EnumCase.first(
    one: 1,
    two: 2,
    three: 3,
    four: 4
)

```

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(a: 1, b: 2) { value in
    print(value)
}

```

```swift
//
// allows_single_line: false
//

foo(
    a: 1,
    b: 2
) { value in
    print(value)
}

```

```swift
//
// allows_single_line: false
//

foo(
    a: 1,
    b: 2
)
{ value in
    print(value)
}

```

```swift
//
// max_number_of_single_line_parameters: 1
//

foo { value in
    print(value)
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(a: 1, b: 2) { _ in
    print("main")
} trailing: { _ in
    print("extra")
}

```

```swift
foo(with: { _ in
    9_999
}, and: { _ in
    nil
})
```

```swift
foo(
    a: 1,
    // comment
    b: 2,
    c: 3
)
```

```swift
foo(
    a: (1, 2), b: 3
)
```

```swift
//
// allows_single_line: false
//

foo(
    a: (1, 2),
    b: 3
)

```

```swift
foo(
    a: 1, // comment
    b: 2,
    c: 3
)
```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case caseOne(Int, Int, Int, Int)
}
let enumCase: EnumCase = .caseOne(
    1,
    2,
    3,
    4
)
if case let .caseOne(_, _, three, _) = enumCase {
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case caseOne(one: Int, two: Int, three: Int, four: Int)
}
let enumCase: EnumCase = .caseOne(
    one: 1,
    two: 2,
    three: 3,
    four: 4
)
switch enumCase {
case let .caseOne(one: _, two: _, three: three, four: _):
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase { case caseOne(Int, Int, Int, Int) }
let array: [EnumCase] = [
    .caseOne(
        1,
        2,
        3,
        4
    )
]
for case let .caseOne(_, _, three, _) in array {
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case caseOne(Int, Int, Int, Int)
}
let enumCase: EnumCase = .caseOne(
    1,
    2,
    3,
    4
)
guard case let .caseOne(_, _, three, _) = enumCase else { return }

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case caseOne(Int, Int, Int, Int)
}
let enumCase: EnumCase = .caseOne(
    1,
    2,
    3,
    4
)
while case let .caseOne(_, _, three, _) = enumCase {
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase: Error {
    case caseOne(Int, Int, Int, Int)
}

func mayThrow() throws {
}

do {
    try mayThrow()
} catch let EnumCase.caseOne(_, _, three, _) {
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase: Error {
    case caseOne(one: Int, two: Int, three: Int, four: Int)
}

func mayThrow() throws {
}

do {
    try mayThrow()
} catch let EnumCase.caseOne(one: _, two: _, three: three, four: _) {
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

func foo(a: Int, b: Int, c: Int) -> Int { a + b + c }
enum EnumCase { case caseOne(Int, Int, Int, Int) }

if case let .caseOne(_, _, _, _) = EnumCase.caseOne(
    1,
    2,
    3,
    4
) {
    _ = foo(
        a: 1,
        b: 2,
        c: 3
    )
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case caseOne(Int, Int, Int, Int)
}

// Real call is written multi-line to avoid noise for max=2
let enumCase: EnumCase = .caseOne(
    0,
    0,
    0,
    0
)

// This is a PATTERN, not a call, and must be ignored even though it looks like `.caseOne(1,2,3,4)`
if case .caseOne(1, 2, 3, 4) = enumCase {
    // no-op
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case caseOne(one: Int, two: Int, three: Int, four: Int)
}

let enumCase: EnumCase = .caseOne(
    one: 0,
    two: 0,
    three: 0,
    four: 0
)

switch enumCase {
case .caseOne(one: 1, two: 2, three: 3, four: 4):
    break
default:
    break
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase: Error {
    case caseOne(Int, Int, Int, Int)
}

func mayThrow() throws {}

do {
    try mayThrow()
} catch EnumCase.caseOne(1, 2, 3, 4) {
    // pattern — must be ignored
}

```

## Triggering Examples

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(param1: 1, param2: false, ↓param3: [])

```

```swift
//
// max_number_of_single_line_parameters: 2
//

Enum.foo(param1: 1, param2: false, ↓param3: [])

```

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(1, 2, ↓3)

```

```swift
//
// max_number_of_single_line_parameters: 2
//

foo(1, b: 2, ↓3)

```

```swift
//
// allows_single_line: false
//

foo(param1: 1, ↓param2: false)

```

```swift
//
// allows_single_line: false
//

Enum.foo(param1: 1, ↓param2: false)

```

```swift
foo(
    a: 1, ↓b: 2,
    c: 3
)
```

```swift
foo(
    a: 1,
    b: 2, ↓c: 3
)
```

```swift
foo(
    a: 1,
    b: 2,
    c: 3, ↓d: 4,
    e: 5
)
```

```swift
//
// max_number_of_single_line_parameters: 1
//

foo(
    a: (
        1,
        2
    ), ↓b: 3
)

```

```swift
foo(
    a: 1, /* comment */ ↓b: 2,
    c: 3
)
```

```swift
//
// allows_single_line: false
//

enum EnumCase {
    case first(one: Int, two: Int, three: Int, four: Int)
}
EnumCase.first(one: 1, ↓two: 2, three: 3, four: 4)

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case first(one: Int, two: Int, three: Int, four: Int)
}
let test = EnumCase.first(one: 1, two: 2, ↓three: 3, four: 4)

```

```swift
//
// max_number_of_single_line_parameters: 1
//

foo(a: 1, ↓b: 2) { _ in
    print("x")
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase { case caseOne(Int, Int, Int, Int) }
let x: EnumCase = .caseOne(1, 2, ↓3, 4)
_ = x

```

```swift
//
// max_number_of_single_line_parameters: 2
//

enum EnumCase {
    case caseOne(one: Int, two: Int, three: Int, four: Int)
}
let x: EnumCase = .caseOne(one: 1, two: 2, ↓three: 3, four: 4)
_ = x

```

```swift
//
// max_number_of_single_line_parameters: 2
//

func foo(a: Int, b: Int, c: Int) -> Int { a + b + c }
enum EnumCase { case caseOne(Int, Int, Int, Int) }
let enumCase: EnumCase = .caseOne(
    1,
    2,
    3,
    4
)
if case let .caseOne(_, _, _, _) = enumCase {
    _ = foo(a: 1, b: 2, ↓c: 3)
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

func foo(a: Int, b: Int, c: Int) -> Bool { a + b == c }
enum EnumCase { case caseOne(Int, Int, Int, Int) }
let enumCase: EnumCase = .caseOne(
    1,
    2,
    3,
    4
)
switch enumCase {
case .caseOne where foo(a: 1, b: 2, ↓c: 3):
    break
default:
    break
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

func foo(a: Int, b: Int, c: Int) -> Int { a + b + c }
enum EnumCase { case caseOne(Int, Int, Int, Int) }
let array: [EnumCase] = [
    .caseOne(
        1,
        2,
        3,
        4
    )
]
for case let .caseOne(_, _, _, _) in array {
    _ = foo(a: 1, b: 2, ↓c: 3)
}

```

```swift
//
// max_number_of_single_line_parameters: 2
//

func foo(a: Int, b: Int, c: Int) -> Int { a + b + c }
enum EnumCase: Error { case caseOne(Int, Int, Int, Int) }

func mayThrow() throws {
}

do {
    try mayThrow()
} catch let EnumCase.caseOne(_, _, _, _) {
    _ = foo(a: 1, b: 2, ↓c: 3)
}

```