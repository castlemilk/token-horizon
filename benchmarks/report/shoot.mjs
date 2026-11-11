#!/usr/bin/env node
/**
 * Renders report/dist/index.html from the file system, saves screenshots and checks the render.
 *
 *   npx tsx report/shoot.mjs
 *   REPORT_SHOTS_DIR=/some/dir npx tsx report/shoot.mjs      (where the screenshots go)
 *   REPORT_URL=http://127.0.0.1:8787/ npx tsx report/shoot.mjs   (check the page as served)
 *
 * The real board is checked in the headline and horizon scopes (scorer version 2: they have data and draw their charts)
 * and in the earlier-runs scope (scorer version 1). The synthetic board (report/fixtures/synthetic-board.mjs, built through the
 * real buildBoard and labelled as synthetic) is checked in every scope, so every section is exercised before real
 * data exists. Its capture images are labelled placeholders, drawn here, because no artifact is run.
 *
 * Checks (each prints PASS or FAIL; any FAIL makes the exit code 1): no console errors, warnings or page errors; no
 * request from the page; no horizontal overflow; every chart fits at 390; every section exists; one tab stop per chart;
 * no chart text cut off; no two labels overlap; no label crosses a whisker, the frontier line or a ring; every frontier
 * member is named or numbered; every label's nearest dot is its own; no number, date or range breaks across lines
 * (checked in the page text, the header and the dialog); the scroll hint shows only for a table that overflows; the
 * cost definition is quoted where cost is shown; the gallery dialog shows two captures with their viewport and time
 * after load, and one command line; the synthetic banner shows at 1440 and 390.
 */
import { mkdirSync, cpSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(homedir(), 'Library', 'Caches', 'ms-playwright-benchmarks')
}
// Imported after the browser path is set: Playwright reads it when it loads.
const { chromium } = await import('playwright')

const here = dirname(fileURLToPath(import.meta.url))
const indexUrl = process.env.REPORT_URL ?? pathToFileURL(resolve(here, 'dist', 'index.html')).href
const SHOTS_DIR = process.env.REPORT_SHOTS_DIR ?? join(tmpdir(), 'th-report-shots')
mkdirSync(SHOTS_DIR, { recursive: true })

/** Section ids the page must have. effort may be hidden when no base model has two effort levels. */
const SPEC_SECTIONS = ['glance', 'findings', 'frontier', 'heatmap', 'effort', 'reliability', 'speed', 'checks', 'gallery', 'table', 'method']
const SCOPES = ['headline', 'horizon', 'smoke', 'earlier']

const browser = await chromium.launch()
const problems = [] // console and page errors, and requests from the page: reported, and they fail the run
const failures = []
const notes = []

function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

/** Opens a page at a URL with an optional hash (the scope and model group). */
async function openPage({ width, height, scheme, url = indexUrl, hash = '' }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const tag = `[${width}x${height} ${scheme}${hash ? ' ' + hash : ''}]`
  const origin = url.startsWith('file:') ? 'file:' : new URL(url).origin
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`${tag} console ${msg.type()}: ${msg.text()}`)
  })
  page.on('pageerror', (err) => problems.push(`${tag} page error: ${err.message}`))
  page.on('requestfailed', (req) => problems.push(`${tag} request failed: ${req.url()} ${req.failure()?.errorText ?? ''}`))
  // The page makes no requests of its own: every request must be to its own origin.
  page.on('request', (req) => {
    const u = req.url()
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:')) return
    if (!u.startsWith(origin)) problems.push(`${tag} request off the page origin: ${u}`)
  })
  await page.goto(url + hash, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250)
  return { context, page }
}

async function overflowOf(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    fonts: [...document.fonts].map((f) => `${f.family}:${f.status}`)
  }))
}

/** Pairs of text boxes that intersect inside the elements matched by `sel`. */
function textOverlap(page, sel) {
  return page.evaluate((selector) => {
    const boxes = [...document.querySelectorAll(selector)].filter((t) => t.textContent.trim() !== '').map((t) => {
      const r = t.getBoundingClientRect()
      return { text: t.textContent.trim(), x0: r.left, x1: r.right, y0: r.top, y1: r.bottom }
    })
    const hits = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const p = boxes[i]
        const q = boxes[j]
        if (p.x0 < q.x1 - 0.5 && q.x0 < p.x1 - 0.5 && p.y0 < q.y1 - 0.5 && q.y0 < p.y1 - 0.5) hits.push(`${p.text} / ${q.text}`)
      }
    }
    return hits
  }, sel)
}

/**
 * Numbers, dates and ranges that break across lines, in the page text, the header and the open dialog. A number
 * is a run of digits with the separators that belong to it (5.6, 19.9, 2026-10-24, 08:39:59.843), so a break between
 * "gpt-" and "5.6" is not a break in a number, and a break inside 5.6 is. Chart text is in SVG and never wraps.
 */
function brokenNumbers(page) {
  return page.evaluate(() => {
    const roots = [document.querySelector('header.site-head'), document.getElementById('main')]
    const dlg = document.getElementById('artifact-dialog')
    if (dlg && dlg.open) roots.push(dlg)
    const out = []
    for (const root of roots) {
      if (!root) continue
      // SVG text never wraps; a digest (.hash) is one unbroken string, not a number.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && n.parentElement.closest('svg, script, style, .hash') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
      })
      let node
      while ((node = walker.nextNode())) {
        const text = node.textContent
        const re = /\d+(?:[.,:]\d+)*(?:-\d+)*/g
        let m
        while ((m = re.exec(text))) {
          const range = document.createRange()
          range.setStart(node, m.index)
          range.setEnd(node, m.index + m[0].length)
          if (range.getClientRects().length > 1) out.push(m[0] + ' in "' + text.trim().slice(0, 50) + '"')
        }
      }
    }
    return out
  })
}

// ── real board, headline and horizon scopes: each has data and draws its charts ──
/** Charts and tables the real board draws in a scope: a count per section, read from the page. */
function drawnIn(page) {
  return page.evaluate(() => ({
    frontier: document.querySelectorAll('#frontier .plot-box svg').length,
    heatmap: document.querySelectorAll('#heatmap table.heat').length,
    effort: document.querySelectorAll('#effort .plot-box svg').length,
    reliability: document.querySelectorAll('#reliability .plot-box svg').length,
    speed: document.querySelectorAll('#speed .plot-box svg').length,
    checks: document.querySelectorAll('#checks table.checks').length,
    gallery: document.querySelectorAll('#gallery button.thumb:not([disabled]) img').length,
    empties: [...document.querySelectorAll('.notice-empty')].map((n) => n.textContent)
  }))
}

