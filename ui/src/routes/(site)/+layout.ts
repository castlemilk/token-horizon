// Marketing pages are real HTML: server-render + prerender them (the rest of
// the app is a pure SPA with ssr = false, set in the root layout). This
// gives the landing and policy pages static, no-JS-readable output and real
// <title>/meta for crawlers.
export const ssr = true;
export const prerender = true;
