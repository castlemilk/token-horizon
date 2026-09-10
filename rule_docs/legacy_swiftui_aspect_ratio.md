# Legacy SwiftUI Aspect Ratio

Prefer `scaledToFit()` or `scaledToFill()` over `aspectRatio(contentMode:)` with a constant content mode

* **Identifier:** `legacy_swiftui_aspect_ratio`
* **Enabled by default:** Yes
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

## Non Triggering Examples

```swift
view.aspectRatio(ratio, contentMode: .fit)
```

```swift
view.aspectRatio(ratio, contentMode: .fill)
```

```swift
view.aspectRatio(contentMode: contentMode)
```

```swift
view.aspectRatio(contentMode: shouldFit ? .fit : .fill)
```

```swift
view.aspectRatio(contentMode: CustomMode.fit)
```

```swift
view.scaledToFit()
```

```swift
view.scaledToFill()
```

## Triggering Examples

```swift
view.↓aspectRatio(contentMode: .fit)
```

```swift
view.↓aspectRatio(contentMode: .fill)
```

```swift
view.↓aspectRatio(contentMode: ContentMode.fit)
```

```swift
view.↓aspectRatio(contentMode: ContentMode.fill)
```

```swift
↓aspectRatio(contentMode: .fit)
```

```swift
↓aspectRatio(contentMode: .fill)
```