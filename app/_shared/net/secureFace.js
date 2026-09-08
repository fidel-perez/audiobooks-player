/**
 * Face preference: get the app onto an origin where offline mode can EXIST.
 *
 * THE BUG THIS CLOSES. todoapp and macrotrackingapp ship a full offline stack —
 * a service worker with a precached shell (`sw.js` `navigationFirst`), the
 * connectivity state in `connectivity.js`, the write guard, the offline frame —
 * and on the face they are actually opened on, NONE of it runs. Caddy only
 * force-marches /main/audiobooks onto the https tailnet face; every other page
 * deliberately stays on whatever face the client opened, which at home is
 * `http://<lan-ip>` or `http://raspberrypi`. Those are not
 * *potentially-trustworthy* origins, so the browser never exposes
 * `navigator.serviceWorker` at all: `"serviceWorker" in navigator` is false, the
 * registration block never executes, and there is no cached shell. When Vivaldi
 * (or Android) discards the tab and re-navigates it, the app can only come back
 * over the network. Offline, that is the browser's error page — the whole app,
 * gone, mid-use. No amount of app-level "offline mode" can fix that: without a
 * service worker there is no document to load offline, full stop.
 *
 * So the fix is not more offline code, it is being on the right origin. On an
 * insecure face we ask ONE question per candidate — is this secure face
 * answering right now? — and move to the first that is, before the user does any
 * work. The secure face registers a worker, precaches the shell, and from then
 * on survives every discard, offline or not.
 *
 * THREE SECURE FACES, IN PREFERENCE ORDER. There used to be only one, and this
 * comment used to say that serving https over the LAN had been REJECTED (no
 * local DNS on the Movistar router, a pi-side resolver declined). That is no
 * longer true and the conclusion drawn from it is dead:
 *
 *   1. `lanHttps` — https://<deSEC name>. A publicly-resolvable hostname whose
 *      A record points at the Pi's PRIVATE LAN address, certified by a real
 *      Let's Encrypt cert obtained over ACME DNS-01 (Caddyfile section 2b). No
 *      router config, no local resolver, and crucially NO VPN. This is strictly
 *      better than the tailnet for anyone at home, which is why it goes first.
 *   2. `lanWifiHttps` — the same trick on the Pi's OTHER interface: a sibling
 *      deSEC subname whose A record points at the static wlan0 address on the
 *      backup AP (Caddyfile section 2c). The Pi is dual-homed, and face 1 is
 *      dead for a client on the backup wifi — its A record is on a subnet that
 *      client has no route to. Also no VPN, hence second and not last.
 *   3. `ts` — https://<host>.ts.net:<tsPort>, the `tailscale serve` face. Still
 *      required, and not a legacy path: the two LAN names resolve everywhere but
 *      are only REACHABLE from inside their own subnet (their A records are
 *      RFC1918), so away from home the tailnet is the only secure face there is.
 *
 * NOT `https://<host>.ts.net` WITHOUT THE PORT. That origin exists and answers —
 * with a 502 on every path — because :443 on the tailnet address is the public
 * webhook Funnel (Caddyfile section 1), which aborts everything but three
 * webhook paths. A page stranded there loads from its service-worker cache and
 * then fails every `/api/` call against a real HTTP response, which is why the
 * tailnet face must always be built with `tsPort`.
 *
 * The probe therefore still earns its keep, and this is still a client-side hop
 * rather than a Caddy 302: the server cannot know whether this client is on the
 * wired LAN, on the backup wifi, on the tailnet, or on none of them. Where NONE
 * answers we STAY where we are — a degraded page beats a dead one.
 *
 * BEING SECURE IS NOT BEING REACHABLE. This used to return early the moment the
 * current origin was the preferred face, on the assumption that a page can only
 * be loaded from an origin that answers. A service worker breaks that: the shell
 * is served from cache, so the app opens perfectly on a face whose host is on a
 * subnet the device left. That is exactly the backup-wifi case — the app came up
 * on the wired deSEC name and could never leave it, while every `/api/` write
 * failed. So the current face is probed like any other, and losing that probe is
 * grounds to hop.
 *
 * The origins are NOT hardcoded (group_vars forbids baking tailnet names into
 * code). They come from
 * `window.__PI_HOSTS__ = {lan, ts, tsPort, lanHttps, lanWifiHttps}`, injected
 * into every page by the static_server entrypoint's nginx sub_filter — the same
 * global mini-hub.js reads for its dock face switch, guarded by
 * `raspberry_pi/tests/test_pi_services_conventions.py`.
 *
 * ESCAPE HATCH. `?lan=1` pins this browser to the insecure face for good
 * (persisted, cleared by `?lan=0`), mirroring the `ab_face=lan` cookie the
 * Caddyfile honours for audiobooks. That is for a machine that cannot reach the
 * tailnet at all, where the probe would just cost a timeout on every load.
 *
 * Pure module: every browser touchpoint is injectable, so it is testable under
 * the Node shim in `tests/_shim.js`.
 */

import { createOfflineChrome } from "./offlineChrome.js";
import { secureOriginsFrom } from "./faces.js";

