/**
 * Shared connectivity state for todoapp + macrotrackingapp.
 *
 * ONE answer to "can we reach the backend right now", and one place that can
 * change it. Before this module each app inferred connectivity from
 * `navigator.onLine` plus whichever fetch happened to fail, and both got it
 * wrong in the same way: `navigator.onLine === true` only means an interface is
 * up, not that the pi is reachable (airplane mode on a laptop, a phone
 * associated to wifi with no route, a tailnet tunnel that hasn't come up). Worse,
 * the failures that WOULD have proved us offline were swallowed —
 * `activeUserLock.getLastUpdatedRaw()` returned `null` on a network error and
 * the lock check read that as "no lock yet, carry on".
 *
 * The rules, in order of trust:
 *
 *   1. A fetch that REJECTS is proof of unreachability. Report it and we go
 *      offline immediately. (An HTTP 4xx/5xx is NOT: the server answered.)
 *   2. A fetch that RESOLVES is proof of reachability, and stamps `lastOkAt`.
 *   3. `navigator.onLine === false` is a trustworthy offline hint (the OS knows
 *      it has no interface). `=== true` proves nothing and is never trusted.
 *   4. Anything else is settled by an explicit HEAD probe.
 *
 * `ensureWritable()` is the gate a mutating action awaits. It answers from
 * `lastOkAt` when that evidence is younger than `freshMs` — so a burst of edits
 * during normal use costs zero extra requests — and otherwise probes. That makes
 * "the first click after a while blocks for one round-trip, the rest are free".
 *
 * WHAT THE PROBE ASKS, and why it depends on the build. In a browser tab the
 * document sits on one of the pi's own faces, so a same-origin HEAD really does
 * ask the pi whether it is there. Under the shell (`projects/pi-shell`) it asks
 * NOTHING: the document's origin is the shell's own cache, answered off the
 * phone's disk with no network involved, so the probe could only ever say
 * "online" — including in airplane mode, where it would talk the app straight
 * back out of offline mode and into accepting edits that go nowhere. So when a
 * host owns the network the probe goes to the API through the transport, which
 * is the thing whose reachability the answer is actually about.
 */

import { platform } from "../platform.js";
import { apiFetch } from "./transport.js";

/**
 * What the probe asks when a host owns the network. The cheapest thing
 * json_store answers, and a HEAD, so no app service worker can serve it from a
 * cache and pin us "online" off a stale copy.
 */
const NATIVE_PROBE_PATH = "/api/";

const DEFAULTS = {
  // How long a successful backend response stands as proof of reachability.
  // Sized just over the refresh controller's 1 s poll: while the tab is active
  // and not idle, the lock read keeps this fresh and no mutation ever probes.
  freshMs: 1500,
  probeTimeoutMs: 4000,
};

const nowMs = () => Date.now();

function noop() {}

function safe(fn, ...args) {
  try {
    return fn(...args);
  } catch (e) {
    console.warn("[net] callback threw:", e);
    return undefined;
  }
}

