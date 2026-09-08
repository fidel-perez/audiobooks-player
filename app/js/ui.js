/**
 * In-page replacements for the browser's native confirm() dialog and native
 * <select> pickers. Both are ugly, and on iOS a native <select> can't be
 * dismissed without committing a choice — these overlays always allow "exit
 * without choosing" (backdrop / ✕ / Esc). They reuse the .modal-panel shell +
 * theme tokens from _modal.css; styling lives in _ui.css.
 *
 * Overlays use their own `.ui-modal` class (NOT `.modal`) so the global Esc
 * handler in modal.js doesn't also grab them — each overlay owns its own Esc.
 *
 * They DO ride the shared back-guard stack, though (pushBackLayer). They open
 * over a `.modal` that already has a layer on that stack, so an overlay that
 * pushed nothing would let a back gesture spend the modal's layer instead: the
 * modal underneath closes while the dialog stays up, which reads as one dismiss
 * closing two screens. With a layer of its own, back dismisses the overlay and
 * nothing else — the same answer as its ✕ / backdrop / Esc.
 */

import { pushBackLayer } from "./modal.js";
import { t } from "./i18n.js";

/* ===================== confirm dialog ===================== */

/**
 * Promise-based confirm. Resolves `true` on OK, `false` on the cancel button.
 * Unlike window.confirm it never blocks the main thread, so callers `await` it.
 *
 * Backdrop / Esc resolve `dismissValue` — `false` by default, since walking away
 * from a "are you sure?" means NOT doing the thing. A RECEIPT dialog inverts it:
 * there the cancel button is "↩ Deshacer", the action has already happened, and
 * dismissing must mean KEEP (`dismissValue: true`). The rule either way is that
 * an accidental Esc can never be the destructive answer.
 */
export function confirmDialog(opts = {}) {
  const {
    title = "",
    message = "",
    okLabel = t("Aceptar"),
    cancelLabel = t("Cancelar"),
    danger = false,
    dismissValue = false,
  } = opts;

  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "ui-modal ui-dialog-modal";
    const back = document.createElement("div");
    back.className = "ui-back";
    const panel = document.createElement("div");
    panel.className = "ui-dialog";
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("aria-modal", "true");

    const body = document.createElement("div");
    body.className = "ui-dialog-body";
    if (title) {
      const t = document.createElement("div");
      t.className = "ui-dialog-title";
      t.textContent = title;
      body.appendChild(t);
    }
    const msg = document.createElement("div");
    msg.className = "ui-dialog-msg";
    msg.textContent = message;
    body.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "ui-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "sec";
    cancel.textContent = cancelLabel;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = danger ? "danger" : "go";
    ok.textContent = okLabel;
    // `cancelLabel: ""` drops the cancel button, making an acknowledge-only
    // dialog — the only way a surface under a modal can report (#toast paints
    // beneath one).
    if (cancelLabel) actions.append(cancel);
    actions.append(ok);

    panel.append(body, actions);
    root.append(back, panel);
    document.body.appendChild(root);

    let done = false;
    // Back dismisses THIS dialog (as `dismissValue`), not the modal under it.
    const layer = pushBackLayer(() => finish(dismissValue));
    const finish = (val) => {
      if (done) return;
      done = true;
      layer.release();
      document.removeEventListener("keydown", onKey);
      root.remove();
      resolve(val);
    };
    const onKey = (e) => {
      // Stop the event before modal.js's global window handler sees it.
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(dismissValue);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        finish(true);
      }
    };
    back.addEventListener("click", () => finish(dismissValue));
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

/* ===================== select sheet ===================== */

/**
 * Open a custom picker for a native <select>. Picking an option mirrors the
 * value back onto the <select> and fires a `change` event (so existing
 * listeners keep working). Backdrop / ✕ / Esc close it WITHOUT changing the
 * value — the "exit without selecting" native <select> can't do on iOS.
 *
 * Options are read live each open, so dynamically-populated selects (voices,
 * chapters, categories) just work. `<optgroup>` labels become section headers.
 */
