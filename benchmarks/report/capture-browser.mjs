/**
 * The browser settings for the capture step. They are kept here, not in capture.mjs, so the isolation
 * test (report/capture-isolation-test.mjs) launches exactly the browser the capture launches.
 *
 * Model-written HTML runs in this browser, so the browser itself must be unable to reach the network:
 *   - every HTTP(S) and WebSocket connection goes to a proxy that is not listening (127.0.0.1 port 9), and
 *     the proxy bypass list is "<-loopback>", so loopback is not exempt either. Nothing can be reached.
 *   - WebRTC may not send UDP outside the proxy ("disable_non_proxied_udp"). The proxy carries no UDP, so
 *     no STUN or media packet leaves the machine.
 *   - Chromium's own sandbox stays on, and so does web security: the switches that turn either off are not used.
 * The capture also aborts every request at the route level. That is a second layer, not the first.
 *
 * The isolation test checks the first layer alone, with no route, and checks that a plain browser fails
 * the same test (a negative control), so a regression in these settings cannot pass silently.
 */

/** A proxy address nothing listens on. Every connection the browser makes through it is refused. */
export const DEAD_PROXY_SERVER = 'http://127.0.0.1:9'

/** Command-line switches. Nothing here weakens Chromium's sandbox or its web security. */
export const CAPTURE_BROWSER_ARGS = Object.freeze([
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
])

/** Launch options for chromium.launch(). */
export function captureLaunchOptions() {
  return {
    headless: true,
    chromiumSandbox: true,
    args: [...CAPTURE_BROWSER_ARGS],
    proxy: { server: DEAD_PROXY_SERVER, bypass: '<-loopback>' }
  }
}

/** Options for browser.newContext(): the same proxy as the launch, so the context cannot reach past it. */
export function captureContextOptions(viewport) {
  return {
    viewport,
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    acceptDownloads: false,
    proxy: { server: DEAD_PROXY_SERVER, bypass: '<-loopback>' }
  }
}