for (const scope of ['headline', 'horizon']) {
  const label = scope === 'headline' ? 'Headline tasks' : 'Horizon tasks'
  const labelPage = await openPage({ width: 1440, height: 900, scheme: 'light', hash: `#scope=${scope}&models=all` })
  const n = await labelPage.page.evaluate((sc) => window.__BOARD__.scopeTasks[sc].length, scope)
  const labelText = await labelPage.page.evaluate((sc) => document.querySelector(`label:has(input[name="scope-group"][value="${sc}"])`).textContent, scope)
  check(n > 0 && labelText.replace(/\s+/g, ' ').includes(`(${n} task`), `the ${label} scope has data and says how many tasks it covers (${n}; "${labelText.trim()}")`)
  await labelPage.context.close()
  for (const width of [1440, 390]) {
    const { context, page } = await openPage({ width, height: 900, scheme: 'light', hash: `#scope=${scope}&models=all` })
    const info = await overflowOf(page)
    check(info.fonts.every((f) => f.endsWith(':loaded')), `fonts loaded at ${width} in the ${label} scope`)
    check(info.scrollWidth <= info.clientWidth, `no horizontal overflow at ${width} in the ${label} scope (scrollWidth ${info.scrollWidth}, clientWidth ${info.clientWidth})`)
    const plots = await page.evaluate(() => [...document.querySelectorAll('.plot-box')].map((box) => ({
      section: box.closest('section') ? box.closest('section').id : '(none)', box: box.clientWidth, scroll: box.scrollWidth
    })))
    const clipped = plots.filter((p) => p.scroll > p.box + 1)
    check(clipped.length === 0, `every chart fits its box at ${width} in the ${label} scope (${plots.length} charts${clipped.length ? '; clipped: ' + clipped.map((p) => `${p.section} ${p.scroll}/${p.box}`).join('; ') : ''})`)
    const broken = await brokenNumbers(page)
    check(broken.length === 0, `no number, date or range breaks across lines at ${width} in the ${label} scope${broken.length ? ': ' + broken.slice(0, 4).join(' | ') : ''}`)
    if (width === 1440) {
      const sections = await page.evaluate((ids) => ids.map((id) => {
        const el = document.getElementById(id)
        return { id, exists: !!el, hidden: !!(el && el.hidden) }
      }), SPEC_SECTIONS)
      for (const s of sections) {
        if (s.id === 'effort') check(s.exists, `section #effort exists in the ${label} scope (hidden is allowed when no base model has two efforts)`)
        else check(s.exists && !s.hidden, `section #${s.id} exists in the ${label} scope`)
      }
      const drawn = await drawnIn(page)
      notes.push(`${label} scope drawn: frontier ${drawn.frontier}, heat map ${drawn.heatmap}, effort ${drawn.effort}, reliability ${drawn.reliability}, speed ${drawn.speed}, checks ${drawn.checks}, gallery thumbnails ${drawn.gallery}`)
      check(drawn.frontier === 1 && drawn.heatmap === 1 && drawn.reliability === 1 && drawn.speed >= 1 && drawn.checks === 1,
        `the ${label} scope draws its frontier, model-by-task, reliability, speed and checks charts`)
      check(drawn.gallery > 0, `the ${label} scope shows captured thumbnails in its gallery (${drawn.gallery})`)
      check(drawn.empties.length === 0, `the ${label} scope has no empty state (${drawn.empties.length}${drawn.empties.length ? ': ' + drawn.empties[0].slice(0, 80) : ''})`)
      await page.screenshot({ path: join(SHOTS_DIR, `real-${scope}-light-1440.png`), fullPage: true })
    }
    if (width === 390) await page.screenshot({ path: join(SHOTS_DIR, `real-${scope}-light-390.png`), fullPage: true })
    await context.close()
  }
}

// ── answer, limits, truncation marks, whiskers, the held-back task and the scope offer ──
{
  const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'light', hash: '#scope=horizon&models=claude' })
  const info = await page.evaluate(() => ({
    answer: [...document.querySelectorAll('#findings .answer li')].map((l) => l.textContent),
    caveats: [...document.querySelectorAll('#findings .caveats li')].map((l) => l.textContent),
    badges: document.querySelectorAll('#heatmap .trunc-badge').length,
    truncCells: document.querySelectorAll('#checks td.trunc-cell').length,
    whiskers: document.querySelectorAll('#effort line.whisker').length,
    truncLabels: [...document.querySelectorAll('#effort text.trunc')].map((t) => t.textContent),
    scopeLine: (document.querySelector('[data-scope-line="frontier"]') || {}).textContent || '',
    smokeOffered: !!document.querySelector('input[name="scope-group"][value="smoke"]'),
    frontierTitle: (document.querySelector('#frontier .plot-box svg text.axis-title') || {}).textContent || '',
    cardAnswerFirst: document.querySelector('#findings .answer') ? document.querySelector('#findings .answer').getBoundingClientRect().top - document.querySelector('#findings').getBoundingClientRect().top : -1
  }))
  check(info.answer.length >= 2 && / leads at | share the top score/.test(info.answer[0]), `the horizon scope answers which model to use, starting with the top (${info.answer.length} sentences)`)
  check(info.caveats.some((c) => /^Each cell ran\s\d+\siterations?\./.test(c) || /^Cells ran between/.test(c)), 'the scope states its iterations per cell and the interval width')
  check(info.caveats.some((c) => /Output-cap truncations, counted as zero and billed:/.test(c)), 'the scope names the output-cap truncations among its limits')
  check(info.cardAnswerFirst >= 0 && info.cardAnswerFirst < 340, `the answer sits at the top of the findings, below the scope callout (${Math.round(info.cardAnswerFirst)} px from the section top)`)
  check(info.badges > 0 && info.truncCells > 0, `truncated cells are marked in the heat map and named in the checks matrix (${info.badges} marks, ${info.truncCells} cells)`)
  check(info.truncLabels.length > 0, `the effort chart says which level was truncated (${info.truncLabels.join(', ') || 'none'})`)
  check(info.whiskers > 0, `the effort score chart draws the 95% intervals (${info.whiskers} whisker lines)`)
  check(/seat-pricing is registered but held back: its contrast check did not pass review, so it has no results\./.test(info.scopeLine), 'the horizon scope line names the held-back task and its reason')
  check(!info.smokeOffered, 'the empty smoke scope is not offered')
  check(/All-trials score \(pts, \d+ to 100\)/.test(info.frontierTitle), `the frontier score axis is titled with its own range (${info.frontierTitle})`)
  await context.close()
}
{
  const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'light', hash: '#scope=headline&models=claude' })
  const ans = await page.evaluate(() => [...document.querySelectorAll('#findings .answer li')].map((l) => l.textContent))
  check(ans.length >= 2 && /Cheapest covered configuration:/.test(ans.join(' ')), 'the headline scope names the cheapest covered configuration and where it trails')
  const top = await page.evaluate(() => (window.__BOARD__.insights.headline.claude.find((i) => i.id === 'top') || {}).body || '')
  check(!/tied with/.test(top), 'the headline top finding names overlapping configurations as not separable, never as tied with the leader')
  await context.close()
}

