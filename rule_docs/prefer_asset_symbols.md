# Prefer Asset Symbols

Prefer using asset symbols over string-based image initialization

* **Identifier:** `prefer_asset_symbols`
* **Enabled by default:** No
* **Supports autocorrection:** No
* **Kind:** idiomatic
* **Analyzer rule:** No
* **Minimum Swift compiler version:** 5.9.0
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

`UIKit.UIImage(named:)` and `SwiftUI.Image(_:)` bear the risk of bugs due to typos in their string arguments. Since Xcode 15, Xcode generates codes for images in the Asset Catalog. Usage of these codes and system icons from SF Symbols avoid typos and allow for compile-time checking.

## Non Triggering Examples

```swift
UIImage(resource: .someImage)
```

```swift
UIImage(systemName: "trash")
```

```swift
Image(.someImage)
```

```swift
Image(systemName: "trash")
```

```swift
UIImage(named: imageName)
```

```swift
UIImage(named: "image_\(suffix)")
```

```swift
Image(imageName)
```

```swift
Image("image_\(suffix)")
```

## Triggering Examples

```swift
↓UIImage(named: "some_image")
```

```swift
↓UIImage(named: "some image")
```

```swift
↓UIImage.init(named: "someImage")
```

```swift
↓UIImage(named: "someImage", in: Bundle.main, compatibleWith: nil)
```

```swift
↓UIImage(named: "someImage", in: .main)
```

```swift
↓Image("some_image")
```

```swift
↓Image("some image")
```

```swift
↓Image.init("someImage")
```

```swift
↓Image("someImage", bundle: Bundle.main)
```

```swift
↓Image("someImage", bundle: .main)
```