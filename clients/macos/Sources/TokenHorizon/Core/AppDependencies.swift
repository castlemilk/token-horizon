import Foundation

/// Composition root factory (Go analogue: "push concrete wiring up to `main`").
///
/// Today this is intentionally thin: it names the single place where concrete
/// dependencies are chosen so call sites stop hard-coding `X.shared` /
/// `X()` constructors scattered through the call tree. Adopt incrementally —
/// each migration is one line at the call site (see `AppDelegate.engine`) and
/// changes no behavior. Test-only wiring passes fakes directly and never
/// touches this factory.
enum AppDependencies {
    static func makeUsageEngine() -> UsageEngine { UsageEngine() }

    static func makeClock() -> THClock { SystemClock() }

    static func makeFileSystem() -> THFileReading { LiveFileSystem() }
}
