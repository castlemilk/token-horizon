import AppKit

/// Menu-bar status icon: CPU + MEM activity rings, mirroring the notch
/// collapsed rings (red CPU, cyan memory). One concentric gauge — outer ring
/// is CPU, inner is MEM — in a 22x22 canvas so the item sits at standard
/// menu-bar size (the old 46pt side-by-side layout overflowed busy bars).
/// Track rings use a mid-gray that reads on both light and dark menu bars;
/// the colored arcs carry the meaning. Rendered with CoreGraphics into a 2x
/// bitmap — no hosting view, so status-button click behavior is untouched.
/// Redrawn on the 2s system tick; a 44x44 bitmap encode is microseconds.
enum StatusIcon {
    static func image(cpuPercent: Double, memPercent: Double) -> NSImage {
        let w: CGFloat = 22, h: CGFloat = 22, scale: CGFloat = 2
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
        ctx.setLineWidth(2.0)
        ctx.setLineCap(.round)
        let center = CGPoint(x: w / 2, y: h / 2)
        ring(ctx, center: center, radius: 8.6,
             fraction: cpuPercent / 100, color: NSColor.systemRed)
        ring(ctx, center: center, radius: 4.6,
             fraction: memPercent / 100, color: NSColor.systemCyan)
        return img
    }

    private static func ring(_ ctx: CGContext, center: CGPoint, radius: CGFloat, fraction: Double, color: NSColor) {
        NSColor.gray.withAlphaComponent(0.4).setStroke()
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
