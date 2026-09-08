/**
 * Where an /api call travels — decided PER REQUEST, not per document.
 *
 * THE BUG CLASS THIS CLOSES. Every app talks to json_store over a same-origin
 * relative path (`API_BASE = "/api/"`). That single line is why `secureFace.js`
 * has to hop the DOCUMENT between faces: if the API is same-origin, then the
 * origin the page is on IS the network it can reach, and the only way to change
 * networks is to change origins. But origin is also the browser's storage
 * identity — IndexedDB, localStorage, the service-worker registration and its
 * cache are all partitioned by it. So every face hop lands the app in a FRESH,
 * EMPTY silo, and the four faces this Pi answers on (wired deSEC, backup-wifi
 * deSEC, tailnet:10000, plain-http LAN) are four separate copies of every app's
 * local state. json_store is the only thing that puts them back together, which
 * is why a face hop reads as "it lost my progress" and why sync is a permanent
 * fight rather than a background detail.
 *
 * Routing /api per request breaks the coupling. The document stays on ONE origin
 * for good — one IndexedDB, one SW registration, one PWA install — while the API
 * travels to whichever face is answering right now. Face failover stops being a
 * navigation and becomes a retry loop.
 *
 * WHAT THIS IS NOT. It is not a sync engine and it does not queue: a request
 * that cannot reach any face still rejects, exactly as a bare `fetch` would, so
 * `writeGuard.js` and the per-app offline handling keep working unchanged. The
 * outbox belongs a layer up and lands later.
 *
 * ---
 *
 * PIN UNTIL FAILURE, NOT PIN WITH A TTL. Resolving a face costs a probe race, so
 * the winner is remembered. A TTL would pay that race on a schedule, which is
 * both too often (nothing changed) and too late (the network changed one second
 * after the last refresh). Instead the pin is held until something actually
 * tells us it is wrong:
 *
 *   - a request against it fails at the NETWORK level (not an HTTP status — a
 *     502 or a 404 is a real answer from a live face, and re-racing on it would
 *     turn every application error into a face flap);
 *   - `online` fires, i.e. the device just changed networks;
 *   - the app comes back to the foreground AND the pin is not already the
 *     most-preferred face. That last clause is the cheap half of the trick: a
 *     device pinned to the wired LAN face has nothing better to find, so
 *     foregrounding it costs nothing. Only a device that settled for the
 *     tailnet — the away-from-home face — pays a race to check whether it came
 *     home.
 *
 * Invalidation only CLEARS the pin; the race happens lazily on the next request.
 * An app that foregrounds and sits idle pays nothing at all.
 *
 * ONE RESOLUTION PATH, PROBE-THEN-SEND, FOR READS AND WRITES ALIKE. Racing the
 * real request across all faces and taking the first success would save a
 * round-trip, but it is only ever safe for reads: json_store's PATCH list-ops
 * are not idempotent, so a fanned-out write can append twice. Rather than run
 * two code paths for the sake of one RTT on the rare unpinned request, both go
 * probe-then-send. Read fan-out stays available as a later optimisation if the
 * unpinned case ever turns out to be hot.
 *
 * WHAT GETS ROUTED. Only ABSOLUTE PATHS (`/api/...`). A page-relative request
 * (`regular_foods.json`, `index.html?_bust=…`) is an app ASSET: it must come
 * from the document's own origin so the service worker can serve it from the
 * precached shell, and sending it to another face would defeat offline mode.
 * Absolute URLs are passed through untouched.
 *
 * NO FACES CONFIGURED → PLAIN FETCH. On localhost, in a test, or on a fresh
 * `docker compose up` with no ansible-rendered .env, `__PI_HOSTS__` yields no
 * usable origin. Then this is a transparent pass-through and every app behaves
 * exactly as it did before. Same when a race finds nothing answering: the
 * same-origin attempt is the honest last try, and its failure is what the
 * offline stack already knows how to read.
 *
 * CREDENTIALS. Requests become cross-origin, so a caller's
 * `credentials: "same-origin"` stops sending cookies. That is deliberate and
 * currently free: json_store carries no cookie auth (it is reachable only from
 * the LAN or the tailnet). Anything that later DOES need a cookie across faces
 * must ask for `credentials: "include"` and get a matching
 * `Access-Control-Allow-Credentials` from Caddy.
 *
 * Pure module: every browser touchpoint is injectable, so it is testable under
 * the Node shim in `tests/_shim.js`.
 */

import { platformFetch } from "../platform.js";
import { secureOriginsFrom } from "./faces.js";

