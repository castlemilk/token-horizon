/**
 * True inside the Electron shell, where the preload injected `window.conveyor`. False in the
 * plain web build — conveyor calls must be skipped there (the bridge doesn't exist).
 */
export const isElectron = typeof window !== 'undefined' && 'conveyor' in window

/** Open a URL in the system browser — via the web module under Electron, a new tab on the web. */
export function openExternal(url: string): void {
  if (isElectron) {
    void import('@/conveyor/client').then(({ conveyor }) => conveyor.web.openUrl(url))
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
