// sw.js — Audiolibros service worker (network-first, cache fallback).
//
// This SW is an ES MODULE (registered with {type:"module"} in index.html) so it
// can import the SAME merge + IndexedDB helpers the page uses — the progress-sync
// logic can't drift between the page and the Background Sync handler below.
import { idbGetMeta, idbSetMeta } from "./js/db.js";
import { mergeServerMap } from "./js/progress-merge.js";
import { META_PROGRESS_KEY } from "./js/config.js";
import { getSyncServerUrlIdb } from "./js/storage.js";

// CACHE_NAME below is bumped on every shipped change so a client refreshes
// the shell; see git log for what changed and when.
const CACHE_NAME = "audiobooks-network-first-v236";

// The Piper runtime — onnxruntime-web and the espeak-ng phonemiser — is tens of
// MB and lives on CDNs the vendored library hardcodes. It is cached SEPARATELY,
// and this bucket is deliberately NOT purged when CACHE_NAME is bumped: the
// bytes are immutable (version-pinned URLs) and re-downloading ~28 MB on every
// deploy would be both slow and, on mobile data, expensive.
//
// The voice MODEL is not here — the library keeps it in OPFS, which a service
// worker cannot see. So this bucket plus OPFS together are what make a
// downloaded voice work offline.
const RUNTIME_CACHE = "audiobooks-tts-runtime-v1";
const RUNTIME_HOSTS = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com"];

// Network-first tuning. On mobile the first request after
// the app wakes can fail while the radio reconnects; retry a few times before
// giving up to the cached shell so a transient failure no longer serves stale
// code. Kept small + short so a genuinely offline load still falls back quickly.
const NET_RETRIES = 2;
const NET_RETRY_DELAY_MS = 250;
// The install precache is ~50 requests, not one, and nothing is waiting on it
// (no user is looking at a spinner), so it backs off harder than the runtime
// path before giving up and failing the install. See precacheShell().
const INSTALL_RETRY_DELAY_MS = 1000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const APP_SHELL_URLS = [
  "index.html",
  "favicon.svg",
  "manifest.webmanifest",
  "css/style.css",
  "css/_variables.css",
  "css/_base.css",
  "css/_controls.css",
  "css/_player.css",
  "css/_modal.css",
  "css/_ui.css",
  "_shared/history/backGuard.js",
  "_shared/ui/pullToRefreshGuard.js",
  "_shared/ui/holdable.js",
  "js/main.js",
  "js/config.js",
  "js/settings.js",
  "js/dom.js",
  "js/busy.js",
  "js/utils.js",
  "js/state.js",
  "js/mode.js",
  "js/version.js",
  "js/piper.js",
  // The silence cap. Pure, and applied to every rendered paragraph — missing it
  // offline would mean the voice comes back with the holes in it.
  "js/piper-trim.js",
  // The peak-handling presets. Static import of piper.js, listed with it.
  "js/modulation.js",
  // The synthesis worker. Loaded by URL, not by a static import, so no scan
  // finds it either — and without it offline the voice falls back to the
  // main-thread path, which is exactly the jank it exists to remove.
  "js/piper-worker.js",
  // Vendored Piper library. The two hashed files are pulled by dynamic import()
  // from inside piper-tts-web.js, so no static scan finds them — they are listed
  // by hand, and cache.addAll() is atomic, so a rename that misses them fails
  // the install loudly instead of breaking offline quietly.
  "vendor/piper-tts-web.js",
  "vendor/piper-o91UDS6e.js",
  "vendor/voices_static-D_OtJDHM.js",
  "js/storage.js",
  "js/db.js",
  "js/progress.js",
  "js/progress-merge.js",
  "js/progresslog.js",
  "js/logview.js",
  "js/reload.js",
  "js/pdf.js",
  "js/epub.js",
  "js/cleanForSpeech.js",
  "js/deDoublet.js",
  "js/chapters.js",
  "js/text.js",
  "js/sleep.js",
  "js/sleepPreset.js",
  "js/voices.js",
  "js/background.js",
  // The cross-window single-reader lock. Playback claims through it, so missing
  // it offline would be a page that cannot start reading at all.
  "js/solo.js",
  "js/mediakeys.js",
  "js/player.js",
  "js/library.js",
  "js/modal.js",
  "js/catalog.js",
  "js/ui.js",
  "js/encurso.js",
  "_shared/clipboard/copyText.js",
  "_shared/ui/no-select.css",
  "_shared/ui/modal-top.css",
];