const DEFAULTS = {
  // Same budget as the secureFace probe, for the same reason: long enough for a
  // warming tailnet tunnel to answer, short enough that an off-VPN request is
  // not visibly held up. All faces are probed at once, so this is the ceiling
  // for the whole race, not per face.
  timeoutMs: 2500,
  storageKey: "pi:face:api",
  // Probed instead of the request's own path: a HEAD against the API root is
  // the cheapest thing json_store answers, and it keeps every face's probe
  // identical so results can be reasoned about (and cached in the pin) across
  // requests with different paths.
  probePath: "/api/",
};

/**
 * The header `projects/pi-shell`'s `serve.rs` stamps with the face that ACTUALLY
 * answered. Must stay spelled exactly as `FACE_HEADER` there — a test pins both
 * ends.
 *
 * WHY A PIN NEEDS THIS TO BE CORRECTABLE AT ALL. Everything below drops the pin
 * on a REJECTION, because in a browser tab that is the only way a dead face can
 * present itself. Under the shell it is not: a request to a face that cannot be
 * reached is re-raced and retried by `serve.rs` on a face that can, so the page
 * gets a `200` and its pin looks vindicated. Measured on a phone pinned to the
 * wired LAN face and then moved to the wifi-only subnet, every `/api` call cost
 * ~6.5 s (a full API budget, a face race and a retry) and every one of them
 * SUCCEEDED — so the pin never moved and the next call paid it again. The 4 s
 * probe in `connectivity.js` could then only ever abort, and the app sat in
 * offline mode, refusing edits, with the Pi answering the whole time.
 *
 * So the shell says which face answered and the pin follows the evidence. In a
 * browser tab nothing sends this header and every path below behaves exactly as
 * it did before it existed.
 */
export const FACE_ANSWERED_HEADER = "x-pi-face";

/**
 * The face a response says answered it, `""` when it does not say.
 *
 * An opaque response (a cross-origin `no-cors` probe in a browser tab) exposes no
 * headers at all and a test double may have none — both mean "no evidence", which
 * is what every caller assumed before this header existed.
 */
export function answeringFace(response) {
  try {
    return (
      (response && response.headers && response.headers.get(FACE_ANSWERED_HEADER)) ||
      ""
    );
  } catch (_e) {
    return "";
  }
}

function noop() {}

/**
 * @param {object} [config]
 * @param {() => object} [config.hosts]   Reads `window.__PI_HOSTS__`.
 * @param {typeof fetch} [config.fetch]   The underlying fetch.
 * @param {object} [config.storage]       localStorage-alike for the pin.
 * @param {number} [config.timeoutMs]
 * @param {string} [config.probePath]
 * @param {(face: string) => void} [config.onFaceChange]  Told when the pin moves,
 *        for a UI that wants to show which face it is talking to.
 * @param {(type: string, fn: Function) => void} [config.listen]  Event binding,
 *        for the `online` / `visibilitychange` invalidators. Pass a no-op to
 *        build a transport with no ambient wiring (tests do).
 * @param {() => boolean} [config.isVisible]  `document.visibilityState === "visible"`.
 */
