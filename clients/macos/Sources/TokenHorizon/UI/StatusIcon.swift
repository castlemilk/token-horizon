import AppKit

/// Menu-bar status icon: CPU + MEM activity rings, mirroring the notch
/// collapsed rings (red CPU, cyan memory). One concentric gauge — outer ring
/// is CPU, inner is MEM.
///
/// HIG: menu-bar extras are small glyphs centered in the square status-item
/// slot, not edge-to-edge art. 18x18pt is the conventional glyph size in the
/// ~24pt bar (a 22pt image left ~1pt margins and read as clipped/bleeding).
/// The image is drawn via `NSImage(size:flipped:drawingHandler:)` so AppKit
/// re-renders it at the destination display's backing scale — a baked 2x
/// bitmap downsampled to 1x (clamshell external panels) blurred the strokes.
/// Track rings use a mid-gray that reads on both light and dark menu bars;
/// the colored arcs carry the meaning. Redrawn on the 2s system tick.
enum StatusIcon {
    static let glyphSize: CGFloat = 18

    static func image(cpuPercent: Double, memPercent: Double) -> NSImage {
        let size = NSSize(width: glyphSize, height: glyphSize)
        return NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.setLineWidth(1.8)
            ctx.setLineCap(.round)
            let center = CGPoint(x: rect.midX, y: rect.midY)
            ring(ctx, center: center, radius: 7.1,
                 fraction: cpuPercent / 100, color: NSColor.systemRed)
            ring(ctx, center: center, radius: 3.6,
                 fraction: memPercent / 100, color: NSColor.systemCyan)
            return true
        }
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