export function openSelectSheet(sel) {
  const root = document.createElement("div");
  root.className = "ui-modal";
  const back = document.createElement("div");
  back.className = "ui-back";
  const panel = document.createElement("div");
  panel.className = "modal-panel ui-sheet";

  const head = document.createElement("div");
  head.className = "modal-head";
  const h = document.createElement("h2");
  h.textContent =
    sel.getAttribute("aria-label") || sel.dataset.ddTitle || t("Seleccionar");
  const x = document.createElement("button");
  x.type = "button";
  x.className = "icon-btn";
  x.textContent = "✕";
  x.title = t("Cerrar");
  head.append(h, x);

  const list = document.createElement("div");
  list.className = "modal-body ui-sheet-list";

  let done = false;
  // Back closes the sheet without choosing, leaving the modal under it up.
  const layer = pushBackLayer(() => close());
  const close = () => {
    if (done) return;
    done = true;
    layer.release();
    document.removeEventListener("keydown", onKey);
    root.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };

  const addOption = (opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ui-sheet-item" + (opt.selected ? " sel" : "");
    b.textContent = opt.textContent;
    if (opt.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener("click", () => {
        if (sel.value !== opt.value) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        close();
      });
    }
    list.appendChild(b);
  };

  Array.from(sel.children).forEach((node) => {
    if (node.tagName === "OPTGROUP") {
      const g = document.createElement("div");
      g.className = "ui-sheet-group";
      g.textContent = node.label;
      list.appendChild(g);
      Array.from(node.children).forEach(addOption);
    } else if (node.tagName === "OPTION") {
      addOption(node);
    }
  });

  panel.append(head, list);
  root.append(back, panel);
  document.body.appendChild(root);

  const selEl = list.querySelector(".sel");
  if (selEl) selEl.scrollIntoView({ block: "center" });

  back.addEventListener("click", close);
  x.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}

/**
 * Swap a native <select>'s face for a styled trigger button that opens
 * openSelectSheet(). The <select> stays in the DOM (hidden) as the value store,
 * so `.value` reads and `change` listeners elsewhere are untouched. A
 * MutationObserver keeps the trigger label synced when options are rebuilt or
 * the value is set programmatically right after (observer fires post-task).
 */
export function enhanceSelect(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = "1";

  const trig = document.createElement("button");
  trig.type = "button";
  trig.className = ("dd-trigger " + sel.className).trim();
  trig.setAttribute("aria-haspopup", "listbox");
  const al = sel.getAttribute("aria-label");
  if (al) trig.setAttribute("aria-label", al);

  const lbl = document.createElement("span");
  lbl.className = "dd-lbl";
  const caret = document.createElement("span");
  caret.className = "dd-caret";
  caret.textContent = "▾";
  trig.append(lbl, caret);

  const sync = () => {
    const opt = sel.options[sel.selectedIndex];
    lbl.textContent = opt ? opt.textContent : "";
    trig.disabled = sel.disabled;
  };

  sel.classList.add("dd-native");
  sel.setAttribute("tabindex", "-1");
  sel.setAttribute("aria-hidden", "true");
  sel.parentNode.insertBefore(trig, sel.nextSibling);
  sync();

  sel.addEventListener("change", sync);
  // `dd:sync` re-labels the trigger after the value is set programmatically
  // (setting `.value` fires no `change` and mutates no observed attribute, so
  // the observer below wouldn't catch it). Used to reflect the current chapter
  // in the picker without re-firing `change` (which would jump the reader).
  sel.addEventListener("dd:sync", sync);
  new MutationObserver(sync).observe(sel, {
    childList: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });

  trig.addEventListener("click", () => {
    if (!sel.disabled) openSelectSheet(sel);
  });
}

/** Enhance every <select> on the page (options may still be empty; sync later). */
export function enhanceAllSelects() {
  document.querySelectorAll("select").forEach(enhanceSelect);
}
