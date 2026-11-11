'use client'

// Horizon Suite tasks have no interactive reference demo: each is graded against
// hidden inputs that the page never shows. Generated artifacts appear below this note.
export function HorizonSuiteDemo({ className = '' }: { className?: string }) {
  return <div className={`p-6 text-sm text-muted ${className}`}>
    This task has no interactive reference demo. Its checks use hidden inputs, so
    the only reference is the generated artifact below, graded against the same
    deterministic checks.
  </div>
}
