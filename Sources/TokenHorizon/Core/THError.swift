import Foundation

/// Context-chained error (Go analogue: `fmt.Errorf("doing X: %w", err)`).
///
/// Conventions for new code (mirrors the Go error rules adopted here):
/// - WRAP with context at the boundary where the failure is understood:
///   `THError("loading codex session \(path)", underlying: err)`.
/// - Handle an error ONCE: log-and-degrade OR wrap-and-return, never both.
/// - `description` prints newest context first, cause chain after — like `%w`
///   chains printing newest-to-oldest.
/// - Match with `as? THError` / `underlying as? <Specific>` (the
///   `errors.As` analogue), never by string-comparing messages.
struct THError: Error {
    let context: String
    let underlying: Error?

    init(_ context: String, underlying: Error? = nil) {
        self.context = context
        self.underlying = underlying
    }

    /// Wrap this error in one more layer of context.
    func wrapping(_ outerContext: String) -> THError {
        THError(outerContext, underlying: self)
    }
}

extension THError: LocalizedError {
    var errorDescription: String? { String(describing: self) }
}

extension THError: CustomStringConvertible {
    var description: String {
        var parts = [context]
        var current = underlying
        while let err = current {
            if let wrapped = err as? THError {
                parts.append(wrapped.context)
                current = wrapped.underlying
            } else {
                parts.append(String(describing: err))
                break
            }
        }
        return parts.joined(separator: ": ")
    }
}