// ── real board, earlier-runs scope: the scope with data ──
for (const width of [1440, 390]) {
  const { context, page } = await openPage({ width, height: 900, scheme: 'light', hash: '#scope=earlier&models=all' })
  const info = await overflowOf(page)
  check(info.scrollWidth <= info.clientWidth, `no horizontal overflow at ${width} in the earlier-runs scope (scrollWidth ${info.scrollWidth}, clientWidth ${info.clientWidth})`)
  const note = await page.evaluate(() => document.querySelector('[data-scope-line="frontier"]').textContent)
  check(/not comparable/.test(note), `the earlier-runs scope says its records are not comparable at ${width}`)
  const scopeLabel = await page.evaluate(() => document.querySelector('label:has(input[name="scope-group"][value="earlier"])').textContent)
  check(/Earlier runs \(scorer v1\) \(11 tasks\)/.test(scopeLabel.replace(/\s+/g, ' ')), `the earlier-runs scope is labelled with its own 11 tasks at ${width} (${scopeLabel.trim()})`)
  const v1 = await page.evaluate(() => window.__BOARD__.cells.filter((c) => c.scorerVersion === 1).length)
  check(v1 > 0, `the earlier-runs scope still holds the version 1 records at ${width} (${v1} cells on the board)`)
  const plots = await page.evaluate(() => [...document.querySelectorAll('.plot-box')].map((box) => ({
    section: box.closest('section') ? box.closest('section').id : '(none)',
    box: box.clientWidth,
    scroll: box.scrollWidth
  })))
  const clipped = plots.filter((p) => p.scroll > p.box + 1)
  check(clipped.length === 0, `every chart fits its box at ${width} (${plots.length} charts)${clipped.length ? '; clipped: ' + clipped.map((p) => `${p.section} ${p.scroll}/${p.box}`).join('; ') : ''}`)
  const broken = await brokenNumbers(page)
  check(broken.length === 0, `no number, date or range breaks across lines at ${width}${broken.length ? ': ' + broken.slice(0, 5).join(' | ') : ''}`)
  const hidden = await page.evaluate(() => [...document.querySelectorAll('.hidden-note')].map((n) => n.textContent))
  check(hidden.length > 0 && hidden.every((t) => /^Hidden, because no model in view has a record for (this task|these tasks): .+\.$/.test(t)), `task columns with no record are hidden and named at ${width} (${hidden.length} note)`)
  const hint = await page.evaluate(() => {
    const hintEl = document.querySelector('#heatmap .scroll-hint')
    const box = document.querySelector('#heatmap .heat-scroll')
    return { shown: !!hintEl, overflows: !!box && box.scrollWidth > box.clientWidth + 1 }
  })
  check(!hint.shown || hint.overflows, `the heat-map scroll hint shows only when the table overflows at ${width} (shown ${hint.shown}, overflows ${hint.overflows})`)
  await page.screenshot({ path: join(SHOTS_DIR, `real-earlier-light-${width}.png`), fullPage: true })
  if (width === 390) await page.screenshot({ path: join(SHOTS_DIR, 'real-earlier-light-390-top.png') })
  await context.close()
}

// ── real board, dark, desktop ──
{
  const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'dark', hash: '#scope=earlier&models=all' })
  const theme = await page.evaluate(() => document.documentElement.dataset.theme)
  check(theme === 'dark', `dark scheme sets data-theme to dark (got ${theme})`)
  await page.screenshot({ path: join(SHOTS_DIR, 'real-earlier-dark-1440.png'), fullPage: true })
  await context.close()
}

// ── real board, earlier-runs scope: the gallery dialog (captures, results, one command, no run control) ──
{
  const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'light', hash: '#scope=earlier&models=all' })
  const thumb = page.locator('#gallery button.thumb:not([disabled])').first()
  if (await thumb.count()) {
    await thumb.scrollIntoViewIfNeeded()
    await thumb.click()
    await page.waitForSelector('#artifact-dialog[open]')
    await page.waitForTimeout(400)
    const dlg = await page.evaluate(() => ({
      figures: document.querySelectorAll('#artifact-shots figure').length,
      captions: [...document.querySelectorAll('#artifact-shots figcaption')].map((c) => c.textContent),
      run: !!document.getElementById('artifact-run'),
      iframes: document.querySelectorAll('#artifact-dialog iframe').length,
      command: (document.getElementById('artifact-command') || {}).textContent || '',
      commandLines: document.querySelectorAll('#artifact-command pre').length,
      preWhite: (() => { const p = document.querySelector('#artifact-command pre'); return p ? getComputedStyle(p).whiteSpace : '' })(),
      heading: [...document.querySelectorAll('#artifact-dialog h3')].map((h) => h.textContent)
    }))
    check(dlg.figures === 2, `the dialog shows two captures (${dlg.figures})`)
    check(dlg.captions.length === 2 && /Capture 1:\s+1024\s+x\s+720\s+viewport,\s+\S+\s+s\s+after load/.test(dlg.captions[0]) && /Capture 2:\s+390\s+x\s+844\s+viewport,\s+\S+\s+s\s+after load/.test(dlg.captions[1]), 'each capture says its viewport and its time after load')
    check(dlg.captions.every((c) => /network blocked/.test(c)), 'each capture says the network was blocked')
    check(!dlg.run && dlg.iframes === 0, 'the dialog has no run control and no frame')
    check(dlg.commandLines === 1 && /rescore-behavioral\.mjs --model \S+ --task \S+ && npx tsx report\/capture\.mjs --models \S+ --tasks \S+ --force/.test(dlg.command), 'the dialog gives one local command to score and capture the artifact again')
    check(dlg.preWhite === 'pre', `the command is one line that does not wrap (white-space ${dlg.preWhite})`)
    check(!dlg.heading.some((t) => /Checks, with the iterations/.test(t)), 'the dialog has no empty heading about checks')
    const broken = await brokenNumbers(page)
    check(broken.length === 0, `no number breaks in the dialog${broken.length ? ': ' + broken.slice(0, 3).join(' | ') : ''}`)
    await page.screenshot({ path: join(SHOTS_DIR, 'dialog-earlier-1440.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const closed = await page.evaluate(() => !document.getElementById('artifact-dialog').open)
    check(closed, 'Escape closes the dialog')
  }
  await context.close()
}
{
  const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'light', hash: '#scope=earlier&models=all' })
  const thumb = page.locator('#gallery button.thumb:not([disabled])').first()
  if (await thumb.count()) {
    await thumb.scrollIntoViewIfNeeded()
    await thumb.click()
    await page.waitForSelector('#artifact-dialog[open]')
    await page.mouse.click(3, 3)
    await page.waitForTimeout(250)
    const closed = await page.evaluate(() => !document.getElementById('artifact-dialog').open)
    check(closed, 'a click on the backdrop closes the dialog')
  }
  await context.close()
}
{
  const { context, page } = await openPage({ width: 390, height: 844, scheme: 'light', hash: '#scope=earlier&models=all' })
  const thumb = page.locator('#gallery button.thumb:not([disabled])').first()
  if (await thumb.count()) {
    await thumb.scrollIntoViewIfNeeded()
    await thumb.click()
    await page.waitForSelector('#artifact-dialog[open]')
    await page.waitForTimeout(300)
    const dlg = await page.evaluate(() => {
      const d = document.getElementById('artifact-dialog')
      const cells = [...d.querySelectorAll('.dlg-details table')].map((t) => t.getBoundingClientRect().right)
      return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, tablesRight: Math.max(0, ...cells), dialogRight: d.getBoundingClientRect().right }
    })
    check(dlg.scrollWidth <= dlg.clientWidth + 1, `dialog does not scroll sideways at 390 (scrollWidth ${dlg.scrollWidth}, clientWidth ${dlg.clientWidth})`)
    check(dlg.tablesRight <= dlg.dialogRight + 1, `dialog check-results table stays inside the dialog at 390 (table right ${Math.round(dlg.tablesRight)}, dialog right ${Math.round(dlg.dialogRight)})`)
    const broken = await brokenNumbers(page)
    check(broken.length === 0, `no number breaks in the dialog at 390${broken.length ? ': ' + broken.slice(0, 3).join(' | ') : ''}`)
    await page.screenshot({ path: join(SHOTS_DIR, 'dialog-earlier-390.png') })
  }
  await context.close()
}

