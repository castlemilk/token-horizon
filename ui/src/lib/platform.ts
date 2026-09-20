// Shell identity.
//
// The same SvelteKit app ships two shells:
//   - Tauri desktop shell (window.__TAURI__ present)
//   - web app (plain browser)
//
// Both expose every route — the Tauri webview has no URL bar, so there is
// nothing to constrain at the route level. Routes are grouped by data
// concern under src/routes:
//   (local)/   daemon-backed pages reading the loopback API (:8765)
//              → /  /metering  /limits  /settings
//   (cloud)/   cloud-backed public pages reading the cloud server
//              → /leaderboard  /@[handle]

export const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