const DEFAULTS = {
  // Long enough for a warming tailnet tunnel to answer, short enough that an
  // off-VPN load is not visibly held up. Nothing waits on this to paint — the
  // page has already booted; a hop, if it happens, replaces it.
  timeoutMs: 2500,
  storageKey: "pi:face",
};

function noop() {}

// The face list and its order policy live in `faces.js` — `transport.js` needs
// the same list to route /api calls, and one preference order cannot be allowed
// to exist in two places.

/**
 * @param {object} [config]
 * @param {() => object} [config.hosts]      Reads `window.__PI_HOSTS__`.
 * @param {() => string} [config.href]       Current document URL.
 * @param {() => boolean} [config.isSecure]  `window.isSecureContext`.
 * @param {(url: string) => void} [config.navigate]  Performs the hop (location.replace).
 * @param {object} [config.storage]          localStorage-alike for the pin.
 * @param {number} [config.timeoutMs]
 * @param {(reason: string, secureUrl: string) => void} [config.onStay]
 *        Called when we are staying on the insecure face — i.e. this session has
 *        NO offline mode. `reason` is "pinned" or "unreachable"; `secureUrl` is
 *        where the user could go by hand (empty when unknown).
 */
export function createSecureFace(config = {}) {
  const cfg = {
    hosts: config.hosts || (() => (typeof window === "undefined" ? {} : window.__PI_HOSTS__ || {})),
    href: config.href || (() => (typeof location === "undefined" ? "" : location.href)),
    isSecure:
      config.isSecure ||
      (() => typeof window !== "undefined" && window.isSecureContext === true),
    navigate:
      config.navigate ||
      ((url) => {
        // replace(), not assign(): the insecure URL must not stay in history, or
        // Back walks straight into the face with no service worker.
        location.replace(url);
      }),
    storage:
      config.storage ||
      (typeof localStorage === "undefined" ? null : localStorage),
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    onStay: config.onStay || noop,
  };

  function readPin() {
    try {
      return cfg.storage && cfg.storage.getItem(DEFAULTS.storageKey) === "lan";
    } catch (_e) {
      return false;
    }
  }

  function writePin(pinned) {
    try {
      if (!cfg.storage) {
        return;
      }
      if (pinned) {
        cfg.storage.setItem(DEFAULTS.storageKey, "lan");
      } else {
        cfg.storage.removeItem(DEFAULTS.storageKey);
      }
    } catch (_e) {
      // Blocked storage → no pin to keep. The probe still decides each load.
    }
  }

  /**
   * Is the secure face answering? A cross-origin HEAD in `no-cors` mode: the
   * response is opaque and we cannot read a status from it, which is fine —
   * "it resolved at all" is exactly the question. A rejection or a timeout means
   * that face is not up for us right now.
   *
   * HEAD IS LOAD-BEARING, not just cheap. All three app service workers bail out
   * of their fetch handler on `method !== "GET"`, so a HEAD probe can never be
   * answered from the SW's own cache. A GET probe COULD be — `networkFirst`
   * falls back to a cached response when the network throws — and a probe that
   * reports "reachable" from cache would hop the app onto a face that is in fact
   * dead. Do not turn this into a GET.
   */
  async function reachable(url) {
    const ctl =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), cfg.timeoutMs) : null;
    try {
      await fetch(url, {
        method: "HEAD",
        mode: "no-cors",
        cache: "no-store",
        signal: ctl ? ctl.signal : undefined,
      });
      return true;
    } catch (_e) {
      return false;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Which face should this client be on? Probes every candidate IN PARALLEL and
   * returns the EARLIEST-LISTED one that answers ("" if none does), so list
   * order stays preference while the wall-clock cost is one timeout instead of
   * the sum of them. That matters now that there are three: probed in sequence,
   * a client away from home would sit through both LAN timeouts before the
   * tailnet — the only face it can use — was even tried. (Same race the ssh
   * wrappers in bin/lib/remote_login.sh run over their own face list.)
   *
   * All probes are fired before anything is awaited; awaiting them in order only
   * decides the winner, it does not serialize the requests.
   */
  async function firstReachable(origins, pathname) {
    const probes = origins.map((origin) => reachable(`${origin}${pathname}`));
    for (let i = 0; i < origins.length; i++) {
      if (await probes[i]) {
        return origins[i];
      }
    }
    return "";
  }

  /**
   * Decide, and act. Resolves with what happened:
   *   "secure"      — on a trustworthy origin that is answering (or on an
   *                   unknown-but-secure one, or offline with nowhere better);
   *                   nothing to do.
   *   "pinned"      — `?lan=1`; staying insecure by explicit request.
   *   "unknown"     — no usable secure host injected; nothing to hop to.
   *   "redirected"  — the hop is committed; this document is on its way out.
   *   "unreachable" — no secure face answered; staying put, no offline mode.
   *
   * SECURE → SECURE IS A RESCUE, NOT A PREFERENCE. This used to hop between two
   * live secure faces whenever a MORE-PREFERRED one answered, on the reasoning
   * that the apps' /api sync was a same-origin relative path — so the face the
   * document sat on was also the face the sync travelled over, and being on the
   * VPN-only face at home was worth a hop DOWN to the LAN one.
   *
   * `_shared/net/transport.js` retired that reasoning: /api is now routed per
   * REQUEST, so the sync already goes to the best face that answers no matter
   * where the document sits. What the hop still cost was the whole point of
   * having it — origin is the browser's storage identity, so every preference
   * hop dropped the app into a fresh, EMPTY IndexedDB/localStorage/PWA install.
   * That is the "it lost my progress" report. A hop for preference now buys
   * nothing and still costs that, so it is gone.
   *
   * What remains is the rescue, and it is genuinely load-bearing. The service
   * worker serves the shell from cache, so the app opens perfectly on a face
   * whose host the device can no longer route to — the wired deSEC name from the
   * sofa, once the phone is on the backup wifi. A document stranded on a dead
   * origin cannot be re-fetched at all on the next cold load, cache miss or
   * update, so when the CURRENT face does not answer and another one does, we
   * still move. The rule is therefore: hop only to escape a dead face, never to
   * reach a better one.
   *
   * If nothing at all answers we stay put and report "secure": the device is
   * offline, the cached shell is the best thing available, and hopping to
   * another unreachable name would only trade one dead origin for another. On an
   * unknown secure origin (localhost, a test) there is nothing to compare
   * against and no probe is paid.
   */
  async function check() {
    const here = new URL(cfg.href(), "http://invalid.local");
    const origins = secureOriginsFrom(cfg.hosts());
    const targetFor = (origin) =>
      `${origin}${here.pathname}${here.search}${here.hash}`;

    if (cfg.isSecure()) {
      const currentOrigin = `${here.protocol}//${here.host}`;
      if (!origins.includes(currentOrigin)) {
        return "secure";
      }
      // The current face is probed FIRST and on its own: if it answers we are
      // staying, and the other faces are none of our business. This is also
      // what makes the common case cheap — one request, not a three-way race.
      if (await reachable(`${currentOrigin}${here.pathname}`)) {
        return "secure";
      }
      const rescue = await firstReachable(
        origins.filter((o) => o !== currentOrigin),
        here.pathname
      );
      if (!rescue) {
        return "secure";
      }
      cfg.navigate(targetFor(rescue));
      return "redirected";
    }

    const lanParam = here.searchParams.get("lan");
    if (lanParam === "1") {
      writePin(true);
    } else if (lanParam === "0") {
      writePin(false);
    }

    // The notice's "go here by hand" link points at the PREFERRED face even when
    // nothing answered — that is the one the user most likely wants back.
    const best = origins.length ? targetFor(origins[0]) : "";

    if (readPin()) {
      cfg.onStay("pinned", best);
      return "pinned";
    }
    if (!origins.length) {
      cfg.onStay("unknown", "");
      return "unknown";
    }
    const winner = await firstReachable(origins, here.pathname);
    if (winner) {
      cfg.navigate(targetFor(winner));
      return "redirected";
    }
    cfg.onStay("unreachable", best);
    return "unreachable";
  }

  return {
    check,
    // The preferred face, for callers that want to show or link it.
    secureOrigin: () => secureOriginsFrom(cfg.hosts())[0] || "",
    secureOrigins: () => secureOriginsFrom(cfg.hosts()),
  };
}