function defaultProbeUrl() {
  const base =
    typeof location !== "undefined" && location.href
      ? location.href.split("#")[0]
      : "/";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}_ping=${Date.now()}`;
}

/**
 * True when `err` is a network-layer failure (fetch rejected) rather than an
 * HTTP status we chose to throw on. A rejected fetch is a `TypeError` in every
 * browser; an aborted one is an `AbortError` / `DOMException`. Callers that
 * `throw new Error("HTTP 500")` on a bad status must NOT drive us offline — the
 * server answered, so the network is fine.
 */
export function isNetworkError(err) {
  if (!err) {
    return false;
  }
  if (err.name === "AbortError" || err.name === "TimeoutError") {
    return true;
  }
  return err instanceof TypeError;
}

/**
 * The header `projects/pi-shell`'s `serve.rs` stamps on an answer it served from
 * its own disk cache instead of off a face. Must stay spelled exactly as
 * `STALE_HEADER` there — a test pins both ends.
 */
export const STALE_ANSWER_HEADER = "x-pi-cache";

/**
 * True when a RESOLVED response never came off the network.
 *
 * RULE 2 ABOVE HAS AN EXCEPTION AND THIS IS IT. "A fetch that resolves is proof
 * of reachability" holds for a browser tab, where a resolved `/api` response can
 * only have come from a server — the audiobooks service worker deliberately
 * keeps `/api/audiobooks-progress` network-only for exactly this reason (see
 * `sw.js`). It does NOT hold under the shell: `serve.rs` answers an unreachable
 * `/api` GET out of `apicache` with a plain `200`, which is the right thing for
 * the DATA (an offline launch opens on last night's blob) and a lie about the
 * NETWORK. A caller that reads the 200 as "the server answered" then reports the
 * wrong cause — audiobooks said *"el servidor no acepta la sincronización"* on a
 * phone whose writes were never sent anywhere.
 *
 * So the shell marks those answers and this is how a caller asks. A response
 * with no headers object (a test double, a synthetic Response) is treated as
 * live, since that is what every caller meant before this existed.
 */
export function isStaleAnswer(response) {
  try {
    return !!(response && response.headers && response.headers.get(STALE_ANSWER_HEADER));
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} config
 * @param {() => string} [config.probeUrl]  URL for the HEAD probe in a browser
 *        tab. Must be same-origin — under a native host it is not used at all,
 *        see the module header.
 * @param {(init: object) => Promise<Response>} [config.probeFetch]  Issues the
 *        probe. Tests pass one; production wants the default.
 * @param {number} [config.freshMs=1500]    How long a good response proves reachability.
 * @param {number} [config.probeTimeoutMs=4000]
 * @param {() => void} [config.onOffline]   Fired once, on the online→offline edge.
 * @param {(wasOffline: boolean) => void} [config.onOnline]  Fired once, on the offline→online edge.
 */
export function createConnectivity(config = {}) {
  const cfg = {
    probeUrl: config.probeUrl || defaultProbeUrl,
    freshMs: config.freshMs ?? DEFAULTS.freshMs,
    probeTimeoutMs: config.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs,
    onOffline: config.onOffline || noop,
    onOnline: config.onOnline || noop,
    probeFetch: null,
  };

  // Resolved per probe, not once: the host injects `__PI_NATIVE__` before the
  // app's modules run, but a test installs one between two assertions and a
  // hoisted answer would ignore it for the life of the page — the same reason
  // `platform.js` looks per call.
  cfg.probeFetch =
    config.probeFetch ||
    ((init) =>
      platform().isNative()
        ? apiFetch(NATIVE_PROBE_PATH, init)
        : fetch(cfg.probeUrl(), init));

  let online = true;
  let lastOkAt = 0;
  let probeInFlight = null;

  function setOffline() {
    if (online) {
      online = false;
      lastOkAt = 0;
      safe(cfg.onOffline);
    }
  }

  function setOnline() {
    lastOkAt = nowMs();
    if (!online) {
      online = true;
      safe(cfg.onOnline, true);
    }
  }

  /** A backend request came back (any HTTP status). The network is up. */
  function noteReachable() {
    setOnline();
  }

  /**
   * A backend request failed. Only a network-layer rejection proves we're
   * offline; an HTTP error means the server answered and we stay online.
   */
  function noteUnreachable(err) {
    if (isNetworkError(err)) {
      setOffline();
    } else {
      setOnline();
    }
  }

  /**
   * Settle the question with a HEAD request. Concurrent callers share one
   * in-flight probe. A non-ok STATUS still proves reachability — something
   * answered — so only a rejection or timeout flips us offline.
   */
  function probe() {
    if (probeInFlight) {
      return probeInFlight;
    }
    probeInFlight = (async () => {
      const ctl =
        typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl
        ? setTimeout(() => ctl.abort(), cfg.probeTimeoutMs)
        : null;
      try {
        await cfg.probeFetch({
          method: "HEAD",
          cache: "no-store",
          signal: ctl ? ctl.signal : undefined,
        });
        setOnline();
        return true;
      } catch (_e) {
        setOffline();
        return false;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    })().finally(() => {
      probeInFlight = null;
    });
    return probeInFlight;
  }

  /**
   * The gate a mutating action awaits before it touches app state. Resolves
   * true when a write can be expected to reach the server.
   *
   * Answers instantly from recent evidence (`freshMs`); otherwise probes. When
   * we are already offline it ALWAYS probes, so the first click after the
   * network comes back recovers immediately instead of waiting for a poll tick.
   */
  async function ensureWritable() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // The OS is certain it has no interface. Believe that one, skip the probe.
      setOffline();
      return false;
    }
    if (online && nowMs() - lastOkAt < cfg.freshMs) {
      return true;
    }
    return probe();
  }

  return {
    isOnline: () => online,
    isOffline: () => !online,
    probe,
    ensureWritable,
    noteReachable,
    noteUnreachable,
    /** Force offline (e.g. the `offline` DOM event). */
    reportOffline: setOffline,
    /** Force online (e.g. a confirmed response outside the fetch helpers). */
    reportOnline: setOnline,
    // --- test hooks (production code should not call these) ---
    _setOnlineForTest: (v) => {
      online = !!v;
      lastOkAt = v ? nowMs() : 0;
    },
    _setLastOkForTest: (t) => {
      lastOkAt = t;
    },
  };
}