// ── keyboard: one tab stop per chart, arrow keys between marks, anchors and chevrons ──
{
  const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'light', hash: '#scope=earlier&models=all' })
  await page.evaluate(() => {
    document.querySelectorAll('.plot-box').forEach((b, i) => b.setAttribute('data-plot', String(i)))
    window.scrollTo(0, 0)
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  })
  const plotsReached = new Map()
  let plotStopsAll = 0
  for (let k = 0; k < 900; k++) {
    await page.keyboard.press('Tab')
    const hit = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      if (!el.dataset.tabid) el.dataset.tabid = String(Math.random()).slice(2)
      const box = el.closest('.plot-box')
      return box ? { id: el.dataset.tabid, plot: box.getAttribute('data-plot'), section: box.closest('section') ? box.closest('section').id : '(none)' } : null
    })
    if (hit) {
      plotStopsAll += 1
      if (!plotsReached.has(hit.plot)) plotsReached.set(hit.plot, { section: hit.section, ids: new Set() })
      plotsReached.get(hit.plot).ids.add(hit.id)
    }
  }
  const stops = [...plotsReached.values()].map((p) => ({ section: p.section, stops: p.ids.size }))
  const multi = stops.filter((s) => s.stops > 1)
  check(stops.length > 0, `Tab reaches the charts (${stops.length} charts reached, ${plotStopsAll} presses landed in them)`)
  check(multi.length === 0, `each chart has at most one tab stop (${stops.length} charts${multi.length ? '; more than one: ' + multi.map((m) => m.section).join(', ') : ''})`)
  const clipped = await page.evaluate(() => {
    const out = []
    document.querySelectorAll('.plot-box svg').forEach((svg) => {
      const vb = svg.viewBox && svg.viewBox.baseVal
      const W = vb && vb.width ? vb.width : svg.getBoundingClientRect().width
      const H = vb && vb.height ? vb.height : svg.getBoundingClientRect().height
      const top = svg.getBoundingClientRect()
      svg.querySelectorAll('text').forEach((t) => {
        if (t.hasAttribute('transform')) {
          // A rotated label is measured on screen, against the chart's own box.
          const r = t.getBoundingClientRect()
          if (r.width === 0) return
          if (r.left < top.left - 0.5 || r.right > top.right + 0.5 || r.top < top.top - 0.5 || r.bottom > top.bottom + 0.5) {
            out.push((svg.closest('section') ? svg.closest('section').id : '(none)') + ': "' + t.textContent + '" (rotated)')
          }
          return
        }
        const b = t.getBBox()
        if (b.width === 0) return
        if (b.x < -0.5 || b.x + b.width > W + 0.5 || b.y < -0.5 || b.y + b.height > H + 0.5) {
          out.push((svg.closest('section') ? svg.closest('section').id : '(none)') + ': "' + t.textContent + '"')
        }
      })
    })
    return out
  })
  check(clipped.length === 0, `no chart text is cut off at its viewBox edge${clipped.length ? ' (' + clipped.length + '; ' + clipped.slice(0, 4).join('; ') + ')' : ''}`)
  const arrowOk = await page.evaluate(() => {
    const svg = document.querySelector('#speed .plot-box svg')
    if (!svg) return { ok: false, why: 'no speed chart' }
    const marks = [...svg.querySelectorAll('g.mark')]
    if (marks.length < 2) return { ok: true, why: 'fewer than two marks; nothing to step between' }
    marks[0].focus()
    const first = document.activeElement
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const second = document.activeElement
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    const back = document.activeElement
    return { ok: second !== first && back === first, why: `first ${first === marks[0]}, after right ${second === marks[1]}, after left ${back === marks[0]}` }
  })
  check(arrowOk.ok, `arrow keys move between speed marks (${arrowOk.why})`)
  const chevrons = await page.evaluate(() => [...document.querySelectorAll('details.disclose > summary')].map((s) => getComputedStyle(s, '::before').content))
  check(chevrons.length > 0 && chevrons.every((c) => c !== 'none' && c !== 'normal' && c !== ''), `every "View as table" disclosure shows a chevron (${chevrons.length} disclosures)`)
  await context.close()
}

/**
 * Main chart and reliability chart in one scope and width: no label crosses a whisker, the frontier line or a ring; no
 * two labels overlap; every frontier member is named or numbered; every label's nearest dot is its own; the reliability
 * and speed texts do not overlap; the frontier's axis title clears its tick labels.
 */
