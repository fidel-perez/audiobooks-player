/**
 * WHICH STACK A REQUEST LEAVES THE DEVICE ON. One seam, two implementations.
 *
 * `transport.js` decides WHERE an /api call goes (which face). This decides HOW
 * it gets there, and it exists because the two builds of these apps do not have
 * the same network underneath them:
 *
 *   - THE BROWSER BUILD reaches the Pi with `window.fetch`, from a document on
 *     one of the Pi's own https faces. A call to another face is cross-origin,
 *     so it only works because Caddy now echoes an `Access-Control-Allow-Origin`
 *     for the faces on its allow-list, and every write pays a preflight.
 *
 *   - THE SHELL BUILD (`projects/pi-shell`) runs the same app files from a
 *     custom-protocol origin that is not a face at all and never will be on any
 *     allow-list. Its requests are made outside the webview, where CORS does not
 *     apply — the whole reason the shell exists is that a fixed origin is the
 *     only way to stop the browser partitioning app state per face.
 *
 * The apps must not know which of those they are running under. They call
 * `apiFetch`, `apiFetch` routes to a face, and the URL it produces is handed to
 * whatever `__PI_NATIVE__.fetch` the host injected — or to plain `fetch` when
 * nobody injected anything, which is every browser tab.
 *
 * THE HOST INJECTS, THIS MODULE ONLY LOOKS. Nothing here knows what Tauri is, or
 * that a custom protocol is involved. A host that wants to own the network sets
 * `window.__PI_NATIVE__ = { name, fetch }` before the app's modules run, and its
 * `fetch` must behave like `fetch`: same arguments, resolves to a Response,
 * rejects on a network-level failure. That contract is what lets `transport.js`
 * keep reading a rejection as "this face is dead" without caring who threw it.
 *
 * READ PER CALL, NOT AT IMPORT. The lookup is deliberately not hoisted into a
 * module-level constant: a host that injects late (or a test that installs a
 * double between two assertions) would otherwise be ignored for the life of the
 * page, and the failure would look like "the shell is using the browser stack"
 * with nothing in the stack trace to say why.
 *
 * NOT `async`, and load-bearing — see the same note on `transport.js`'s
 * `request`. Fire-and-forget writes go out from `pagehide` handlers with
 * `keepalive: true`, and a request the browser has not been handed before that
 * handler returns is a request that never leaves. An `async` wrapper here would
 * put every one of them a microtask late.
 */

/**
 * @param {object} [config]
 * @param {object} [config.window]        Where to look for `__PI_NATIVE__`.
 * @param {typeof fetch} [config.fetch]   The fallback (browser) stack.
 */
export function createPlatform(config = {}) {
  const win =
    config.window !== undefined
      ? config.window
      : typeof window === "undefined"
        ? null
        : window;
  const browserFetch =
    config.fetch ||
    ((...args) =>
      typeof fetch === "undefined"
        ? Promise.reject(new Error("no fetch"))
        : fetch(...args));

  /** The host's stack, or null when we are in a plain browser tab. */
  function native() {
    const n = win && win.__PI_NATIVE__;
    return n && typeof n.fetch === "function" ? n : null;
  }

  function request(input, init) {
    const n = native();
    return n ? n.fetch(input, init) : browserFetch(input, init);
  }

  return {
    fetch: request,
    /** True when a host owns the network — i.e. CORS is not in the picture. */
    isNative: () => !!native(),
    /** For diagnostics and the offline chrome: "browser", "pi-shell", … */
    name: () => {
      const n = native();
      return (n && n.name) || "browser";
    },
  };
}

let shared = null;

/** @returns {ReturnType<typeof createPlatform>} */
export function platform() {
  if (!shared) {
    shared = createPlatform();
  }
  return shared;
}

/** Drop-in for `fetch`, on the host's stack when there is one. @type {typeof fetch} */
export function platformFetch(input, init) {
  return platform().fetch(input, init);
}
