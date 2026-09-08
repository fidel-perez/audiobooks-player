/**
 * The face list, and the ORDER POLICY over it. One definition, two consumers.
 *
 * This used to live inside `secureFace.js`, where it was private to the
 * document-hop decision. It moved out the moment `transport.js` needed the same
 * list for a different decision (which face an /api call travels to), because
 * two copies of a preference order is two things to get out of step — and the
 * order here is not cosmetic, it is which of three networks the device is
 * assumed to prefer.
 *
 * See `secureFace.js`'s header for what each face IS and why all three exist.
 * What lives here is only the derivation and the bar a host has to clear.
 */

/** Every secure face we could send this browser to, best first.
 *
 * A DOTTED NAME IS THE BAR. `TS_HOST` falls back to the bare name `raspberrypi`
 * on a fresh `docker compose up` with no ansible-rendered .env, and `DEDYN_HOST`
 * is simply empty there. A bare or empty name has no valid certificate, so https
 * to it is a hard interstitial — worse than the insecure page we are on. Anything
 * that fails that bar is dropped from the list rather than probed.
 *
 * ORDER IS THE POLICY: the two LAN https faces first because they need no VPN
 * (wired before backup wifi — the wired one is the canonical origin and the
 * normal-operation face), tailnet last because it is the only one that works
 * away from home.
 *
 * @param {{lan?: string, ts?: string, tsPort?: string, lanHttps?: string,
 *          lanWifiHttps?: string}} hosts  Usually `window.__PI_HOSTS__`.
 * @returns {string[]} Origins (scheme + host + port), most-preferred first.
 */
export function secureOriginsFrom(hosts) {
  const h = hosts || {};
  const dotted = (name) => !!name && String(name).includes(".");
  const origins = [];
  if (dotted(h.lanHttps)) {
    // No port: the secure LAN face is Caddy's own :443 with a real cert.
    origins.push(`https://${h.lanHttps}`);
  }
  if (dotted(h.lanWifiHttps)) {
    // Same shape as lanHttps — Caddy :443 on the wlan0 bind, its own real cert.
    origins.push(`https://${h.lanWifiHttps}`);
  }
  if (dotted(h.ts)) {
    // The port is NOT optional: portless .ts.net is the webhook Funnel and 502s
    // every app path. See secureFace.js, "NOT https://<host>.ts.net WITHOUT THE
    // PORT".
    origins.push(`https://${h.ts}:${h.tsPort || "10000"}`);
  }
  return origins;
}