async function chartChecks(url, scope, width, scheme = 'light', models = 'all') {
  const { context, page } = await openPage({ width, height: 900, scheme, url, hash: `#scope=${scope}&models=${models}` })
  const res = await page.evaluate(() => {
    const svg = document.querySelector('#frontier .plot-box svg')
    if (!svg) return { none: true }
    const labelNodes = [...svg.querySelectorAll('text.lbl')]
    const labels = labelNodes.map((t) => {
      const b = t.getBBox()
      return {
        n: t.textContent, x0: b.x - 1, x1: b.x + b.width + 1, y0: b.y - 1, y1: b.y + b.height + 1,
        dot: t.getAttribute('data-dot'), ax: +t.getAttribute('x'), ay: +t.getAttribute('y') - 4, leader: t.hasAttribute('data-leader'),
        num: t.classList.contains('num-label')
      }
    })
    // Every base model (a model that is not an effort variant), and every configuration at the top value, is named beside
    // its dot at 900 px and above.
    const baseMissing = [...svg.querySelectorAll('g.mark[data-base="1"], g.mark[data-top="1"]')]
      .filter((g) => !labels.some((l) => l.dot === g.getAttribute('data-dot') && !l.num))
      .map((g) => (g.getAttribute('aria-label') || '').split(':')[0])
    // Below 900 px the frontier list under the chart names every frontier member, numbered from 1.
    const listItems = document.querySelectorAll('#frontier .frontier-names li')
    const listFirst = listItems.length ? +listItems[0].value : null
    const numbered = [...svg.querySelectorAll('text.num-label')].map((t) => t.textContent)
    const ringDots = new Set([...svg.querySelectorAll('g.mark[data-dot]')].filter((g) => g.querySelector('circle.frontier-ring')).map((g) => g.getAttribute('data-dot')))
    const namedRings = [...svg.querySelectorAll('text.lbl:not(.num-label)')].filter((t) => ringDots.has(t.getAttribute('data-dot'))).length
    const segs = [...svg.querySelectorAll('line[class^="stroke-"]')].map((l) => ({
      x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'), x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2')
    }))
    const rings = [...svg.querySelectorAll('circle.frontier-ring')].map((c) => ({ cx: +c.getAttribute('cx'), cy: +c.getAttribute('cy'), r: +c.getAttribute('r') }))
    const marks = [...svg.querySelectorAll('g.mark[data-dot] circle.mark-dot')].map((c) => {
      const g = c.closest('g.mark')
      return { i: g.getAttribute('data-dot'), x: +c.getAttribute('cx'), y: +c.getAttribute('cy') }
    })
    const fl = svg.querySelector('path.frontier-line')
    const pts = []
    if (fl) {
      const L = fl.getTotalLength()
      for (let s = 0; s <= 400; s++) pts.push(fl.getPointAtLength((L * s) / 400))
    }
    const inBox = (x, y, b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1
    const problems = []
    // A leader line joins a label to its dot and may not cross any other label's box (the label it belongs to is its own).
    const leaderSegs = [...svg.querySelectorAll('line.leader')]
    for (const l of leaderSegs) {
      const own = labelNodes.indexOf(l.nextElementSibling)
      const seg = { x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'), x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2') }
      labels.forEach((lab, idx) => {
        if (idx === own) return
        for (let s = 0; s <= 200; s++) {
          const t = s / 200
          if (inBox(seg.x1 + (seg.x2 - seg.x1) * t, seg.y1 + (seg.y2 - seg.y1) * t, lab)) { problems.push('a leader line crosses "' + lab.n + '"'); break }
        }
      })
    }
    for (const lab of labels) {
      for (const sg of segs) {
        for (let s = 0; s <= 60; s++) {
          const t = s / 60
          if (inBox(sg.x1 + (sg.x2 - sg.x1) * t, sg.y1 + (sg.y2 - sg.y1) * t, lab)) { problems.push(lab.n + ' over a whisker'); s = 61 }
        }
      }
      if (pts.some((p) => inBox(p.x, p.y, lab))) problems.push(lab.n + ' over the frontier line')
      for (const r of rings) {
        const nx = Math.max(lab.x0, Math.min(r.cx, lab.x1))
        const ny = Math.max(lab.y0, Math.min(r.cy, lab.y1))
        if ((nx - r.cx) ** 2 + (ny - r.cy) ** 2 < r.r ** 2) problems.push(lab.n + ' over a ring')
      }
      // The label's nearest dot is its own: the dot nearest its anchor must carry the label's data-dot.
      if (lab.dot !== null && marks.length && !lab.leader) {
        let best = null
        for (const m of marks) {
          const dist = Math.hypot(lab.ax - m.x, lab.ay - m.y)
          if (!best || dist < best.dist) best = { i: m.i, dist }
        }
        if (best && best.i !== lab.dot) problems.push(lab.n + ' is nearer another dot')
      }
    }
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j]
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) problems.push(a.n + ' over ' + b.n)
      }
    }
    const note = [...document.querySelectorAll('#frontier .section-foot')].map((p) => p.textContent).join(' ')
    const dots = svg.querySelectorAll('circle.frontier-ring').length
    // The rotated axis title must clear the tick labels on its left.
    const axisTitle = svg.querySelector('text.axis-title[transform]')
    const ticks = [...svg.querySelectorAll('text.tick')].filter((t) => +t.getAttribute('x') < 60)
    const titleBox = axisTitle ? axisTitle.getBoundingClientRect() : null
    const tickOverlap = titleBox ? ticks.filter((t) => {
      const r = t.getBoundingClientRect()
      return titleBox.left < r.right && r.left < titleBox.right && titleBox.top < r.bottom && r.top < titleBox.bottom
    }).map((t) => t.textContent) : []
    return { labels: labels.length, leaders: leaderSegs.length, rings: rings.length, numbered: numbered.length, namedRings, problems: [...new Set(problems)], dots, note, tickOverlap, baseMissing, listItems: listItems.length, listFirst }
  })
  if (res.none) {
    check(true, `main chart: no frontier chart in ${scope} at ${width} (no priced model in view)`)
  } else {
    check(res.problems.length === 0, `main chart at ${width}, ${scope}: no label crosses a whisker, the frontier line or a ring, no two labels overlap, no leader line crosses another label, and each label's nearest dot is its own (${res.labels} labels, ${res.leaders} leader lines${res.problems.length ? '; ' + res.problems.slice(0, 4).join('; ') : ''})`)
    // From a 900 px page every frontier member is named beside its dot; narrower, each is numbered and listed by name under the chart.
    if (width >= 900) {
      check((res.rings === 0 || res.namedRings === res.rings) && res.baseMissing.length === 0, `every frontier member, every base model and every top-value configuration is named beside its dot at ${width}, ${scope}, ${models} (${res.namedRings} of ${res.rings} frontier members named; base or top-value models without a label: ${res.baseMissing.join(', ') || 'none'})`)
    } else {
      check(res.rings === 0 || (res.numbered === res.rings && res.listItems === res.rings && res.listFirst === 1), `every frontier member is numbered from 1, its number is drawn beside its ring, and it is listed by name under the chart at ${width}, ${scope}, ${models} (${res.numbered} numbers drawn, ${res.listItems} listed, ${res.rings} frontier members)`)
    }
    check(res.tickOverlap.length === 0, `the frontier axis title clears its tick labels at ${width}, ${scope}${res.tickOverlap.length ? ': ' + res.tickOverlap.join(', ') : ''}`)
  }
  const rel = await textOverlap(page, '#reliability .plot-box svg text')
  check(rel.length === 0, `reliability chart texts do not overlap at ${width}, ${scope}${rel.length ? ': ' + rel.slice(0, 3).join('; ') : ''}`)
  const speed = await textOverlap(page, '#speed .plot-box svg text')
  check(speed.length === 0, `speed chart texts do not overlap at ${width}, ${scope}${speed.length ? ': ' + speed.slice(0, 3).join('; ') : ''}`)
  const frontierSection = await page.evaluate(() => (document.querySelector('#frontier') ? document.querySelector('#frontier').textContent : ''))
  const defs = (frontierSection.match(/The frontier is the stepped line/g) || []).length
  check(defs <= 1, `the frontier definition is printed at most once in its section at ${width}, ${scope} (${defs})`)
  await page.screenshot({ path: join(SHOTS_DIR, `chart-${scope}-${models}-${scheme}-${width}.png`), fullPage: true })
  await context.close()
}

