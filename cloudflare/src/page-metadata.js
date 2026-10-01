// Public page metadata is deliberately independent of usage storage and the
// model catalog, so an unfurl never delays the first document response.
export const SITE_ORIGIN = 'https://token-horizon.dev';
export const BRAND_ASSET_VERSION = '20261001-2';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const asset = name => `${SITE_ORIGIN}/assets/${name}?v=${BRAND_ASSET_VERSION}`;
export const PRIVATE_ROBOTS = 'noindex, nofollow, noarchive';

export function brandIconTags() {
  return `<link rel="icon" href="/favicon.ico?v=${BRAND_ASSET_VERSION}" sizes="16x16 32x32 48x48 64x64">
<link rel="icon" href="/favicon-32x32.png?v=${BRAND_ASSET_VERSION}" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-48x48.png?v=${BRAND_ASSET_VERSION}" type="image/png" sizes="48x48">
<link rel="icon" href="/assets/favicon.svg?v=${BRAND_ASSET_VERSION}" type="image/svg+xml" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${BRAND_ASSET_VERSION}" sizes="180x180">
<link rel="mask-icon" href="/assets/safari-pinned-tab.svg?v=${BRAND_ASSET_VERSION}" color="#235e43">
<link rel="manifest" href="/site.webmanifest?v=${BRAND_ASSET_VERSION}">`;
}

export function routePageMetadata(url) {
  const p = url.searchParams;
  const queryView = p.get('view');
  const sensitiveView = ['dashboard', 'workspace', 'billing', 'settings', 'login', 'shared', 'invite'].includes(queryView);
  const view = url.pathname === '/login' ? 'login' : sensitiveView ? queryView : url.pathname === '/models' ? 'models' : queryView || 'leaderboard';
  const metadata = {
    type: 'website', schemaType: 'CollectionPage',
    title: 'AI Usage Leaderboard · Token Horizon',
    description: 'Explore community AI token usage, provider breakdowns, league rankings and builder profiles on Token Horizon.',
    url: `${SITE_ORIGIN}/leaderboard`, image: asset('og-leaderboard.png'),
    alt: 'Token Horizon community leaderboard, league shields and provider activity.'
  };
  if (p.has('share') || view === 'shared') return { ...metadata, private: true, schemaType: null,
    title: 'Shared usage report · Token Horizon', description: 'A Token Horizon usage report shared through an individual link.',
    url: `${SITE_ORIGIN}/leaderboard?view=shared`, image: asset('og-workspace.png'), alt: 'Token Horizon shared usage report.' };
  if (p.has('invite') || view === 'invite' || /^\/invite\//.test(url.pathname)) return { ...metadata, private: true, schemaType: null,
    title: 'Join your crew · Token Horizon', description: 'Sign in to join your friends’ team and explore your AI usage together.',
    url: `${SITE_ORIGIN}/leaderboard?view=teams`, image: asset('og-leaderboard.png'), alt: 'Join your friends on Token Horizon.' };
  if (view === 'login' || p.has('signin')) return { ...metadata, noindex: true, schemaType: null,
    title: 'Sign in · Token Horizon', description: 'Sign in with Google or GitHub to access your Token Horizon workspace, team and sharing controls.',
    url: `${SITE_ORIGIN}/login`, image: asset('og-login.png'), alt: 'Sign in to your Token Horizon account.' };
  if (['dashboard', 'workspace', 'billing', 'settings'].includes(view)) {
    const title = { dashboard: 'Your workspace', workspace: 'Your workspace', billing: 'Usage and costs', settings: 'Account settings' }[view];
    return { ...metadata, private: true, schemaType: null, title: `${title} · Token Horizon`,
      description: 'Your Token Horizon account, published AI usage, team and sharing controls. Sign in to view your workspace.',
      url: `${SITE_ORIGIN}/leaderboard?view=${view === 'workspace' ? 'dashboard' : view}`,
      image: asset('og-workspace.png'), alt: 'Your Token Horizon workspace.' };
  }
  if (view === 'models') {
    const tab = ['providers', 'plans', 'cheapest'].includes(p.get('tab')) ? p.get('tab') : '';
    const titles = { providers: 'AI Model Providers', plans: 'AI Subscription Plans', cheapest: 'Compare AI Model Prices' };
    const descriptions = {
      providers: 'Compare AI model providers, community adoption and published usage across the Token Horizon model catalog.',
      plans: 'Explore AI subscription plans and the models they cover alongside the Token Horizon model catalog.',
      cheapest: 'Compare model listings across providers, explore price differences and find lower-cost options in the Token Horizon catalog.'
    };
    return { ...metadata, title: `${titles[tab] || 'AI Model Explorer'} · Token Horizon`,
      description: descriptions[tab] || 'Explore AI models, compare providers, published prices, context windows and benchmarks in one searchable catalog.',
      url: `${SITE_ORIGIN}/models${tab ? `?tab=${tab}` : ''}`, image: asset('og-models.png'),
      alt: 'Token Horizon model explorer with provider filters, model listings, prices and plans.' };
  }
  if (view === 'teams') return { ...metadata, title: 'AI Usage Teams · Token Horizon',
    description: 'Explore team AI usage and community rankings. Invite friends to your Token Horizon crew.',
    url: `${SITE_ORIGIN}/leaderboard?view=teams` };
  if (view === 'leagues') return { ...metadata, title: 'AI Usage Leagues · Token Horizon',
    description: 'Explore the seven Token Horizon leagues, learn how rankings work and follow the community’s progress.',
    url: `${SITE_ORIGIN}/leaderboard?view=leagues` };
  return metadata;
}

