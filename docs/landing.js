/* Token Horizon's interactive, illustrative product tour.
 * No provider calls, analytics, animation framework or video download.
 * All values below are deliberately fixed demo data, not plan entitlements. */
(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const heights = [23, 37, 29, 48, 66, 84, 45, 32, 48, 69, 58, 40, 77, 89, 59, 46, 63, 81, 96, 71, 52, 68, 86, 54];
  const bars = (values = heights) => '<div class="demo-chart" aria-hidden="true">' + values.map((h, i) => '<i style="--height:' + h + '%;--delay:' + (i * 0.025) + 's;--share:' + (40 + (i * 7 % 25)) + '%"></i>').join('') + '</div>';
  const axis = (start = '12AM', end = '12PM') => '<div class="chart-axis"><span>' + start + '</span><span>' + end + '</span><span>Now</span></div>';
  const legend = () => '<div class="demo-legend"><span>Codex</span><span>Claude</span><span>Other</span></div>';
  const header = (title) => '<div class="demo-head"><strong>' + title + '</strong><span class="demo-tag">Demo</span></div>';
  const quota = (name, used, reset, amber = false) => '<div class="quota"><div class="quota-label"><span>' + name + '</span><small>' + used + '% · ' + reset + '</small></div><div class="quota-track' + (amber ? ' amber' : '') + '"><i style="--fill:' + used + '%"></i></div></div>';
  const heatmap = (count = 119, columns = 17) => '<div class="demo-heatmap" style="grid-template-columns:repeat(' + columns + ',1fr)" aria-hidden="true">' + Array.from({length: count}, (_, i) => '<i style="--level:' + ([0.12, 0.3, 0.5, 0.75, 1][(i * 7 + Math.floor(i / 7)) % 5]) + '"></i>').join('') + '</div>';
  const windowPanel = (title, body) => '<div class="demo-surface wide-panel">' + header(title) + body + '</div>';
  const brand = (name, provider) => {
    const asset = provider === 'anthropic' && name.startsWith('Claude') ? 'claude.png'
      : provider === 'google' && name === 'Gemini' ? 'gemini.svg'
      : provider === 'google' ? 'google.png'
      : provider === 'kimi' ? 'kimi.ico' : provider + '.svg';
    return `<span class="product-brand"><span class="product-mark" data-provider="${provider}"><img src="./assets/brands/${asset}?v=20261001" alt="" onerror="this.parentNode.hidden=true"></span>${name}</span>`;
  };
  const chip = (text, tone = '') => `<span class="detail-chip ${tone}">${text}</span>`;
  const stats = (items) => '<div class="detail-stats">' + items.map(([label, value, note]) => `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('') + '</div>';
  const foot = (left, right) => `<div class="detail-foot"><span>${left}</span><span>${right}</span></div>`;
  const rail = (active) => '<div class="detail-rail"><b>TH<span>Token Horizon</span></b>' + ['Overview', 'Usage', 'Local AI', 'Traces', 'Models'].map((name, i) => `<span class="${name === active ? 'selected' : ''}"><i>${['◈', '▥', '◉', '⌁', '▦'][i]}</i>${name}</span>`).join('') + '<small>LOCAL WORKSPACE<br><strong>Personal Mac</strong></small></div>';
  const appWindow = (active, title, body) => `<div class="demo-surface detail-app">${rail(active)}<div class="detail-main">${header(title)}${body}</div></div>`;
  const scenes = {
    notch: {
      caption: 'A quiet glance at your usage. Right at the notch.',
      label: 'Illustrative notch: 1.84 million tokens, estimated cost $4.82, 284 requests, provider reset windows, CPU 34 percent and memory 61 percent.',
      render: () => `<div class="notch-demo demo-surface detailed-notch">${header('Token Horizon')}<div class="detail-tabs"><b>Tokens</b><span>Activity</span><span>Limits</span><span>Local</span></div><div class="notch-total"><div><span class="demo-label">TOKENS TODAY</span><strong class="demo-total">1.84<span>M</span></strong></div><div class="notch-aside"><strong>$4.82</strong><span>estimated cost</span><small>284 requests</small></div></div>${bars()}${axis()}<div class="notch-providers">${quota(brand('Codex', 'openai'), 42, '4h 08m')}${quota(brand('Claude', 'anthropic'), 64, '2h 14m')}</div><div class="system-footer"><span><i class="system-ring" style="--used:34%"></i>CPU <b>34%</b></span><span><i class="system-ring" style="--used:61%"></i>MEM <b>61%</b></span><span class="local-dot">On-device</span></div></div>`
    },
    widgets: {
      caption: 'Your usage, activity and resets. A widget away.',
      label: 'Illustrative desktop widgets: seven days of provider usage, 8.7 million tokens, activity heatmap, and a Claude quota reset in 2 hours 14 minutes.',
      render: () => `<div class="demo-widget-layout detailed-widgets"><div class="demo-surface">${header('Token Horizon')}<span class="demo-label">THIS WEEK</span><strong class="demo-total">8.7M <small>tokens</small></strong>${bars([40, 68, 58, 76, 52, 94, 71])}${axis('Mon','Thu')}${legend()}${foot('DAILY ACTIVITY', 'Less ▪ ▪ ▪ More')}${heatmap(51,17)}<div class="demo-time-windows"><span>h</span><b>d</b><span>w</span><span>m</span><span>y</span></div></div><div class="demo-surface reset-widget">${brand('Claude','anthropic')}<span class="demo-label">NEXT RESET</span><strong class="demo-total">2h 14m</strong><div class="reset-ring"><strong>64<small>%</small></strong></div><p>5-hour window</p>${chip('36% remaining')}<small class="demo-label">Illustrative quota</small></div></div>`
    },
    dashboard: {
      caption: 'From the daily picture to the project behind every token.',
      label: 'Illustrative usage dashboard: 1.84 million tokens, $4.82 estimated cost, 284 requests, token classes and per-project activity.',
      render: () => appWindow('Usage', 'Usage overview', `<div class="detail-toolbar"><span>Personal workspace</span><b>Today ▾</b></div>${stats([['Tokens','1.84M','Across 3 tools'],['Est. cost','$4.82','Local pricing estimate'],['Requests','284','Today']])}<div class="chart-heading"><b>Usage over time</b><span>Hourly · stacked by tool</span></div>${bars()}${axis()}${legend()}<div class="token-split"><span>Input <b>1.23M</b></span><span>Output <b>610k</b></span><span>Cached input <b>640k</b></span></div><div class="project-row"><span class="project-icon">⌘</span><div><b>token-horizon</b><small>Latest active project</small></div><strong>824k <small>tokens</small></strong><span class="spark-bars">▁▃▂▅▄▆█</span></div>`)
    },
    limits: {
      caption: 'See each provider’s headroom, usage window and next reset.',
      label: 'Illustrative plan limits: Claude 64 percent, Codex 42 percent, Kimi 81 percent, with individual reset windows and remaining capacity.',
      render: () => windowPanel('Plan limits', `<div class="detail-toolbar"><span>Provider-reported windows</span>${chip('Sorted by reset')}</div><div class="limit-detail">${quota(brand('Claude','anthropic'),64,'resets in 2h 14m')}${foot('5-hour window', '36% remaining')}</div><div class="limit-detail">${quota(brand('Codex','openai'),42,'resets in 4h 08m')}${foot('5-hour window', '58% remaining')}</div><div class="limit-detail">${quota(brand('Kimi','kimi'),81,'resets in 1d 6h',true)}${foot('Weekly window', '19% remaining')}</div><div class="detail-notice"><span>◷</span><p>Different providers. Different clocks.<br><strong>All your reset windows, one view.</strong></p></div>`)
    },
    local: {
      caption: 'See the runner, measured throughput and pressure on your Mac.',
      label: 'Illustrative local AI monitor: Ollama running Qwen, 42 tokens per second, 8.4 gigabytes memory, CPU 34 percent and memory 61 percent.',
      render: () => appWindow('Local AI', 'Local inference', `<div class="runner-title">${brand('Ollama','ollama')}${chip('Running','positive')}</div><div class="runner-model"><strong>Qwen</strong><span>Local model · this Mac</span></div>${stats([['Generation','42.0','measured tok/s'],['Memory','8.4 GB','runner footprint']])}<div class="chart-heading"><b>Generation throughput</b><span>Last 60 seconds</span></div><div class="throughput-chart"><svg viewBox="0 0 400 65" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="M0 60L0 45 20 42 35 49 50 34 70 38 90 20 110 26 130 16 150 24 170 18 190 26 210 12 230 18 250 14 270 21 290 10 310 15 330 12 350 18 370 11 400 14V65H0Z"/><path class="line" d="M0 45 20 42 35 49 50 34 70 38 90 20 110 26 130 16 150 24 170 18 190 26 210 12 230 18 250 14 270 21 290 10 310 15 330 12 350 18 370 11 400 14"/></svg></div>${axis('−60s','−30s')}<div class="machine-meters">${quota('CPU',34,'host')}${quota('Memory',61,'host')}</div>${foot('MLX + Ollama observability', 'Measured, never inferred')}`)
    },
    traces: {
      caption: 'Follow the request from first token to tool calls and completion.',
      label: 'Illustrative gateway trace: POST /v1/responses, 200 OK, first token 240 milliseconds, total duration 2.8 seconds, 428 output tokens, read_file and edit_file tool calls.',
      render: () => appWindow('Traces', 'Request detail', `<div class="detail-toolbar">${chip('200 OK','positive')}<span>POST /v1/responses</span><span class="trace-id">req_demo_0284</span></div>${stats([['First token','240','ms'],['Duration','2.8','seconds'],['Output','428','tokens']])}<div class="chart-heading"><b>Request timeline</b><span>0 → 2.8s</span></div><div class="trace-waterfall"><div><span>First token</span><i style="--offset:0%;--length:9%"></i><b>240ms</b></div><div><span>Generation</span><i style="--offset:9%;--length:91%"></i><b>2.56s</b></div><div><span>Tool events</span><i class="tool-span" style="--offset:32%;--length:25%"></i><b>2 calls</b></div></div><div class="tool-events"><span>01 <b>read_file</b><small>Sources/App.swift</small></span><span>02 <b>edit_file</b><small>Patch applied</small></span></div>${foot('Usage: provider-reported', 'Stored on this Mac')}`)
    },
    models: {
      caption: 'Compare capabilities and listings, then inspect a model in detail.',
      label: 'Illustrative catalog with Claude, GPT, Gemini and Qwen model families, capability badges, and an expanded Qwen local runtime preview.',
      render: () => windowPanel('Model explorer', `<div class="model-search"><span>⌕</span> Search models, providers, capabilities…<kbd>⌘ K</kbd></div><div class="model-filters">${chip('All models','positive')}${chip('Cloud')}${chip('Local')}${chip('Tools')}</div><div class="model-inspector"><div class="model-list">${[['Claude Sonnet','anthropic','Reasoning · tools'],['GPT','openai','Vision · tools'],['Gemini','google','Vision · tools'],['Qwen','qwen','Open weights · local']].map(([name,provider,detail])=>`<div class="model-preview-row ${provider==='qwen'?'selected':''}">${brand(name,provider)}<small>${detail}</small></div>`).join('')}</div><div class="model-detail">${brand('Qwen','qwen')}<span class="demo-label">LOCAL RUNTIME PREVIEW</span><div class="detail-chips">${chip('Open weights')}${chip('Ollama')}</div><dl><div><dt>Generation</dt><dd>42.0 tok/s</dd></div><div><dt>Memory</dt><dd>8.4 GB</dd></div><div><dt>Usage source</dt><dd>Measured</dd></div></dl><span class="model-detail-link">Model details ↗</span></div></div>${foot('Explore · Listings · Plans', 'Illustrative model families')}`)
    }
  };

  // Pause on explicit interaction, reduced motion, hidden tabs and offscreen.
  const keys = Object.keys(scenes);
  let current = 0;
  let playing = !motion.matches;
  let visible = true;
  let timer = null;
  const screen = $('#tour-screen');
  const device = $('.device');
  const play = $('#tour-play');
  const description = $('#tour-description');
  const detailDialog = $('#demo-dialog');
  const detailScreen = $('#detail-screen');
  function renderDetail() {
    const scene = scenes[keys[current]];
    detailScreen.innerHTML = scene.render();
    detailScreen.setAttribute('aria-label', scene.label);
    detailScreen.dataset.scene = keys[current];
    detailScreen.parentElement.scrollLeft = 0;
    $('#detail-description').textContent = scene.caption;
    $('#detail-counter').textContent = String(current + 1).padStart(2, '0') + ' / 07';
  }
  function syncPlayback() {
    clearTimeout(timer);
    timer = null;
    const running = playing && visible && !document.hidden && !motion.matches;
    if (!running) screen.getAnimations().forEach(animation => animation.cancel());
    device.dataset.playing = String(running);
    play.textContent = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', playing ? 'Pause product tour' : 'Play product tour');
    if (motion.matches) {
      play.textContent = 'Next';
      play.setAttribute('aria-label', 'Show next feature without animation');
    }
    if (running) timer = setTimeout(() => showScene((current + 1) % keys.length), 6500);
  }
  function showScene(index, manual = false) {
    current = index;
    const key = keys[current];
    const scene = scenes[key];
    if (manual) playing = false;
    screen.innerHTML = scene.render();
    screen.setAttribute('aria-label', scene.label);
    screen.dataset.scene = key;
    // Replacing children restarts their entry animations; animate the parent
    // with the Web Animations API only while the tour is actually playing.
    screen.getAnimations().forEach(animation => animation.cancel());
    if (playing && !motion.matches && visible && !document.hidden) {
      screen.animate([{opacity: 0, transform: 'translateY(8px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: 500, easing: 'cubic-bezier(.16,1,.3,1)'});
    }
    description.textContent = scene.caption;
    $('#tour-feature').value = key;
    $$('[data-scene]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scene === key)));
    if (detailDialog.open) renderDetail();
    syncPlayback();
  }
  $$('[data-scene]').forEach(button => button.addEventListener('click', () => showScene(keys.indexOf(button.dataset.scene), true)));
  $('#tour-feature').addEventListener('change', event => showScene(keys.indexOf(event.target.value), true));
  $('.tour-feature-picker').hidden = false;
  play.hidden = false;
  play.addEventListener('click', () => {
    if (motion.matches) return showScene((current + 1) % keys.length, true);
    playing = !playing;
    syncPlayback();
  });
  document.addEventListener('visibilitychange', syncPlayback);
  motion.addEventListener('change', () => { playing = false; screen.getAnimations().forEach(animation => animation.cancel()); syncPlayback(); });
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncPlayback(); }, {threshold: 0.15}).observe($('.product-tour'));
  showScene(0);
  $('#expand-demo').hidden = false;
  $('#expand-demo').addEventListener('click', () => {
    playing = false;
    syncPlayback();
    renderDetail();
    detailDialog.showModal();
    document.body.classList.add('demo-open');
  });
  $('#close-demo').addEventListener('click', () => detailDialog.close());
  detailDialog.addEventListener('close', () => {
    document.body.classList.remove('demo-open');
    $('#expand-demo').focus();
  });
  $('#previous-demo').addEventListener('click', () => showScene((current + keys.length - 1) % keys.length, true));
  $('#next-demo').addEventListener('click', () => showScene((current + 1) % keys.length, true));

  $$('[data-bars]').forEach(host => {
    host.innerHTML = host.dataset.bars.split(',').map(height => '<i style="--height:' + Number(height) + '%"></i>').join('');
  });

  // A working web preview of the app-owned widget controls. Never deep-link
  // to or modify the installed app from a marketing-page demonstration.
  let widgetPage = 'usage';
  let widgetWindow = 'hours';
  const windows = {
    hours: {title: 'Tokens today', total: '1.84M', count: 24, from: '12AM', to: '12PM', cells: 24, columns: 12},
    days: {title: 'Last 7 days', total: '8.7M', count: 7, from: 'Mon', to: 'Thu', cells: 7, columns: 7},
    weeks: {title: 'Last 17 weeks', total: '142M', count: 17, from: 'Week 1', to: 'Week 9', cells: 119, columns: 17},
    months: {title: 'Last 30 days', total: '36.2M', count: 30, from: 'Day 1', to: 'Day 15', cells: 30, columns: 10},
    years: {title: 'Last 12 months', total: '426M', count: 12, from: 'Oct', to: 'Apr', cells: 12, columns: 6}
  };
  function renderWidget() {
    const w = windows[widgetWindow];
    const title = '<span class="demo-label">' + w.title + '</span><strong class="demo-total">' + w.total + ' <small>tokens</small></strong>';
    let body = '';
    if (widgetPage === 'usage') body = title + bars(Array.from({length: w.count}, (_, i) => heights[(i * 5) % heights.length])) + axis(w.from, w.to) + legend() + '<div class="widget-breakdown"><span>Input <b>67%</b></span><span>Output <b>33%</b></span></div>';
    else if (widgetPage === 'heatmap') body = '<span class="demo-label">Activity · ' + w.title.toLowerCase() + '</span><strong class="demo-total">' + w.total + '</strong>' + heatmap(w.cells, w.columns) + '<div class="heatmap-legend"><span>Activity intensity</span><span>Less <i></i><i></i><i></i> More</span></div>';
    else body = '<span class="demo-label">Provider reset windows</span>' + quota('Claude', 64, '2h 14m') + quota('Codex', 42, '4h 08m') + quota('Kimi', 81, '1d 6h', true) + '<p class="widget-summary">Sorted by reset time. Quotas have their own provider windows.</p>';
    $('#widget-content').innerHTML = body;
    $$('[data-widget-page]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.widgetPage === widgetPage)));
    $$('[data-window]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.window === widgetWindow)); button.disabled = widgetPage === 'limits'; });
  }
  $$('[data-widget-page]').forEach(button => button.addEventListener('click', () => { widgetPage = button.dataset.widgetPage; renderWidget(); }));
  $$('[data-window]').forEach(button => button.addEventListener('click', () => { widgetWindow = button.dataset.window; renderWidget(); }));
  renderWidget();

  const menu = $('.menu-toggle');
  const nav = $('#main-nav');
  function closeMenu() {
    nav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false');
    window.TokenHorizonExploreNav?.close({ immediate: true });
  }
  menu.addEventListener('click', () => { const open = nav.classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); });
  nav.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && nav.classList.contains('open')) { closeMenu(); menu.focus(); }
  });
  document.addEventListener('click', event => {
    if (nav.classList.contains('open') && !menu.closest('header').contains(event.target)) {
      const restore = nav.contains(document.activeElement);
      closeMenu(); if (restore) menu.focus();
    }
  });
  matchMedia('(max-width: 1200px)').addEventListener('change', () => closeMenu());

  $$('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    // innerText preserves the explicit line break between Homebrew commands.
    const command = code.innerText.trim();
    const status = $('#copy-status');
    try {
      await navigator.clipboard.writeText(command);
      status.textContent = 'Copied. Paste the command into Terminal to install.';
      button.querySelector('span').textContent = 'Copied';
      setTimeout(() => { button.querySelector('span').textContent = 'Copy'; }, 2000);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Clipboard unavailable. The command is selected so you can copy it manually.';
    }
  }));
})();