/**
 * The one-line wiring both apps use: decide the face, and — WHEN ASKED — if we
 * end up staying on an insecure one, say so where the user can see it. Returns
 * the same promise `check()` does, so a caller (or a test) can await the outcome.
 *
 * The hop still happens either way: at home this silently upgrades to the https
 * LAN face and off-LAN to the tailnet one, where the service worker IS allowed
 * and real offline mode kicks in. The `notice` toggle only governs the standing
 * "Sin modo offline" chip shown when we CAN'T hop (no secure face answered).
 * todoapp + macrotrackingapp pass `notice: false`: they are LAN-first apps that
 * must keep loading with Tailscale off, so the plain-http face is expected, not
 * an error worth a permanent nag. The capability truth is unchanged — an
 * insecure origin still has no offline shell — the reminder is just suppressed.
 *
 * The chrome instance is built here rather than shared with the app's own: this
 * runs at the very top of boot, before the connectivity/refresh stack exists,
 * and `createOfflineChrome` is stateless DOM helpers — two instances draw the
 * same single-id elements.
 *
 * @param {object} [config]
 * @param {boolean} [config.notice=true]  Show the standing insecure-face notice
 *        when staying put. Set false to hop-or-stay silently.
 */
export function installSecureFace(config = {}) {
  const { notice = true, onStay: callerOnStay, ...faceConfig } = config;
  const chrome = createOfflineChrome();
  const face = createSecureFace({
    ...faceConfig,
    onStay: (reason, secureUrl) => {
      // "pinned" is a choice the user made with ?lan=1; don't nag about it.
      if (notice && reason !== "pinned") {
        chrome.insecureNotice(secureUrl);
      }
      if (callerOnStay) {
        callerOnStay(reason, secureUrl);
      }
    },
  });
  return face.check();
}
