/**
 * Copy text to the clipboard from any context, including plain http.
 *
 * `navigator.clipboard` is undefined outside a secure context, so on a plain
 * http:// LAN address `navigator.clipboard.writeText(text)` threw a
 * TypeError — thrown, not rejected — which made every `.catch()` hung off that
 * call dead code and left the copy buttons doing nothing at all. Over https
 * the same pages take the first rung below.
 *
 *   1. Clipboard API — secure contexts (https, localhost).
 *   2. execCommand   — deprecated, but works over http while the document is
 *                      focused and the call sits inside a user gesture.
 *   3. Manual modal  — text pre-selected, user presses ⌘/Ctrl-C.
 *
 * Rung 2 fails when the copy is issued after an `await` (the user gesture has
 * expired) or the document lost focus, which is why rung 3 exists.
 */

const STYLE_ID = "sc-copy-style";
const OVERLAY_CLASS = "sc-copy-overlay";

/**
 * Writes `text` to the clipboard without ever showing UI.
 * Returns true only if the text actually landed on the clipboard.
 */
export async function copyText(text) {
  if (typeof document === "undefined") {
    return false;
  }
  try {
    if (globalThis.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn("Clipboard API write failed, trying execCommand.", err);
  }
  return execCommandCopy(text);
}

/**
 * Writes `text` to the clipboard, falling back to a modal that shows the text
 * pre-selected so the user can copy it by hand.
 *
 * Resolves true when the text is on the clipboard (silently, or because the
 * user copied it out of the modal), false when they dismissed the modal.
 */
export async function copyOrShow(text, { title } = {}) {
  if (await copyText(text)) {
    return true;
  }
  return showManualCopyModal(text, title);
}

/** The hidden-textarea + execCommand trick. Returns true on success. */
function execCommandCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    return document.execCommand("copy");
  } catch (err) {
    console.warn("execCommand copy failed.", err);
    return false;
  } finally {
    ta.remove();
  }
}

/**
 * Last resort: show the text, selected, and let the user hit ⌘/Ctrl-C. The
 * in-modal 📋 button retries execCommand — that click is a fresh user gesture
 * on a focused document, which is often all the earlier attempt was missing.
 */
function showManualCopyModal(text, title = "Copiar manualmente") {
  ensureStyles();

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;

    const overlay = document.createElement("div");
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const card = document.createElement("div");
    card.className = "sc-copy-card";

    const heading = document.createElement("h2");
    heading.className = "sc-copy-title";
    heading.textContent = title;

    const hint = document.createElement("p");
    hint.className = "sc-copy-hint";
    hint.textContent =
      "El portapapeles no está disponible en http. El texto ya está seleccionado: pulsa ⌘/Ctrl-C, o toca 📋 Copiar.";

    const ta = document.createElement("textarea");
    ta.className = "sc-copy-text";
    ta.value = text;
    ta.readOnly = true;
    ta.spellcheck = false;
    ta.rows = Math.min(16, Math.max(6, text.split("\n").length));

    const row = document.createElement("div");
    row.className = "sc-copy-actions";

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "sc-copy-btn sc-copy-btn-primary";
    retryBtn.textContent = "📋 Copiar";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sc-copy-btn";
    closeBtn.textContent = "Cerrar";

    let settled = false;
    const close = (copied) => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      previouslyFocused?.focus?.();
      resolve(copied);
    };

    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      }
    };

    retryBtn.addEventListener("click", () => {
      ta.focus();
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        console.warn("Manual-modal copy failed.", err);
      }
      if (ok) {
        close(true);
        return;
      }
      hint.textContent =
        "Tu navegador no deja copiar por script aquí. Selecciona el texto y pulsa ⌘/Ctrl-C.";
    });

    closeBtn.addEventListener("click", () => close(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        close(false);
      }
    });
    // A native ⌘/Ctrl-C over the selection fires this — treat it as success.
    ta.addEventListener("copy", () => close(true));
    document.addEventListener("keydown", onKeydown, true);

    row.append(retryBtn, closeBtn);
    card.append(heading, hint, ta, row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
  });
}

/** Injected once, and self-contained: no app has to ship CSS for this. */
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // `Canvas`/`CanvasText` are system colors: they follow the OS light/dark
  // scheme, so this modal looks right in the audiobooks night mode too.
  style.textContent = `
.${OVERLAY_CLASS} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.55);
  color-scheme: light dark;
}
.sc-copy-card {
  background: Canvas;
  color: CanvasText;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  padding: 16px;
  width: min(680px, 100%);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font: inherit;
}
.sc-copy-title { margin: 0; font-size: 1.1rem; }
.sc-copy-hint { margin: 0; font-size: 0.85rem; opacity: 0.75; }
.sc-copy-text {
  width: 100%;
  flex: 1 1 auto;
  min-height: 8rem;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  line-height: 1.4;
  white-space: pre;
  overflow: auto;
  background: Field;
  color: FieldText;
  border: 1px solid rgba(128, 128, 128, 0.45);
  border-radius: 8px;
  padding: 8px;
}
.sc-copy-actions { display: flex; gap: 8px; justify-content: flex-end; }
.sc-copy-btn {
  font: inherit;
  cursor: pointer;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.45);
  background: ButtonFace;
  color: ButtonText;
}
.sc-copy-btn-primary { border-color: #2b7cd3; background: #2b7cd3; color: #fff; }
`;
  document.head.appendChild(style);
}
