# Legacy UIGraphics Function

Prefer using `UIGraphicsImageRenderer` over legacy functions

* **Identifier:** `legacy_uigraphics_function`
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

## Rationale

The modern replacement is safer, cleaner, Retina-aware and more performant.

## Non Triggering Examples

```swift
let renderer = UIGraphicsImageRenderer(size: bounds.size)
let screenshot = renderer.image { _ in
    myUIView.drawHierarchy(in: bounds, afterScreenUpdates: true)
}
```

```swift
let renderer = UIGraphicsImageRenderer(size: newSize)
let combined = renderer.image { _ in
    background.draw(in: CGRect(origin: .zero, size: newSize))
    watermark.draw(in: CGRect(origin: .zero, size: watermarkSize))
}
```

```swift
UIGraphicsImageRenderer(size: newSize, format: UIGraphicsImageRendererFormat()).image { _ in
    image.draw(in: CGRect(origin: .zero, size: newSize))
}
```

## Triggering Examples

```swift
↓UIGraphicsBeginImageContext(newSize)
myUIView.drawHierarchy(in: bounds, afterScreenUpdates: false)
let optionalScreenshot = ↓UIGraphicsGetImageFromCurrentImageContext()
↓UIGraphicsEndImageContext()
```

```swift
↓UIGraphicsBeginImageContext(newSize)
background.draw(in: CGRect(origin: .zero, size: newSize))
watermark.draw(in: CGRect(origin: .zero, size: watermarkSize))
let optionalOutput = ↓UIGraphicsGetImageFromCurrentImageContext()
↓UIGraphicsEndImageContext()
```

```swift
↓UIGraphicsBeginImageContextWithOptions(newSize, true, 1.0)
image.draw(in: CGRect(origin: .zero, size: newSize))
let optionalOutput = ↓UIGraphicsGetImageFromCurrentImageContext()
↓UIGraphicsEndImageContext()
```