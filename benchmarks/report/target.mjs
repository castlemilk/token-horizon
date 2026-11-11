/**
 * Target-specific text of the static report, shared by build.mjs and the tests. No side effects: importing this module
 * builds nothing.
 */

/**
 * The template for one target. The blocks marked for the other target are removed, and the marker lines of this target
 * are dropped, so the built page carries no marker of either kind.
 */
export function forTarget(html, which) {
  const other = which === 'public' ? 'private' : 'public'
  let text = html.replace(new RegExp(`<!--@${other}-->[\\s\\S]*?<!--/@${other}-->\\n?`, 'g'), '')
  text = text.replace(new RegExp(`[ \\t]*<!--/?@${which}-->\\n?`, 'g'), '').replace(/__TARGET__/g, which)
  if (/<!--\/?@(public|private)-->/.test(text)) throw new Error('build: unmatched target marker in index.html')
  return text
}

/** The public report.css loads the site's fonts from /fonts/ (the private one from its own fonts folder). */
export function cssForTarget(css, which) {
  if (which !== 'public') return css
  return css.replace(/url\((['"]?)(?:\.\/)?fonts\//g, 'url($1/fonts/')
}

/**
 * The page script for one target. The spans marked /*@private*\/ ... /*\/@private*\/ (the reproduce section and the dialog's
 * command) are removed from the public script, so no harness command ships with it; the private script keeps them.
 */
export function jsForTarget(js, which) {
  if (which === 'public') return js.replace(/\/\*@private\*\/[\s\S]*?\/\*\/@private\*\//g, '')
  return js.replace(/\/\*\/?@private\*\//g, '')
}