export function createTransport(config = {}) {
  const cfg = {
    hosts:
      config.hosts ||
      (() => (typeof window === "undefined" ? {} : window.__PI_HOSTS__ || {})),
    // The PLATFORM's fetch, not the window's. In a browser tab the two are the
    // same function; under the shell (`projects/pi-shell`) the platform hands
    // the request to the host, which is outside the webview and therefore
    // outside CORS. This module keeps deciding WHICH FACE either way — see
    // `../platform.js` for why the two builds cannot share one network stack.
    fetch: config.fetch || platformFetch,
    storage:
      config.storage ||
      (typeof localStorage === "undefined" ? null : localStorage),
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    probePath: config.probePath || DEFAULTS.probePath,
    onFaceChange: config.onFaceChange || noop,
    listen:
      config.listen ||
      ((type, fn) => {
        if (typeof window !== "undefined" && window.addEventListener) {
          window.addEventListener(type, fn);
        }
      }),
    isVisible:
      config.isVisible ||
      (() =>
        typeof document === "undefined" ||
        document.visibilityState === "visible"),
    origin:
      config.origin ||
      (() => (typeof location === "undefined" ? "" : location.origin)),
  };

  // In-memory mirror of the persisted pin. Storage can be blocked (private
  // mode, a locked-down webview); the transport must still work for the life of
  // the page, just without remembering across loads.
  let pinned = null;
  // One race at a time. Ten queued requests on a cold start must not each fire
  // their own probe storm — they all await the same resolution.
  let resolving = null;

  /**
   * The faces this document may route to, best first.
   *
   * AN HTTPS DOCUMENT ON AN ORIGIN THE LIST DOES NOT HOLD came through the
   * Cloudflare tunnel, the one face the Pi does not inject.
   *
   * Every listed face is a private address, and a public document may not fetch
   * one.
   *
   * Firefox calls that a CORS failure and Chrome calls it Private Network
   * Access. The todoapp shows either as "NetworkError".
   *
   * So `/api` stays where the document is. The shell's `piapp://localhost` and
   * the plain-http LAN page keep the full list.
   */
  function origins() {
    const list = secureOriginsFrom(cfg.hosts());
    const here = cfg.origin() || "";
    if (here.startsWith("https://") && !list.includes(here)) {
      return [];
    }
    return list;
  }

  function readPin() {
    if (pinned !== null) {
      return pinned;
    }
    try {
      pinned = (cfg.storage && cfg.storage.getItem(DEFAULTS.storageKey)) || "";
    } catch (_e) {
      pinned = "";
    }
    return pinned;
  }

  function writePin(face) {
    const before = readPin();
    pinned = face;
    try {
      if (cfg.storage) {
        if (face) {
          cfg.storage.setItem(DEFAULTS.storageKey, face);
        } else {
          cfg.storage.removeItem(DEFAULTS.storageKey);
        }
      }
    } catch (_e) {
      // Blocked storage → the pin lives only in memory. Still correct.
    }
    if (face && face !== before) {
      cfg.onFaceChange(face);
    }
  }

  /**
   * The face a response CREDITS, when that is a face we would have chosen
   * ourselves — otherwise "".
   *
   * Only a configured face is adopted, because the pin is read back through
   * `list.includes(pin)` on the next request: a face outside this list (the
   * shell's plain-http LAN face, which `secureOriginsFrom` deliberately refuses
   * for a browser) would be dropped there and cost a fresh race every time. The
   * shell keeps working in that case, it just keeps retargeting — which is the
   * cost this header removes for the faces the page CAN name, not a promise
   * about the ones it cannot.
   */
  function credited(response) {
    const face = answeringFace(response);
    return face && origins().includes(face) ? face : "";
  }

  /**
   * Which face answers this one? `""` if none does.
   *
   * A cross-origin HEAD in `no-cors` mode: the response is opaque and no status
   * can be read from it, which is fine — "it resolved at all" is exactly the
   * question, and it is the only question answerable without CORS headers.
   *
   * THE ANSWER IS NOT ALWAYS THE FACE WE ASKED. Under the shell every face
   * "answers", because a request to an unreachable one is retargeted onto a
   * reachable one before it comes back — so a race run on resolution alone
   * always crowns the first face in the list, whatever the device can actually
   * reach. Crediting the response is what makes the race mean something there;
   * in a browser tab the probe is opaque, nothing is credited, and the origin we
   * asked is the answer exactly as before.
   *
   * HEAD IS LOAD-BEARING, same as in `secureFace.js`: all three app service
   * workers bail out of their fetch handler on `method !== "GET"`, so a HEAD can
   * never be served from the SW cache. A GET probe could be, and a probe
   * answered from cache would pin a dead face. Do not turn this into a GET.
   */
  async function reachable(origin) {
    const ctl =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), cfg.timeoutMs) : null;
    try {
      const response = await cfg.fetch(`${origin}${cfg.probePath}`, {
        method: "HEAD",
        mode: "no-cors",
        cache: "no-store",
        signal: ctl ? ctl.signal : undefined,
      });
      return credited(response) || origin;
    } catch (_e) {
      return "";
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * The face that answers for the earliest-LISTED origin, "" if none does. Every
   * probe is in flight before any is awaited — awaiting them in order decides the
   * winner, it does not serialise the requests. With three faces and a 2.5 s
   * budget apiece, a sequential walk would make a client away from home sit
   * through both LAN timeouts before the only face it can use was tried at all.
   */
  async function firstReachable(list) {
    const probes = list.map((origin) => reachable(origin));
    for (let i = 0; i < list.length; i++) {
      const face = await probes[i];
      if (face) {
        return face;
      }
    }
    return "";
  }

  /** The face to use, racing for one only if there is no usable pin. Concurrent
   * callers share a single in-flight race. */
  function resolve() {
    const list = origins();
    if (!list.length) {
      return Promise.resolve("");
    }
    const pin = readPin();
    // A pin for a face that is no longer configured (a redeploy dropped
    // DEDYN_HOST, say) is stale by definition — drop it rather than route to it.
    if (pin && list.includes(pin)) {
      return Promise.resolve(pin);
    }
    if (!resolving) {
      resolving = firstReachable(list)
        .then((winner) => {
          if (winner) {
            writePin(winner);
          }
          return winner;
        })
        .finally(() => {
          resolving = null;
        });
    }
    return resolving;
  }

  /** Forget the pin. The next request re-races; an idle app pays nothing. */
  function invalidate() {
    writePin("");
  }

  /**
   * A network-level failure — the face is gone — as opposed to an HTTP status,
   * which is a live face answering. `fetch` rejects with a TypeError for DNS,
   * connection and CORS failures, and with an AbortError for a caller's own
   * cancellation, which must NOT be read as a dead face.
   */
  function isFaceFailure(err) {
    return !!err && err.name !== "AbortError";
  }

  /** Only absolute paths are API traffic; everything else is an app asset that
   * belongs to the document's own origin and its precached shell. */
  function routable(path) {
    return typeof path === "string" && path.startsWith("/");
  }

  /** Send to `face`, and on a network-level failure re-race and retry ONCE. A
   * second failure is the caller's to handle; a retry loop here would hide a
   * real outage behind a hang.
   *
   * A SUCCESS IS ALSO EVIDENCE, and until this it was the only evidence thrown
   * away. When the answer was served by a different face than the one addressed,
   * the pin was wrong and the request paid for it — so the pin moves to the face
   * that did the work, and the next request does not pay again. See
   * `FACE_ANSWERED_HEADER`. */
  function sendVia(face, path, init) {
    // Two-argument `then`, not `.then().catch()`: the success handler now does
    // work of its own, and a throw from it is not a face failure to be retried.
    return cfg.fetch(`${face}${path}`, init).then(
      (response) => {
        const actual = credited(response);
        if (actual && actual !== face) {
          writePin(actual);
        }
        return response;
      },
      async (err) => {
        if (!isFaceFailure(err)) {
          throw err;
        }
        invalidate();
        const next = await resolve();
        if (!next || next === face) {
          throw err;
        }
        return cfg.fetch(`${next}${path}`, init);
      }
    );
  }

  /**
   * Fetch, routed. Same signature as `fetch`, and the same result: this resolves
   * to a Response or rejects, it never swallows either.
   *
   * NOT `async`, and that is load-bearing. Several call sites are
   * fire-and-forget writes issued from a `pagehide` / `visibilitychange` handler
   * with `keepalive: true` — the last-gasp save when Android is taking the tab
   * away. A request the browser has not been handed by the time that handler
   * returns is a request that never goes out, so the two paths that need no
   * network to decide — no faces configured, and an already-pinned face — call
   * through SYNCHRONOUSLY. Making this function `async` puts even the pinned
   * path a microtask late, which is enough to lose those writes.
   *
   * Only the genuinely undecided case (no pin yet) awaits, and it has to: there
   * is nowhere to send until the race says where.
   */
  function request(path, init) {
    if (!routable(path)) {
      return cfg.fetch(path, init);
    }
    const list = origins();
    if (!list.length) {
      // Nothing configured (localhost, a test, a bare docker compose). A plain
      // same-origin fetch, exactly as before this module existed.
      return cfg.fetch(path, init);
    }
    const pin = readPin();
    if (pin && list.includes(pin)) {
      return sendVia(pin, path, init);
    }
    return resolve().then((face) =>
      face
        ? sendVia(face, path, init)
        : // Nothing answered. The document's own origin is the honest last
          // attempt — and on a cached shell it is also the one the service
          // worker may still be able to serve.
          cfg.fetch(path, init)
    );
  }

  // AMBIENT INVALIDATION. `online` means the device changed networks, so the
  // pin is suspect whatever it is. Foregrounding is only worth a re-race when
  // the pin is NOT already the top face — a device on the wired LAN has nowhere
  // better to go, while one that settled for the tailnet may have come home.
  cfg.listen("online", () => invalidate());
  cfg.listen("visibilitychange", () => {
    if (!cfg.isVisible()) {
      return;
    }
    const list = origins();
    const pin = readPin();
    if (pin && list.length && pin !== list[0]) {
      invalidate();
    }
  });

  return {
    fetch: request,
    /** The face in use right now, "" if unresolved. Does not race. */
    face: () => readPin(),
    /** Every configured face, best first. */
    origins,
    invalidate,
    /** Race now and return the winner — for a caller that wants the face warm
     * before the user does anything. */
    resolve,
  };
}

/**
 * The process-wide transport. Apps import `apiFetch` and swap their bare
 * `fetch(API_BASE + key, …)` for it; nothing else in an app has to know that
 * faces exist.
 */
let shared = null;

/** @returns {ReturnType<typeof createTransport>} */
export function transport() {
  if (!shared) {
    shared = createTransport();
  }
  return shared;
}

/** Drop-in for `fetch` on absolute API paths. @type {typeof fetch} */
export function apiFetch(path, init) {
  return transport().fetch(path, init);
}