/**
 * Effort charts in one scope, model group and width: no value label crosses the line between a base model's levels, a
 * whisker or cap, a point, or another value label. Each panel is one SVG; its value labels are text.val.
 */
async function effortChecks(url, scope, width, models, scheme = 'light') {
  const { context, page } = await openPage({ width, height: 900, scheme, url, hash: `#scope=${scope}&models=${models}` })
  const res = await page.evaluate(() => {
    const problems = []
    let values = 0
    let marks = 0
    let panels = 0
    const inBox = (x, y, b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1
    const segHits = (x1, y1, x2, y2, b) => {
      for (let s = 0; s <= 80; s++) {
        const t = s / 80
        if (inBox(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, b)) return true
      }
      return false
    }
    document.querySelectorAll('#effort .plot-box svg').forEach((svg) => {
      panels += 1
      const name = (svg.getAttribute('aria-label') || svg.closest('.panel')?.querySelector('h3')?.textContent || '(panel)')
      const segs = []
      svg.querySelectorAll('polyline').forEach((p) => {
        const nums = (p.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number)
        for (let i = 0; i + 3 < nums.length; i += 2) segs.push([nums[i], nums[i + 1], nums[i + 2], nums[i + 3]])
      })
      svg.querySelectorAll('line[class*="whisker"]').forEach((l) => {
        segs.push([+l.getAttribute('x1'), +l.getAttribute('y1'), +l.getAttribute('x2'), +l.getAttribute('y2')])
      })
      const dots = [...svg.querySelectorAll('circle.mark-dot')].map((c) => ({ x0: +c.getAttribute('cx') - 5, x1: +c.getAttribute('cx') + 5, y0: +c.getAttribute('cy') - 5, y1: +c.getAttribute('cy') + 5 }))
      const labels = [...svg.querySelectorAll('text.val, text.trunc-mark')].map((t) => {
        const b = t.getBBox()
        return { n: t.textContent, x0: b.x, x1: b.x + b.width, y0: b.y, y1: b.y + b.height }
      })
      marks += labels.filter((l) => l.n === 'T').length
      values += labels.length - labels.filter((l) => l.n === 'T').length
      for (const lab of labels) {
        if (segs.some((s) => segHits(s[0], s[1], s[2], s[3], lab))) problems.push(name + ': "' + lab.n + '" on a line or whisker')
        if (dots.some((d) => lab.x0 < d.x1 && d.x0 < lab.x1 && lab.y0 < d.y1 && d.y0 < lab.y1)) problems.push(name + ': "' + lab.n + '" on a point')
      }
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i], b = labels[j]
          if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) problems.push(name + ': "' + a.n + '" over "' + b.n + '"')
        }
      }
    })
    const valueText = document.querySelector('#effort') ? document.querySelector('#effort').textContent : ''
    return { panels, values, marks, problems: [...new Set(problems)], has961: valueText.includes('96.1'), has960: /\b96\.0\b/.test(valueText) }
  })
  check(res.problems.length === 0, `effort value labels and T marks clear every line, whisker, point and other label at ${width}, ${scope}, ${models}, ${scheme} (${res.panels} panels, ${res.values} values, ${res.marks} T marks${res.problems.length ? '; ' + res.problems.slice(0, 4).join('; ') : ''})`)
  if (scope === 'horizon' && models === 'claude' && scheme === 'light' && width === 1440) {
    check(res.has961 && !res.has960, `the effort section shows Opus 5.5 (medium effort) at 96.1, not 96.0 (${res.has961 ? '96.1 shown' : '96.1 missing'}, ${res.has960 ? '96.0 shown' : 'no 96.0'})`)
  }
  await context.close()
}

/** Frontier labels: each label not in a place beside its dot (more than 21 px from it) carries a leader line. */
async function frontierLeaderCheck(url, scope, width, models) {
  const { context, page } = await openPage({ width, height: 900, scheme: 'light', url, hash: `#scope=${scope}&models=${models}` })
  const res = await page.evaluate(() => {
    const svg = document.querySelector('#frontier .plot-box svg')
    if (!svg) return { none: true }
    const marks = [...svg.querySelectorAll('g.mark[data-dot] circle.mark-dot')].map((c) => ({ i: c.closest('g.mark').getAttribute('data-dot'), x: +c.getAttribute('cx'), y: +c.getAttribute('cy') }))
    const unlinked = [...svg.querySelectorAll('text.lbl')].filter((t) => {
      if (t.hasAttribute('data-leader')) return false
      const d = marks.find((m) => m.i === t.getAttribute('data-dot'))
      if (!d) return false
      return Math.hypot(+t.getAttribute('x') - d.x, +t.getAttribute('y') - 4 - d.y) > 21
    }).map((t) => t.textContent)
    const tickValues = [...svg.querySelectorAll('text.tick')].map((t) => t.textContent)
    const linked = [...svg.querySelectorAll('text.lbl[data-leader]')].length
    const leaders = svg.querySelectorAll('line.leader').length
    return { unlinked, has100: tickValues.includes('100'), linked, leaders }
  })
  if (res.none) {
    check(true, `frontier leader lines: no frontier chart in ${scope} at ${width}, ${models}`)
    await context.close()
    return
  }
  check(res.unlinked.length === 0 && res.leaders >= res.linked, `every frontier label not beside its dot has a leader line at ${width}, ${scope}, ${models} (${res.linked} labels with a leader, ${res.leaders} leader lines${res.unlinked.length ? '; unlinked: ' + res.unlinked.slice(0, 4).join('; ') : ''})`)
  check(res.has100, `the frontier y axis draws the 100 tick at ${width}, ${scope}, ${models}`)
  await context.close()
}

