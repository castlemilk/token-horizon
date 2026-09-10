import AppKit

/// Menu-bar status icon: CPU + MEM activity rings, mirroring the notch
/// collapsed rings (red CPU, cyan memory). Rendered with CoreGraphics into a
/// 2x bitmap — no hosting view, so status-button click behavior is untouched.
/// Redrawn on the 2s system tick; a 92x44 bitmap encode is microseconds.
enum StatusIcon {
    static func image(cpuPercent: Double, memPercent: Double) -> NSImage {
        let w: CGFloat = 46, h: CGFloat = 22, scale: CGFloat = 2
        let size = NSSize(width: w, height: h)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(w * scale), pixelsHigh: Int(h * scale),
            bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else {
            return NSImage(size: size)
        }
        rep.size = size
        let img = NSImage(size: size)
        img.addRepresentation(rep)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let ctx = NSGraphicsContext.current?.cgContext else { return img }
        ctx.scaleBy(x: scale, y: scale)
        ctx.setLineWidth(2.5)
        ctx.setLineCap(.round)
        ring(ctx, center: CGPoint(x: 11, y: 11), radius: 7.5,
             fraction: cpuPercent / 100, color: NSColor.systemRed)
        ring(ctx, center: CGPoint(x: 33, y: 11), radius: 7.5,
             fraction: memPercent / 100, color: NSColor.systemCyan)
        return img
    }

    private static func ring(_ ctx: CGContext, center: CGPoint, radius: CGFloat, fraction: Double, color: NSColor) {
        NSColor.white.withAlphaComponent(0.18).setStroke()
        ctx.addArc(center: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.strokePath()
        let clamped = max(0, min(1, fraction))
        guard clamped > 0.005 else { return }
        color.setStroke()
        let start = CGFloat.pi / 2
        ctx.addArc(center: center, radius: radius,
                   startAngle: start, endAngle: start - CGFloat(clamped) * .pi * 2,
                   clockwise: true)
        ctx.strokePath()
    }
}
