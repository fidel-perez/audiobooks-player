/**
 * UI-locale switch for the app chrome. Spanish lives in index.html already;
 * English is the only lookup table here.
 *
 * `data-i18n` on an element translates its own textContent. `data-i18n-attrs`
 * (comma-separated names) translates those attributes the same way.
 *
 * Only load-time-fixed elements carry these markers.
 *
 * A script-owned label (play/pause, fold captions, toast text) calls `t()`
 * at its own call site instead.
 */

const EN = {
  Catálogo: "Catalog",
  Ajustes: "Settings",
  Cerrar: "Close",
  Aceptar: "Accept",
  Seleccionar: "Select",
  "Tocar para ajustar la posición": "Tap to adjust position",
  "(estimado)": "(estimated)",
  "El texto leído aparecerá aquí…": "The spoken text will appear here…",
  "📖 En curso": "📖 In progress",
  "▶️ Libro en progreso": "▶️ Book in progress",
  "🎧 Libros abiertos": "🎧 Open books",
  "🔜 En cola": "🔜 Queued",
  "elegidos · tócalos en la lista": "selected · tap them in the list",
  "Subir la selección al principio de la cola": "Move selection to the front of the queue",
  "Subir la selección un puesto": "Move selection up one place",
  "Bajar la selección un puesto": "Move selection down one place",
  "Bajar la selección al final de la cola": "Move selection to the back of the queue",
  "Quitar de la cola los libros elegidos": "Remove the selected books from the queue",
  "Salir de la multiselección": "Exit multi-select",
  "⚙️ Ajustes": "⚙️ Settings",
  "🔊 Voz": "🔊 Voice",
  Voz: "Voice",
  "Voz del móvil (Android)": "Phone voice (Android)",
  "Cómo cambiar la voz del móvil": "How to change the phone voice",
  "🔈 Volumen": "🔈 Volume",
  "Bajar 5%": "Down 5%",
  "Subir 5%": "Up 5%",
  "🎚️ Modulación": "🎚️ Modulation",
  "Tratamiento de picos": "Peak handling",
  "⚡ Velocidad": "⚡ Speed",
  "😴 Modo dormir": "😴 Sleep mode",
  "📈 Registro de progreso": "📈 Progress log",
  "🔗 Sincronización": "🔗 Sync",
  "URL del servidor": "Server URL",
  "Mostrar u ocultar las explicaciones": "Show or hide the explanations",
  "Buscar por título o autor 🔍": "Search by title or author 🔍",
  "Buscar título o autor…": "Search title or author…",
  "Buscar por título o autor": "Search by title or author",
  Libro: "Book",
  "📍 Posición": "📍 Position",
  "Ajuste fino": "Fine adjustment",
  "Posición en el libro": "Position in the book",
  "⏮ Párrafo": "⏮ Paragraph",
  "Párrafo ⏭": "Paragraph ⏭",
  "Párrafo anterior (inmediato)": "Previous paragraph (immediate)",
  "Párrafo siguiente (inmediato)": "Next paragraph (immediate)",
  Párrafo: "Paragraph",
  Cancelar: "Cancel",
  "Ir a esta posición": "Go to this position",
};

const LS_KEY = "audiobooks:uiLocale";

export function getUiLocale() {
  try {
    return localStorage.getItem(LS_KEY) === "en" ? "en" : "es";
  } catch (_) {
    return "es";
  }
}

export function setUiLocale(loc) {
  try {
    localStorage.setItem(LS_KEY, loc === "en" ? "en" : "es");
  } catch (_) {
    // No localStorage (private mode): locale is not remembered across loads.
  }
}

export function t(es) {
  if (getUiLocale() !== "en") return es;
  return EN[es] || es;
}

function translateText(el) {
  let src = el.getAttribute("data-i18n-src");
  if (src === null) {
    src = el.textContent;
    el.setAttribute("data-i18n-src", src);
  }
  el.textContent = t(src);
}

function translateAttrs(el) {
  el.getAttribute("data-i18n-attrs")
    .split(",")
    .forEach((raw) => {
      const attr = raw.trim();
      const srcAttr = `data-i18n-src-${attr}`;
      let src = el.getAttribute(srcAttr);
      if (src === null) {
        src = el.getAttribute(attr) || "";
        el.setAttribute(srcAttr, src);
      }
      el.setAttribute(attr, t(src));
    });
}

export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(translateText);
  root.querySelectorAll("[data-i18n-attrs]").forEach(translateAttrs);
  document.documentElement.lang = getUiLocale();
}

/** Wires a toggle button (🌐) that flips es⇄en and re-sweeps the DOM. */
export function initI18n(toggleBtn) {
  applyI18n();
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      setUiLocale(getUiLocale() === "en" ? "es" : "en");
      applyI18n();
      // Re-labels enhanceSelect() triggers (ui.js), which read option text on
      // "dd:sync" but not on a plain textContent write MutationObserver misses.
      document
        .querySelectorAll("select[data-enhanced]")
        .forEach((s) => s.dispatchEvent(new Event("dd:sync")));
    });
  }
}
