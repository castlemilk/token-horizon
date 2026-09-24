import AppKit
import CoreGraphics
import Foundation
// swiftlint:disable force_try
// Render script: a failed allocation here SHOULD crash loudly (there is no
// recovery path), so try! is intentional. App target code keeps enforcement.

let size = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                    bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

let s = CGFloat(size)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

ctx.setFillColor(rgb(0x000000))
ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))

let bgColors = [rgb(0x101018), rgb(0x07070c), rgb(0x020204)] as CFArray
let bgGrad = CGGradient(colorsSpace: cs, colors: bgColors, locations: [0, 0.55, 1])!
ctx.drawRadialGradient(bgGrad,
                       startCenter: CGPoint(x: s * 0.5, y: s * 0.62), startRadius: 0,
                       endCenter: CGPoint(x: s * 0.5, y: s * 0.62), endRadius: s * 0.75,
                       options: [])

var seed: UInt64 = 0x4d2f_9e3b_77c1_a6f5
func rnd() -> CGFloat {
    seed = seed &* 6364136223846793005 &+ 1442695040888963407
    return CGFloat((seed >> 33) & 0xffffff) / CGFloat(0xffffff)
}

for _ in 0..<140 {
    let x = rnd() * s
    let y = rnd() * s
    let r = rnd() * 2.4 + 0.4
    let a = pow(rnd(), 2.2) * 0.85 + 0.05
    ctx.setFillColor(rgb(0xffffff, a))
    ctx.fillEllipse(in: CGRect(x: x, y: y, width: r * 2, height: r * 2))
}

struct Disk {
    static func point(_ t: CGFloat) -> CGPoint {
        let rot = CGFloat(-20) * .pi / 180
        let rx = CGFloat(392), ry = CGFloat(112)
        let cx = CGFloat(512), cy = CGFloat(500)
        let ex = rx * cos(t), ey = ry * sin(t)
        return CGPoint(x: cx + ex * cos(rot) - ey * sin(rot),
                       y: cy + ex * sin(rot) + ey * cos(rot))
    }

    static func path(from: CGFloat, to: CGFloat, steps: Int = 160) -> CGPath {
        let p = CGMutablePath()
        var first = true
        for i in 0...steps {
            let t = from + (to - from) * CGFloat(i) / CGFloat(steps)
            let pt = point(t)
            if first { p.move(to: pt); first = false } else { p.addLine(to: pt) }
        }
        return p
    }
}

func strokeGlow(_ path: CGPath, baseWidth: CGFloat, hue: UInt32, intensity: CGFloat) {
    let layers: [(CGFloat, CGFloat)] = [
        (baseWidth * 7.0, 0.05),
        (baseWidth * 4.2, 0.10),
        (baseWidth * 2.4, 0.22),
        (baseWidth * 1.25, 0.55),
        (baseWidth * 0.55, 1.00),
    ]
    for (w, a) in layers {
        ctx.setStrokeColor(rgb(hue, min(a * intensity, 1)))
        ctx.setLineWidth(w)
        ctx.setLineCap(.round)
        ctx.addPath(path)
        ctx.strokePath()
    }
}

strokeGlow(Disk.path(from: .pi * 0.98, to: .pi * 2.02), baseWidth: 26, hue: 0xff8a2a, intensity: 1.0)
strokeGlow(Disk.path(from: .pi * 1.06, to: .pi * 1.94), baseWidth: 8, hue: 0xffd9a0, intensity: 0.9)

let horizonR = CGFloat(158)
let horizonRect = CGRect(x: 512 - horizonR, y: 500 - horizonR, width: horizonR * 2, height: horizonR * 2)
ctx.setShadow(offset: .zero, blur: 60, color: rgb(0x000000, 0.95))
ctx.setFillColor(rgb(0x000000))
ctx.fillEllipse(in: horizonRect)
ctx.setShadow(offset: .zero, blur: 0, color: nil)

strokeGlow(Disk.path(from: -.pi * 0.02, to: .pi * 1.02), baseWidth: 26, hue: 0xffa53a, intensity: 1.0)
strokeGlow(Disk.path(from: .pi * 0.08, to: .pi * 0.92), baseWidth: 9, hue: 0xfff1cc, intensity: 1.0)

let photonLayers: [(CGFloat, CGFloat, UInt32)] = [
    (10, 0.10, 0xffb45e),
    (5.5, 0.30, 0xffcf8a),
    (2.6, 0.95, 0xfff6e0),
]
let photon = CGPath(ellipseIn: horizonRect.insetBy(dx: 14, dy: 14), transform: nil)
for (w, a, c) in photonLayers {
    ctx.setStrokeColor(rgb(c, a))
    ctx.setLineWidth(w)
    ctx.addPath(photon)
    ctx.strokePath()
}

ctx.setStrokeColor(rgb(0xdfe9ff, 0.16))
ctx.setLineWidth(3)
ctx.addArc(center: CGPoint(x: 512, y: 500), radius: horizonR + 34,
           startAngle: .pi * 0.15, endAngle: .pi * 0.85, clockwise: false)
ctx.strokePath()

ctx.setFillColor(rgb(0x000000, 1))
ctx.fillEllipse(in: CGRect(x: 512 - horizonR + 6, y: 500 - horizonR + 6,
                           width: horizonR * 2 - 12, height: horizonR * 2 - 12))

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
rep.size = NSSize(width: size, height: size)
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: "clients/macos/Resources/icon_1024.png"))

func writeSize(_ px: Int, _ name: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                               isPlanar: false, colorSpaceName: .calibratedRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let gctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = gctx
    gctx.cgContext.interpolationQuality = .high
    gctx.cgContext.draw(img, in: CGRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "clients/macos/Resources/\(name)"))
}

writeSize(16, "icon_16x16.png")
writeSize(32, "icon_16x16@2x.png")
writeSize(32, "icon_32x32.png")
writeSize(64, "icon_32x32@2x.png")
writeSize(128, "icon_128x128.png")
writeSize(256, "icon_128x128@2x.png")
writeSize(256, "icon_256x256.png")
writeSize(512, "icon_256x256@2x.png")
writeSize(512, "icon_512x512.png")
writeSize(1024, "icon_512x512@2x.png")
print("icon pngs written")