/** The first load with no hash: the page is at the top and the title is in view at phone and desktop widths. */
async function firstLoadChecks() {
  for (const width of [1440, 390]) {
    const { context, page } = await openPage({ width, height: width < 600 ? 844 : 900, scheme: 'light' })
    const r = await page.evaluate(() => {
      const h1 = document.querySelector('h1')
      const rect = h1 ? h1.getBoundingClientRect() : null
      return { y: window.scrollY, top: rect ? rect.top : null, bottom: rect ? rect.bottom : null, vh: window.innerHeight }
    })
    check(r.y === 0 && r.top !== null && r.top >= 0 && r.bottom <= r.vh, `first load at ${width} px with no hash: scrollY ${r.y}, the title is in view (top ${r.top === null ? 'missing' : Math.round(r.top)} px)`)
    await context.close()
  }
}

for (const width of [1440, 390]) await chartChecks(indexUrl, 'earlier', width)
// The real board's main chart, in each scope and model group with priced models, at the widths either side of the names-fit
// width: no label over another label or a whisker, nearest dot is its own, every base model named from 900 px.
for (const models of ['all', 'claude']) {
  for (const scope of ['headline', 'horizon']) {
    for (const width of [1440, 1024, 900, 768, 390]) await chartChecks(indexUrl, scope, width, 'light', models)
  }
}
await chartChecks(indexUrl, 'headline', 1440, 'dark', 'all')
await firstLoadChecks()
for (const models of ['claude', 'all']) {
  for (const scope of ['headline', 'horizon']) {
    for (const width of [1440, 390]) {
      await effortChecks(indexUrl, scope, width, models)
      await frontierLeaderCheck(indexUrl, scope, width, models)
    }
  }
}
await effortChecks(indexUrl, 'horizon', 1440, 'claude', 'dark')
await effortChecks(indexUrl, 'headline', 1440, 'claude', 'dark')