export function pageMetadataTags(meta) {
  const noindex = Boolean(meta.noindex || meta.private);
  const tags = [
    `<title>${esc(meta.title)}</title>`,
    `<meta data-th-seo name="description" content="${esc(meta.description)}">`,
    '<meta data-th-seo name="theme-color" content="#101714">',
    '<meta data-th-seo name="referrer" content="no-referrer">',
    `<meta data-th-seo name="robots" content="${noindex ? PRIVATE_ROBOTS : 'index, follow, max-image-preview:large'}">`,
    `<link data-th-seo rel="canonical" href="${esc(meta.url)}">`,
    `<meta data-th-seo property="og:type" content="${esc(meta.type || 'website')}">`,
    '<meta data-th-seo property="og:site_name" content="Token Horizon">',
    '<meta data-th-seo property="og:locale" content="en_US">',
    `<meta data-th-seo property="og:title" content="${esc(meta.title)}">`,
    `<meta data-th-seo property="og:description" content="${esc(meta.description)}">`,
    `<meta data-th-seo property="og:url" content="${esc(meta.url)}">`
  ];
  if (meta.image) tags.push(
    `<meta data-th-seo property="og:image" content="${esc(meta.image)}">`,
    `<meta data-th-seo property="og:image:secure_url" content="${esc(meta.image)}">`,
    '<meta data-th-seo property="og:image:type" content="image/png">',
    '<meta data-th-seo property="og:image:width" content="1200">',
    '<meta data-th-seo property="og:image:height" content="630">',
    `<meta data-th-seo property="og:image:alt" content="${esc(meta.alt || meta.description)}">`,
    '<meta data-th-seo name="twitter:card" content="summary_large_image">',
    `<meta data-th-seo name="twitter:image" content="${esc(meta.image)}">`,
    `<meta data-th-seo name="twitter:image:alt" content="${esc(meta.alt || meta.description)}">`,
    '<meta data-th-seo name="twitter:image:width" content="1200">',
    '<meta data-th-seo name="twitter:image:height" content="630">'
  );
  tags.push(`<meta data-th-seo name="twitter:title" content="${esc(meta.title)}">`,
    `<meta data-th-seo name="twitter:description" content="${esc(meta.description)}">`);
  if (!noindex && meta.schemaType) {
    const schema = { '@context': 'https://schema.org', '@type': meta.schemaType,
      '@id': `${meta.url}${meta.url.includes('#') ? '' : '#page'}`, url: meta.url, name: meta.title,
      description: meta.description, isPartOf: { '@id': `${SITE_ORIGIN}/#website` },
      publisher: { '@id': `${SITE_ORIGIN}/#organization` },
      ...(meta.image ? { primaryImageOfPage: { '@type': 'ImageObject', url: meta.image, width: 1200, height: 630 } } : {}),
      ...(meta.profileHandle ? { mainEntity: { '@type': 'Person', name: `@${meta.profileHandle}`, identifier: meta.profileHandle, url: meta.url } } : {}) };
    tags.push(`<script id="th-seo-schema" type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`);
  }
  return tags.join('\n');
}

export function injectPageMetadata(html, meta) {
  // Operate on the document head only: scripts and profile content are left
  // untouched, and the charset remains early in the document for decoding.
  return html.replace(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i, (_, head) => {
    const clean = head.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
      .replace(/<meta\s+[^>]*(?:property=["']og:[^"']+["']|name=["'](?:twitter:[^"']+|description|robots|googlebot|referrer|theme-color)["'])[^>]*>/gi, '')
      .replace(/<link\s+[^>]*rel=["']canonical["'][^>]*>/gi, '')
      .replace(/<script\b(?=[^>]*\bid=["']th-seo-schema["'])[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<base\s+[^>]*>/gi, '');
    return `<head><base href="/">${clean}\n${pageMetadataTags(meta)}\n</head>`;
  });
}
