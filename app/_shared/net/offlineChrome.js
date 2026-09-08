/**
 * Offline chrome: how being offline LOOKS, shared by todoapp + macrotrackingapp.
 *
 * Two pieces, deliberately different in weight:
 *
 *   - A persistent red frame around the viewport. Always-on while offline, so
 *     the state is obvious at a glance from across the room, and it costs zero
 *     content area — a top banner pushed the page down and covered the very
 *     rows you opened the app to read.
 *   - A transient toast, fired only when an action was actually REFUSED. This is
 *     what explains *why* the tap did nothing. It says it once, then leaves.
 *
 * The frame is drawn on an overlay element with `pointer-events: none`, not as a
 * border on <body>: a body border reflows the whole page (and on iOS drags the
 * safe-area insets around), which is exactly the intrusiveness we're avoiding.
 *
 * Styles are injected from here rather than shipped as a stylesheet so that an
 * offline load can't be missing them — one less request that has to have been
 * cached for the offline state to render correctly.
 */

const STYLE_ID = "net-offline-style";
const FRAME_ID = "net-offline-frame";
const TOAST_ID = "net-offline-toast";
const INSECURE_ID = "net-insecure-notice";

const CSS = `
#${FRAME_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  border: 4px solid #d93636;
  box-shadow: inset 0 0 12px rgba(217, 54, 54, 0.35);
}
#${FRAME_ID}::after {
  content: attr(data-label);
  position: absolute;
  right: 10px;
  bottom: 8px;
  padding: 3px 9px;
  font: 600 11px/1.4 system-ui, -apple-system, sans-serif;
  letter-spacing: 0.02em;
  color: #fff;
  white-space: nowrap;
  background: #d93636;
  border-radius: 10px;
  opacity: 0.9;
}
#${TOAST_ID} {
  position: fixed;
  bottom: 34px;
  left: 50%;
  z-index: 2147483001;
  max-width: min(90vw, 30rem);
  padding: 10px 16px;
  font: 600 0.9rem/1.35 system-ui, -apple-system, sans-serif;
  color: #fff;
  text-align: center;
  background: #23272b;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
  transition: opacity 140ms ease, transform 140ms ease;
  pointer-events: none;
}
#${TOAST_ID}.is-visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
@media (prefers-reduced-motion: reduce) {
  #${TOAST_ID} { transition: none; }
}
#${INSECURE_ID} {
  position: fixed;
  right: 8px;
  bottom: 8px;
  z-index: 2147482999;
  max-width: min(92vw, 26rem);
  padding: 7px 11px;
  font: 500 11px/1.35 system-ui, -apple-system, sans-serif;
  color: #3a2c05;
  background: #ffd88a;
  border: 1px solid #e0ac36;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}
#${INSECURE_ID} a {
  color: #1c4fd8;
  font-weight: 700;
}
#${INSECURE_ID} button {
  margin-left: 6px;
  padding: 0 4px;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
  opacity: 0.6;
}
`;

const DEFAULTS = {
  label: "Sin conexión",
  refusedMessage: "Sin conexión — el cambio no se guardaría.",
  toastMs: 2600,
};

/**
 * @param {object} [config]
 * @param {string} [config.label]            Text in the frame's corner chip.
 * @param {string} [config.refusedMessage]   Default toast text for a refused write.
 * @param {number} [config.toastMs]          How long the refusal toast stays up.
 */
export function createOfflineChrome(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let toastTimer = null;

  function ensureStyle() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function showFrame() {
    if (typeof document === "undefined" || document.getElementById(FRAME_ID)) {
      return;
    }
    ensureStyle();
    const frame = document.createElement("div");
    frame.id = FRAME_ID;
    frame.setAttribute("data-label", cfg.label);
    frame.setAttribute("role", "status");
    frame.setAttribute("aria-label", cfg.label);
    document.body.appendChild(frame);
  }

  function hideFrame() {
    if (typeof document === "undefined") {
      return;
    }
    const frame = document.getElementById(FRAME_ID);
    if (frame) {
      frame.remove();
    }
  }

  /**
   * Say why an action was refused. Fires on every refused attempt — repeating
   * the message is the point, since the user just tried again.
   */
  function refused(message) {
    if (typeof document === "undefined") {
      return;
    }
    ensureStyle();
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.setAttribute("role", "alert");
      document.body.appendChild(toast);
    }
    toast.textContent = message || cfg.refusedMessage;
    // Restart the fade even if a toast is already up.
    toast.classList.remove("is-visible");
    void toast.offsetWidth;
    toast.classList.add("is-visible");
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      toast.classList.remove("is-visible");
      toastTimer = null;
    }, cfg.toastMs);
  }

  /**
   * Say, quietly and permanently, that THIS session has no offline mode.
   *
   * Shown when the page is running on the insecure LAN face, where the browser
   * withholds `navigator.serviceWorker` entirely — so nothing is precached and a
   * discarded tab cannot come back without the network. That is invisible until
   * the moment it costs you the app, which is why it gets a standing notice
   * rather than a toast. `secureUrl` (when known) is the one-tap way out.
   *
   * Deliberately small and corner-parked: the app still WORKS here, this is a
   * capability warning, not an error.
   */
  function insecureNotice(secureUrl) {
    if (typeof document === "undefined" || document.getElementById(INSECURE_ID)) {
      return;
    }
    ensureStyle();
    const box = document.createElement("div");
    box.id = INSECURE_ID;
    box.setAttribute("role", "status");
    // The target is whichever secure face secureFace.js prefers — the LAN https
    // one at home, the tailnet one away from it — so the label cannot name a
    // network any more.
    const link = secureUrl
      ? ` <a href="${secureUrl}">abrir en la dirección segura</a>`
      : "";
    box.innerHTML = `⚠️ Sin modo offline en esta dirección.${link}`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Cerrar aviso");
    close.addEventListener("click", () => box.remove());
    box.appendChild(close);
    document.body.appendChild(box);
  }

  return { showFrame, hideFrame, refused, insecureNotice };
}