/** Placeholder captures for the synthetic board: one JPEG per shape, labelled so no one reads them as results. */
async function writePlaceholders(board, synthDir) {
  const context = await browser.newContext({ deviceScaleFactor: 1 })
  const page = await context.newPage()
  const shapes = { wide: { width: 768, height: 540, label: '768 x 540' }, narrow: { width: 250, height: 540, label: '250 x 540' } }
  const bufs = {}
  for (const [key, s] of Object.entries(shapes)) {
    await page.setViewportSize({ width: s.width, height: s.height })
    await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#e7ebef;font:600 14px -apple-system,sans-serif;color:#2a2f36;text-align:center;padding:12px;box-sizing:border-box">
      <div>SYNTHETIC PLACEHOLDER<br><span style="font-weight:400">Not a capture of any artifact.<br>${s.label}</span></div></body></html>`)
    bufs[key] = await page.screenshot({ type: 'jpeg', quality: 68 })
  }
  await context.close()
  let written = 0
  for (const cellRow of board.cells) {
    cellRow.shots.forEach((rel, i) => {
      const dest = join(synthDir, rel.replace(/^dist\//, ''))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, i === 0 ? bufs.wide : bufs.narrow)
      written += 1
    })
  }
  return written
}

// ── synthetic board: built through the real buildBoard, every scope, every section ──
{
  const { buildSyntheticBoard } = await import('./fixtures/synthetic-board.mjs')
  const board = buildSyntheticBoard()
  const synthDir = join(SHOTS_DIR, 'synthetic-dist')
  rmSync(synthDir, { recursive: true, force: true })
  cpSync(join(here, 'dist'), synthDir, { recursive: true })
  writeFileSync(join(synthDir, 'data', 'board.js'), `window.__BOARD__ = ${JSON.stringify(board)};\n`)
  const placeholders = await writePlaceholders(board, synthDir)
  notes.push(`synthetic placeholders written: ${placeholders} (labelled as placeholders)`)
  const synthUrl = pathToFileURL(join(synthDir, 'index.html')).href
  check(board.source.synthetic === true, 'the synthetic board says it is synthetic (source.synthetic)')
  check(existsSync(join(synthDir, 'gallery')), 'the synthetic board has its placeholder captures in place')

  for (const scope of SCOPES) {
    const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'light', url: synthUrl, hash: `#scope=${scope}&models=all` })
    const header = await page.evaluate(() => document.querySelector('.site-head').innerText)
    const banner = await page.evaluate(() => { const b = document.getElementById('synthetic-banner'); return !!b && !b.hidden && b.textContent.length > 0 })
    const bannerText = await page.evaluate(() => (document.getElementById('synthetic-banner') || {}).textContent || '')
    check(/synthetic/i.test(header) && banner && /Synthetic data/.test(bannerText), `the synthetic board names itself in the header and the banner, "Synthetic data" (${scope} 1440)`)
    const info = await overflowOf(page)
    check(info.scrollWidth <= info.clientWidth, `no horizontal overflow at 1440 on the synthetic board, ${scope} (scrollWidth ${info.scrollWidth}, clientWidth ${info.clientWidth})`)
    const drawn = await page.evaluate(() => document.querySelectorAll('.plot-box svg').length)
    const empties = await page.evaluate(() => document.querySelectorAll('.notice-empty').length)
    notes.push(`synthetic ${scope}: ${drawn} charts drawn, ${empties} empty states`)
    const broken = await brokenNumbers(page)
    check(broken.length === 0, `no number, date or range breaks across lines on the synthetic board, ${scope} 1440${broken.length ? ': ' + broken.slice(0, 4).join(' | ') : ''}`)
    const costDef = await page.evaluate(() => {
      const def = (window.__BOARD__.definitions || {}).costPerAttempt || ''
      const quoted = ['#findings', '#frontier', '#effort', '#table', '#method'].filter((sel) => {
        const el = document.querySelector(sel)
        return el && !el.hidden && el.textContent.indexOf(def) >= 0
      })
      return { def, quoted }
    })
    check(costDef.def.length > 0 && costDef.quoted.length >= 4, `the cost definition is quoted in the findings, frontier, table and method (${costDef.quoted.join(', ')})`)
    await page.screenshot({ path: join(SHOTS_DIR, `synth-${scope}-light-1440.png`), fullPage: true })
    if (scope === 'headline') {
      const effort = await page.evaluate(() => {
        const sec = document.getElementById('effort')
        return { hidden: sec.hidden, height: sec.getBoundingClientRect().height, models: sec.querySelectorAll('.effort-model').length }
      })
      check(!effort.hidden && effort.height > 0 && effort.models >= 3, `the reasoning-effort section is visible with ${effort.models} base models (3 tiers expected)`)
      const outOfDate = await page.evaluate(() => [...document.querySelectorAll('#gallery button.thumb')].filter((b) => /capture out of date/.test(b.textContent)).length)
      check(outOfDate === 1, `the out-of-date capture is shown as out of date, not as a capture (${outOfDate} thumbnail)`)
    }
    await context.close()
  }

  // Dark, phone and each scope at 390.
  for (const scope of SCOPES) {
    const { context, page } = await openPage({ width: 390, height: 844, scheme: 'light', url: synthUrl, hash: `#scope=${scope}&models=all` })
    const info = await overflowOf(page)
    check(info.scrollWidth <= info.clientWidth, `no horizontal overflow at 390 on the synthetic board, ${scope} (scrollWidth ${info.scrollWidth}, clientWidth ${info.clientWidth})`)
    const plots = await page.evaluate(() => [...document.querySelectorAll('.plot-box')].map((box) => ({ box: box.clientWidth, scroll: box.scrollWidth, section: box.closest('section') ? box.closest('section').id : '(none)' })))
    const clipped = plots.filter((p) => p.scroll > p.box + 1)
    check(clipped.length === 0, `every chart fits its box at 390 on the synthetic board, ${scope} (${plots.length} charts${clipped.length ? '; clipped: ' + clipped.map((p) => p.section).join(', ') : ''})`)
    const bannerVisible = await page.evaluate(() => { const b = document.getElementById('synthetic-banner'); return !!b && !b.hidden && b.getBoundingClientRect().height > 0 })
    check(bannerVisible, `the synthetic banner shows at 390, ${scope}`)
    const broken = await brokenNumbers(page)
    check(broken.length === 0, `no number, date or range breaks across lines at 390 on the synthetic board, ${scope}${broken.length ? ': ' + broken.slice(0, 4).join(' | ') : ''}`)
    await page.screenshot({ path: join(SHOTS_DIR, `synth-${scope}-light-390.png`), fullPage: true })
    await context.close()
  }

  // The gallery dialog on the synthetic board: a posed capture and an unposed one, both captioned with their state.
  {
    const { context, page } = await openPage({ width: 390, height: 844, scheme: 'light', url: synthUrl, hash: '#scope=headline&models=claude' })
    const posed = page.locator('#gallery button.thumb:not([disabled])').first()
    await posed.scrollIntoViewIfNeeded()
    await posed.click()
    await page.waitForSelector('#artifact-dialog[open]')
    await page.waitForTimeout(300)
    const captions = await page.evaluate(() => [...document.querySelectorAll('#artifact-shots figcaption')].map((c) => c.textContent))
    check(captions.length === 2 && captions.every((c) => /network blocked/.test(c)), `the synthetic dialog at 390 shows two captions with the network blocked (${captions.length})`)
    check(captions.length === 2 && /Capture 1:.*after load/.test(captions[0]) && /Capture 2:.*after load/.test(captions[1]), 'each synthetic caption gives its time after load')
    const dlg = await page.evaluate(() => {
      const d = document.getElementById('artifact-dialog')
      return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth }
    })
    check(dlg.scrollWidth <= dlg.clientWidth + 1, `the synthetic dialog does not scroll sideways at 390 (scrollWidth ${dlg.scrollWidth}, clientWidth ${dlg.clientWidth})`)
    await page.screenshot({ path: join(SHOTS_DIR, 'dialog-synthetic-390.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await context.close()
  }

  for (const scope of ['headline', 'earlier']) {
    const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'dark', url: synthUrl, hash: `#scope=${scope}&models=all` })
    await page.screenshot({ path: join(SHOTS_DIR, `synth-${scope}-dark-1440.png`), fullPage: true })
    await context.close()
  }
  await chartChecks(synthUrl, 'headline', 1440)
  await chartChecks(synthUrl, 'headline', 390)
  await chartChecks(synthUrl, 'smoke', 390)
  await chartChecks(synthUrl, 'headline', 1440, 'dark')

  // Scroll anchor: a finding's "See chart" link, then a filter change, leaves the heat-map section where it was.
  {
    const { context, page } = await openPage({ width: 1440, height: 900, scheme: 'light', url: synthUrl, hash: '#scope=headline&models=claude' })
    const link = page.locator('a.see[href="#heatmap"]').first()
    if (await link.count()) {
      await link.click()
      await page.waitForTimeout(200)
      const before = await page.evaluate(() => document.getElementById('heatmap').getBoundingClientRect().top)
      await page.locator('label:has(input[name="scope-group"][value="smoke"])').click()
      await page.waitForTimeout(200)
      const after = await page.evaluate(() => document.getElementById('heatmap').getBoundingClientRect().top)
      check(Math.abs(after - before) < 2, `a filter change after "See chart" keeps the heat-map section in place (top ${Math.round(before)} then ${Math.round(after)})`)
    } else {
      check(false, 'a "See chart" link to the heat map exists for the scroll-anchor check')
    }
    await context.close()
  }

  // The real board does not say it is synthetic.
  const real = await openPage({ width: 1440, height: 900, scheme: 'light' })
  const realHeader = await real.page.evaluate(() => document.querySelector('.site-head').innerText)
  const realBanner = await real.page.evaluate(() => document.getElementById('synthetic-banner').hidden)
  check(!/synthetic/i.test(realHeader) && realBanner, 'the real board is not labelled synthetic')
  await real.context.close()
}

await browser.close()

console.log(`screenshots written to ${SHOTS_DIR}`)
for (const n of notes) console.log('note:', n)
console.log(`console and page errors (${problems.length}):`)
for (const p of problems) console.log('  ' + p)
if (!problems.length) console.log('  none')
check(problems.length === 0, 'no console errors, warnings, page errors or requests off the page origin')
console.log(`${failures.length} failed check(s)`)
process.exitCode = failures.length ? 1 : 0