/**
 * Precache the shell, retrying a transient network failure.
 *
 * `addAll` is ATOMIC and that is deliberate: a renamed vendor file must fail the
 * install loudly rather than break offline quietly. But atomic also means ONE
 * fetch rejecting — the flaky-reconnect case this file already retries for in
 * `networkFirst` — discards the whole install. The old worker stays active, no
 * takeover happens, and the next load starts the cycle again; when that one
 * succeeds it claims and the page reloads. That is one of the two producers of
 * "the app refreshed itself a couple of times before settling".
 *
 * So: same bounded retry the runtime path already uses, with a longer backoff
 * (this is ~50 requests, not one, and a tunnel that just failed us needs more
 * than 250 ms). A REAL missing file still fails every attempt and still fails
 * the install.
 */
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  let lastErr;
  for (let attempt = 0; attempt <= NET_RETRIES; attempt++) {
    try {
      await cache.addAll(APP_SHELL_URLS);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < NET_RETRIES) await wait(INSTALL_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((k) =>
            k !== CACHE_NAME && k !== RUNTIME_CACHE ? caches.delete(k) : null,
          ),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Network-first with a bounded retry, then cache fallback. cache:"no-store"
// bypasses the browser HTTP cache so the SW always hits the origin (never serves
// stale bytes the browser happened to keep). A network THROW (offline / tunnel
// warming up) retries a few times before falling back to cache; a real HTTP
// error (4xx/5xx) is authoritative and falls back immediately.
async function networkFirst(request) {
  let lastErr;
  for (let attempt = 0; attempt <= NET_RETRIES; attempt++) {
    try {
      const networkResponse = await fetch(request, { cache: "no-store" });
      if (networkResponse && networkResponse.ok) {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return networkResponse;
      }
      const cached = await caches.match(request);
      return cached || networkResponse;
    } catch (err) {
      lastErr = err;
      if (attempt < NET_RETRIES) await wait(NET_RETRY_DELAY_MS);
    }
  }
  const cached = await caches.match(request);
  if (cached) return cached;
  throw lastErr;
}

// The one URL the shell is precached under. A navigation can arrive as the
// directory ("…/audiobooks/", the manifest's start_url), with a query string, or
// with a hash — none of which match this cache key. Resolving every navigation
// to it is what lets an offline refresh open the app instead of the browser's
// network-error page.
const SHELL_URL = new URL("index.html", self.registration.scope).href;

// Every URL the install precached, absolute. The precache is atomic and lives
// under CACHE_NAME, and `activate` deletes every other bucket — so whatever is
// in there was fetched by THIS worker version and cannot be stale relative to
// it. That is what makes serving these from cache first (below) safe: the only
// way the bytes change is a new worker, and a new worker brings its own cache.
const SHELL_ASSET_URLS = new Set(
  APP_SHELL_URLS.map((u) => new URL(u, self.registration.scope).href)
);

/**
 * Refresh a cache entry in the background. Nothing waits on it: the caller has
 * already answered from cache, so a slow (or dead) network costs the user
 * nothing. Failures are swallowed — the cached copy stays, which is the point.
 */
function revalidate(request, cacheKey) {
  fetch(request, { cache: "no-store" })
    .then((response) => {
      if (!response || !response.ok) return;
      const copy = response.clone();
      return caches
        .open(CACHE_NAME)
        .then((cache) => cache.put(cacheKey || request, copy));
    })
    .catch(() => {});
}

/**
 * Cache first, then refresh in the background.
 *
 * WHY, and it is not about being offline. Android evicts the whole browser when
 * you leave it for a couple of apps; coming back, the tab is re-navigated from
 * scratch. Under network-first that meant the shell AND every module waited on
 * the network — radio wake + reconnect — before a single pixel was
 * painted: the "white for a few seconds, then the app appears" the reader sees
 * on every app switch. The bytes were sitting in the cache the entire time.
 *
 * Freshness is not lost, only deferred by one load: the browser revalidates
 * sw.js on navigation, a changed worker installs its own precache, and
 * skipWaiting + claim hand over — which index.html turns into one auto-reload.
 */
async function staleWhileRevalidate(request, cacheKey) {
  const cached = await caches.match(cacheKey || request);
  if (cached) {
    revalidate(request, cacheKey);
    return cached;
  }
  return networkFirst(request);
}

/**
 * Navigations never fail to the browser's error page — and never wait on the
 * network to paint. Serve the cached shell (under the request's own URL, else
 * the canonical key that "…/audiobooks/" and "?lan=1" both resolve to) and
 * revalidate behind it; only a cold cache — first visit, ever — goes to the
 * network, with the same bounded retry, and only that can still throw.
 */
async function navigationFirst(request) {
  const cached =
    (await caches.match(request)) || (await caches.match(SHELL_URL));
  if (cached) {
    revalidate(request, SHELL_URL);
    return cached;
  }
  return networkFirst(request);
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate") {
    event.respondWith(navigationFirst(event.request));
    return;
  }

  const url = new URL(event.request.url);
  if (url.searchParams.has("_bust")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  // The progress blob is mutable state, not a cacheable asset. A stale cached
  // read would make the app believe progressReady=true and push over fresher
  // data, so this is network-only: an offline GET fails cleanly instead. Other
  // /kv/* blobs stay cacheable. Same for the single-reader claim — a cached
  // copy would be a stale claim, pausing a book nobody took or hiding one
  // that was made.
  if (
    url.pathname === "/kv/audiobooks-progress" ||
    url.pathname === "/kv/audiobooks-reader"
  ) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  // The precached shell — every module, stylesheet and icon the app boots on.
  // Cache first so a restored tab paints immediately instead of waiting on the
  // network for ~50 requests; the background revalidate keeps the bucket warm.
  if (SHELL_ASSET_URLS.has(url.href)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // Piper's WASM runtime: cache-FIRST, unlike everything else here. These URLs
  // are version-pinned and immutable, so there is nothing newer to look for, and
  // network-first would re-fetch megabytes on every cold start. This is also
  // what lets a downloaded voice speak with no connection at all.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(networkFirst(event.request));
});

/**
 * Serve from cache, else fetch and keep it. Opaque responses (these are
 * cross-origin, no-cors) are stored too: they cannot be inspected, but they
 * replay fine, which is all the WASM loader needs.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: RUNTIME_CACHE });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === "opaque")) {
    const copy = response.clone();
    caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

// ===================== Background Sync (push while closed) =====================
// Chromium fires this even with the browser/tab fully closed, once connectivity
// returns. Read the durable progress map from IndexedDB (the page mirrors it
// there on every edit) and, if it still holds unconfirmed edits, pull-merge-push
// it to the server (ts-aware merge PATCH, never a destructive whole-blob PUT).
// Registered from js/progress.js on any failed push.
self.addEventListener("sync", (event) => {
  if (event.tag === "flush-progress") {
    event.waitUntil(flushProgressOnSync(event));
  }
});

async function flushProgressOnSync(event) {
  let meta;
  try {
    meta = await idbGetMeta(META_PROGRESS_KEY);
  } catch (_) {
    return; // no IDB → nothing to do here; the page re-pushes on next open
  }
  if (!meta || !meta.map || !meta.dirty) return; // nothing unconfirmed to push

  // No sync-server URL set → IndexedDB is the only store there is, and it
  // already holds this map. Nothing to flush to.
  const base = await getSyncServerUrlIdb();
  if (!base) return;

  try {
    // Pull the server blob and merge (newer ts per book wins) IMMEDIATELY before
    // the PUT, to minimise the lost-update window vs a live tab. A failed/!ok GET
    // must NOT authorise a PUT (that would overwrite the store with our partial
    // map) — throw so Chromium retries with backoff.
    const r = await fetch(`${base}/kv/audiobooks-progress`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) throw new Error("progress GET " + r.status);
    const server = await r.json();
    const merged =
      server && typeof server === "object" && !Array.isArray(server)
        ? mergeServerMap(meta.map, server)
        : meta.map;

    // Push our edits as a ts-aware MERGE, never a destructive whole-blob PUT — so
    // even the background-sync path can only add/advance books, never wipe the
    // store with a partial map. The server folds `meta.map` into whatever it
    // holds; `merged` is only for refreshing the durable IndexedDB mirror below.
    const push = await fetch(`${base}/kv/audiobooks-progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _op: "progress_merge", entries: meta.map }),
    });
    if (!push.ok) throw new Error("progress merge-push " + push.status);

    // Confirmed on the server → clear the dirty flag so we don't re-push it.
    await idbSetMeta(META_PROGRESS_KEY, { map: merged, dirty: false });
  } catch (err) {
    // Still offline / server down. Retry unless this was the final attempt; on
    // the last chance leave dirty=true so the next app open pushes it (the map
    // stays durable in IndexedDB either way).
    if (!event.lastChance) throw err;
  }
}
