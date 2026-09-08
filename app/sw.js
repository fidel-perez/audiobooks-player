// sw.js — Audiolibros service worker (network-first, cache fallback).
//
// This SW is an ES MODULE (registered with {type:"module"} in index.html) so it
// can import the SAME merge + IndexedDB helpers the page uses — the progress-sync
// logic can't drift between the page and the Background Sync handler below.
import { idbGetMeta, idbSetMeta } from "./js/db.js";
import { mergeServerMap } from "./js/progress-merge.js";
import { META_PROGRESS_KEY } from "./js/config.js";

// BUMP CACHE_NAME on any shipped change to force clients to refresh the shell.
// v1: initial modular refactor (was the single-file lector-pdf-v14.html) —
//     ES-module split, dark/light theme, PWA shell + favicon.svg for the hub.
// v2: accept .txt and .md files too (new js/text.js module).
// v3: sleep mode — black-screen + motion "still awake?" check (js/sleep.js).
// v4: compact UI redesign — settings moved into a ⚙️ modal (js/modal.js),
//     server-library browser (js/biblioteca.js), css/_modal.css.
// v5: renamed lectorpdfapp → audiobooks (new DB/localStorage keys, no
//     migration) + EPUB support via a dependency-free parser (js/epub.js).
// v6: live favorites — per-book ⭐ degree control stored in json-store
//     (audiobooks-favorites KV, merged onto the frozen catalog at runtime);
//     js/biblioteca.js + css/_modal.css.
// v7: UI trim — mobile modal ✕ reachable (dvh), persisted biblioteca filters +
//     🎲 random-in-filter, default speed 200% (80–300%, persisted), dropped the
//     "Ir a" panel, tab strip / "borrar todos", and the párrafo/stop/random/
//     libro transport; sleep mode no longer auto-plays; progress mirrored to
//     json-store (audiobooks-progress KV).
// v8: sleep mode goes fullscreen + instant black on tap (was a 10 s delay),
//     stop interval 20–60 min (5-min steps, live-updates mid-session); dark
//     mode + theme toggle removed (js/theme.js gone, app is light-only).
// v9: auto-skip front/back-matter chapters (js/chapters.js) — starts at the
//     first real chapter, stops at the last; skipped titles greyed in the
//     picker; %/time/random confined to the body span.
// v10: liked/disliked + author favorites (js/reactions.js) — per-book 👍/👎 and
//     an author ⭐ that lifts all their books, both live in json-store
//     (audiobooks-reactions / audiobooks-fav-authors); a static seed carries the
//     operator's initial picks. New 👍 filter chip; dislikes sink to the bottom.
// v11: in-page confirm dialog + custom <select> pickers (js/ui.js,
//     css/_ui.css) — dismissable without committing a choice (native <select>
//     can't on iOS); 🎲 random no longer writes status when cancelled.
// v12: 📖 "en curso" modal (js/encurso.js) — progress monitor + play queue;
//     a book's ⏭️ control queues it (json-store audiobooks-queue), a natural
//     end auto-advances to the queue head else a filtered 🎲 random; finished
//     books tracked in the progress blob; fiction categories sort last.
// v15: auto-refresh on deploy — index.html forces reg.update() on load and
//     reloads once on controllerchange, so a push shows up on the next refresh
//     instead of needing several (skipWaiting + clients.claim already fire the
//     controllerchange this relies on). No app-logic change.
// v18: play/pause fixed-size box; 📚/🎲 preload catalog+favorites on load;
//     sleep minutes remembered (default 40); OFFLINE progress mirror to
//     localStorage + push-on-next-online-open; 🎲 random prefetch buffer (10
//     books ahead, wiped on filter/category change, serves instantly offline).
// v19: multi-device sync — the play queue is now an atomic json-store list
//     ([{id}] via PATCH append / remove_by_id) so two devices no longer clobber
//     each other's adds (the old full-blob PUT was last-writer-wins). The 📖
//     "en curso" shelf now unifies local docs with catalog books in progress on
//     OTHER devices (☁ rows, reopened from the raspi library on tap), so it
//     reads as one page across devices. MUST refresh both devices to this
//     version — an old client's legacy `{list}` PUT breaks the new atomic ops.
//
// v22: safer progress sync + honest en-curso list. Progress is pushed ONLY
//      after a confirmed server READ, so a failed GET during a deploy can no
//      longer PUT an empty/partial map over the store (books "overwritten to
//      zero"). The 📖 en-curso rows show the REAL % instead of a forced 100%
//      for `done` books (fixed "100% here but opens at 1%"), and titles wrap in
//      full instead of ellipsis-truncating. The queue auto-advance now removes
//      only the book it plays — a catalog hiccup can't drain the whole queue.
//
// v23: category dropdown no longer lies. When a persisted category slug is no
//      longer a real <option> (catalog rebuilt / taxonomy changed), the biblio
//      <select> silently fell back to "Todas" while the filter kept narrowing —
//      you'd see e.g. "358 libros" under "Todas las categorías". applyFilterUI
//      now reconciles: unreachable category → drop the filter and honestly show
//      every category, so the dropdown and the list always agree.
//
// v24: a reload reopens the book you were on (audiobooks_active_key), not always
//      docs[0]; tapping any biblioteca book now SELECTS it (was: silently added
//      behind the current one).
//
// v25: "libros abiertos" long-press popover. A row's inline 🗑 is replaced by a
//      right-click / long-press popover matching the biblioteca — the same
//      rating controls (⭐/👤/👍/👎) plus 🧹 "clear progress" (back to 0%, into
//      the random pool) and 🗑 remove. Finished books stay listed but greyed
//      until rated + removed. A local row now shows the FURTHEST position reached
//      on any device (merged json-store `pos`) and resumes there. The biblioteca
//      ✔ "terminados" filter (and the random-exclusion) now also count books
//      read to 100%, not only those explicitly marked done.
//
// v26: one unified book card + right-click/long-press menu everywhere. Every book
//      card (biblioteca list, 🎲 spotlight, active-book card, author list, and the
//      en-curso "libros abiertos" shelf) now shares the same status border/
//      background cue and the SAME menu (⭐/👤/👍/👎 rating · ⏭️ queue · 🧹 clear ·
//      🗑 remove, showing what applies to the book's state). Left-click still
//      differs by place (author's works / select / resume). Card text is now
//      non-selectable so a long-press opens the menu instead of grabbing the
//      title (and iOS no longer pops its text callout).
//
// NOTE: pdf.js is loaded from a CDN (see index.html) and is intentionally not
// part of this shell — the app already needs the network for the online TTS
// voices, and cross-origin bytes are left to the browser's HTTP cache. EPUB,
// by contrast, is parsed in-shell (js/epub.js, no CDN) so it works offline.
// v27: finer manual controls + reliable author page. The progress bar now opens
//      a seek modal (drag slider + ±1/5/10/15/20 % fine steps, then "Ir"); the
//      speed row opens a modal with the same ±% steps + a Cancelar that reverts
//      (✕ keeps the live change), replacing the inline 🐢/🐇 steppers. The chapter
//      picker now reflects the current chapter instead of staying on "— Selecciona
//      capítulo —". And tapping the active-book card opens the author's works
//      reliably: ensureCatalog retries after an offline boot and the card
//      re-resolves the book at click time (was: opened only once, randomly).
// v29: hands-free sync + one card + fixes. The 🌅 "push state" button is gone —
//      progress auto-syncs when the screen comes back on, and a persistent
//      banner ("guardando… activa Internet") shows + retries whenever unsynced
//      progress can't reach the server, so you just enable data and it flushes.
//      The 15-min rewind moved to the sleep auto-stop (you doze off → it steps
//      back automatically; no button). Every book card now runs through ONE
//      builder (same borders + ✔ cue + right-click menu everywhere) and the menu
//      confirms EVERY rating action. A book's author is stashed on the doc at
//      load (incl. the 🎲 prefetch path, which used to drop it) so the author
//      page works even if the catalog can't resolve it — no more spurious "Este
//      libro no tiene autor". A queued book survives a reload (self-healing
//      migration of a legacy {list} key + PUT fallback), opening a catalog book
//      registers it on the shared "en curso" shelf immediately (cross-device),
//      and the speed control lives in the ⚙️ settings modal (no separate modal).
// v30: fresh over Tailscale, not just over the LAN IP. The SW only runs in a
//      secure context, so it exists ONLY on the HTTPS tailnet face
//      (https://<pi>.<tailnet>.ts.net:10000/…) — over plain http://<ip>/… it
//      never registers, which is why the IP face always showed fresh code while
//      the tailnet face looked "cached". Two changes make the tailnet face as
//      fresh as the IP one: (a) the network-first fetch now uses cache:"no-store"
//      so it can never read stale bytes from the browser HTTP cache (Caddy sends
//      no-store already; this stays honest if that header ever regresses), and
//      (b) it retries the network a couple of times before falling back to the
//      cached shell — on mobile the FIRST request after the app wakes races the
//      tailnet tunnel coming up, that fetch throws, and the old code then served
//      the stale cache (app looked un-updated until another refresh). The LAN is
//      always up so it never hit that path. Bumping the cache name also forces
//      one clean shell refresh on every SW-controlled device on next load.
// v34: never-lose-progress sync revamp (part 1). The mutable progress blob
//      (GET /api/audiobooks-progress) is now NETWORK-ONLY — the network-first
//      handler used to cache every OK GET, so an OFFLINE boot got a stale cached
//      200 and treated it as a real server read (progressReady=true), then could
//      push over fresher data. Now an offline GET fails cleanly and the app stays
//      honest. Bumping the cache name also purges the already-poisoned progress
//      entry from every SW-controlled device on next load. (Client side: an
//      immediate keepalive flush on pagehide / visibilitychange→hidden replaces
//      the online-event + background-timer retry Chromium kills once the browser
//      is closed — see js/progress.js flushNow + js/main.js.)
// v35: never-lose-progress sync revamp (part 2). The SW is now an ES module and
//      handles a `sync` event (tag "flush-progress"): it reads the durable
//      progress map from IndexedDB (js/db.js) and, if it still holds unconfirmed
//      edits, pull-merge-pushes it to the server (ts-aware merge PATCH, never a
//      whole-blob PUT) — even while the browser/tab is
//      CLOSED. So a session read offline then closed uploads the moment data
//      returns, before you reopen. Shares mergeServerMap (js/progress-merge.js)
//      with the page so the merge can't drift. Registered from js/progress.js on
//      any failed push; feature-detected (graceful no-op where unsupported).
// v36: PWA install. Add manifest.webmanifest (linked in index.html) + a
//      navigator.storage.persist() request, so the app installs to the home
//      screen and always reopens the one storage-durable, offline-capable
//      origin (the HTTPS :10000 face). Precache the manifest with the shell.
// v41: day/night en-curso shelves + "última actualización" + trash fix. The 📖
//      modal now has a 🌙/☀️ toggle (js/mode.js): night and day each keep their
//      OWN libros abiertos + en cola (a book's shelf travels with its progress /
//      queue entry; untagged ⇒ night), and the 📖 top-bar button is tinted
//      blue/yellow to match. ⚙️ Ajustes shows how long ago the running code was
//      built (js/version.js) and flags a newer server version. 🗑 on a "libros
//      abiertos" row now forgets the synced progress too, so a removed book no
//      longer re-lists as ☁ "en curso" after a refresh.
// v45: kill the last data-loss overwrite. Progress is now pushed as a ts-aware
//      MERGE (json_store `progress_merge`) on EVERY path — the page flush, the
//      pagehide keepalive, AND this SW background sync — so a stale/half-loaded
//      in-memory map can only add or advance books, never wipe the ones it
//      hadn't loaded (the "a refresh overwrote my open books/queue with a
//      smaller set" bug: a live device kept re-PUTting its partial map). Book
//      removals go through an atomic `{docKey:null}` delete PATCH; the queue's
//      whole-list write (reorder/migration) now re-reads the server and folds in
//      any missing entries before writing, so it can't drop a queued book
//      either. New js/settings.js mirrors the global speed to the server
//      (audiobooks-settings) via atomic per-key PATCH so it survives a storage
//      wipe + syncs across devices. MUST refresh every device to this version.
// v48: the reload keeps your book, and ⏮/⏭ stop being a mistap. Boot hydrates
//      each stored doc independently (one corrupt record no longer wipes the
//      whole library) and, when IndexedDB comes back empty but we still know the
//      last-active docKey, re-downloads that book from the raspi library using
//      the `src` in the synced progress map — so an evicted IndexedDB (storage
//      pressure, a week-old PWA) no longer opens to an empty player. The ⏮/⏭
//      paragraph steps moved off the player into the 📍 Posición modal, where
//      they still act on press (everything else there waits for "Ir a esta
//      posición"), and that modal's head now clocks the pending position in
//      hh:mm against the book's body length.
// v50: 🌠 wishlist (js/wishlist.js) — books the library doesn't have, kept in the
//      `audiobooks-wishlist` blob and pruned the moment the catalog answers for
//      them (the app on load, the Telegram EPUB ingest server-side). 📋 copies the
//      whole taste profile (⭐/👍/👎/👤 + 🌠) as Markdown for an LLM (js/profile.js).
// v51: a refresh no longer lands on top of an in-flight progress upload. Both
//      reload paths (the build line, and a new SW claiming the page) go through
//      js/reload.js: while the map is unsynced the reload is HELD, the banner says
//      "⏳ Subiendo progreso… se recargará al terminar", and a pull+push fires at
//      once — so an online device confirms and reloads itself, while an offline
//      one keeps nagging instead of silently aborting the push.
// v52: the offline book buffer. Book FILES are now downloaded ahead of time into
//      IndexedDB (DB v3, `files` store) rather than only into an in-memory 🎲
//      buffer that a reload threw away: every book in the ⏭️ queue and every
//      cross-device "en curso" book is pinned and kept, a short queue is topped
//      up to 10 with random picks from the current filters, and anything that
//      leaves the queue/shelf/filters is deleted. So a book started offline
//      auto-advances into the next queued book with no network at all. NOT the
//      SW Cache Storage: that is purged on every CACHE_NAME bump (i.e. every
//      deploy), which is exactly the wrong lifetime for a night's reading. The
//      modals also fill to the top of the screen (no dead gap above the sheet).
// v53: an offline load opens the app, not the browser's error page. A navigation
//      to the PWA's start_url ("." → ".../audiobooks/") never matched the
//      precached "index.html" cache key, so networkFirst threw and the browser
//      painted "connect to the Internet" — the app was uninstallable-feeling and,
//      worse, the reconnect reload in js/reload.js landed on it (the `online`
//      event fires when the radio associates, before the route is usable: the
//      progress PATCH squeezed through, the shell fetch didn't). Navigations now
//      fall back to the cached shell by its canonical URL, so a refresh with no
//      network at all opens the reader with its IndexedDB books.
// v59: cross-device "libros abiertos" recovery + offline parity + blob hygiene.
//      (1) A library book whose progress entry lost its catalog `src` (opened
//      before src-stamping, through the offline folder-browse, or dropped by the
//      old ASYMMETRIC merge) never showed on another device's shelf — a remote
//      row needs the `src` to re-download the file. mergeServerMap (page + this
//      SW) and the server progress_merge now preserve `src` SYMMETRICALLY, and
//      the catalog load backfills the path onto stranded entries by matching the
//      stored filename → (title, author), unambiguous only. (2) The progress map
//      is now sanitized on every ingest (localStorage / server GET / IDB mirror):
//      a raw-stored progress_merge body left `_op`/`entries` masquerading as books
//      — stripped so junk can't enter the shelf or ride back up on a push. (3) The
//      🔜 "en cola" list now stays populated OFFLINE (stub cards derived from the
//      cached queue paths) instead of emptying when the 14 MB catalog is out of
//      reach. MUST refresh every device to this version.
// v60: actively SCRUB the `_op`/`entries` pollution off the SERVER blob on pull
//      (a null-PATCH delete), not just ignore it locally. progress_merge is
//      additive so it never removes the key; a still-running old client keeps
//      re-adding it. Now any up-to-date client that opens the store deletes it,
//      and no up-to-date client re-adds it — self-healing to a clean blob.
// v62: the 🔜 cola stops eating your progress, and ✅ stops hiding your book.
//      (1) Queueing a book no longer rewinds it: it leaves "libros abiertos" for
//      "en cola" and that is ALL — position, ✅ and hours-played survive, and
//      reopening it picks up where you were (loadSavedPos falls back to the synced
//      entry now that the local copy — and its localStorage offset — is unloaded).
//      A queued book is filtered OUT of "abiertos" so it can't sit on both lists.
//      (2) ✅ terminado no longer takes a ☁ row off the shelf — it greys it, like a
//      local one; only 🗑 removes. (3) The book menu's 🔜 toggle is replaced by
//      🔝 / ⬇️ (queue first / queue last, re-seating a book already queued), on
//      a second row with 🗑. (4) Every action that moves a book off a shelf now
//      confirms (incl. the "en cola" 🗑, which used to unqueue on a mistap), and
//      the confirm copy is a label + the book, not a paragraph.
// v64: "libros abiertos" stops reshuffling itself. The shelf was ordered by the
//      progress entry's `ts` — the LAST-EDIT stamp — so 🧹 limpiar, ✅ terminado,
//      a rating, even the position autosave, all yanked the row they touched to
//      the top; and local rows didn't sort at all (they sat in IndexedDB load
//      order, above the ☁ ones). The open time is now its OWN field (`openedTs`,
//      stamped only by registerOpenBook — i.e. by actually opening a book) and
//      the shelf is ONE list ordered by it, local ▶ and cross-device ☁ rows
//      interleaved. It is merged like `played` (keep the larger, independent of
//      `ts`) on the page, in this SW and in json_store's progress_merge, so the
//      shelf reads the same on every device and no edit pushed from one device
//      reorders another's. Entries written before the field fall back to their
//      `ts` once, pinned on the first edit so that edit can't move them.
// v65: 🗑 remove now propagates across devices. A delete used to hard-remove the
//      key; any other device still holding the book re-pushed it (the additive
//      progress_merge never removes a key) and it resurrected on the next refresh.
//      A delete now writes a `{deleted:true, ts}` TOMBSTONE that rides the same
//      ts-merge — a newer tombstone drops the book on every device, a newer
//      re-open resurrects it. Every read (shelf, finished set, resume, heal)
//      skips tombstones, and a book trashed elsewhere but LOADED here is evicted
//      on pull (`reconcileDroppedDocs` → `audiobooks:dropped` → `evictDroppedDoc`,
//      never the active/playing doc). This SW pushes tombstones like any entry.
// v68: an OPEN app no longer destroys another device's reading. `saveProgress`
//      runs every 5 s off a watchdog and used to stamp a FRESH `ts` even when the
//      position had not moved — and since every merge keeps the newer `ts` per
//      book, an idle tab re-crowned itself the newest writer every 5 seconds and
//      permanently outranked the device actually reading. Measured live: a laptop
//      left open at 25% wiped a phone that had read on to 60% within a second of
//      being reopened. An unchanged position is now a NO-OP (no ts, no push).
//      Resume is also ts-aware (`loadSavedPlace` takes the newer of this device's
//      offset and the synced entry, instead of always preferring local), and every
//      activation adopts the furthest place any device reached
//      (`adoptAheadPlace`; `reconcileAheadDocs` → `audiobooks:ahead` →
//      `adoptAheadDocs` covers the pull-lands-after-boot race) — never yanking the
//      book that is currently playing. `syncedProgressFor` now carries `off`, so
//      adopting another device's place lands on its WORD, not just its paragraph.
// v69: Background Sync can no longer sleep through an offline edit. The page
//      mirrors the progress map to IndexedDB as `{map, dirty}`, and
//      `flushProgressOnSync` below pushes ONLY when it reads `dirty:true` — but
//      `pushProgressStore` persisted the map BEFORE setting `unsynced`, so the
//      first edit after a synced state was mirrored with a stale `dirty:false`.
//      Go offline, jump one chapter, close the tab: the SW woke on reconnect,
//      read "already confirmed", and pushed nothing. (A second edit masked it.)
//      Same ordering bug in `dropProgress`, where a delete tombstone was the
//      casualty. Flag now precedes persist at both sites.
// v70: an offline binge no longer stops at the first unbuffered book. The
//      end-of-book advance walked to the next volume in the FILTER LIST whether
//      or not its file had been downloaded; offline that open dies on the
//      folder-list fetch, so the night ended there with the rest of the buffer
//      unread (reproduced against the live app: it stalled on "Luna negra" with
//      four downloaded books still in IndexedDB). Offline, every candidate — the
//      queue, the next volume, the random pick — is now filtered to what the
//      buffer holds; an unbuffered queued book STAYS queued for when there is a
//      network again. And since navigator.onLine cannot see a dead tunnel, any
//      open that fails also falls back to a buffered book.
// v71: the car / Bluetooth transport layer is GONE. Its ⏭ was a RANDOM JUMP
//      INSIDE the book that saved the new position immediately and pushed it to
//      every device (jumpRandomPct → jumpToPct → jumpToChar → saveProgress): one
//      mispressed steering-wheel key destroyed your place, with no confirm and no
//      undo. ⏮ swapped to a random other book. Both go, and the whole MediaSession
//      layer with them — the seven setActionHandlers, the media metadata /
//      notification, and the ±1% seek (stepPct, whose only callers were the car's
//      seek keys; the 📍 Posición modal already has ±1% behind "Ir a esta
//      posición"). The app no longer answers headphone or car transport keys; ▶ Play
//      on screen is the only transport.
// v72: trashing (🗑) — or queueing (🔜) — the book that is READING no longer starts
//      a DIFFERENT book playing. Removing the active doc activates its neighbour,
//      and activateDoc reads `state.speaking` as "keep reading", so the removal
//      handed the voice to whatever book sat next to it on the shelf — one the
//      operator never chose, and which the stall watchdog then kept alive. Playback
//      is now torn down before the neighbour is activated.
// v73: the app stops talking to itself. While a book was loaded the active-book
//      card covered #status, so every setStatus — the whole end-of-book
//      auto-advance, the load errors, the sleep notices — was written into a
//      hidden div: a book ended and another one started reading at you with
//      nothing on screen to say why. A #toast slot under the card is now the
//      visible status surface (one funnel: dom.js setStatus toasts whatever the
//      card is hiding), and the auto-advance shows "▶ Ahora: «X»" for 20 s with a
//      ↩ back to the book that just ended — which re-queues, at the head, the
//      queue entry the advance had already spent. ▶/⏸ lost their status echoes:
//      they'd have become a popup on every tap.
// v74: the biblioteca no longer opens silently filtered to male authors — the
//      ♂/♀/⚥ chip defaults to ⚥ (a persisted blob still carrying the old ♂
//      default is migrated once, then stamped), and the 🎛️ badge names the
//      filters that are on ("♂ ⭐") instead of counting them.
// v75: the confirm budget, spent forwards. ⭐/👤/👍/👎 no longer ask — they are
//      one-bit toggles you undo with the same tap, and the card's ring/tint is the
//      receipt — while ✅ terminado now asks in both directions: marking it pulls
//      the book out of the 🎲 random pool and off the offline buffer's pin set,
//      which a silent tap had no business doing.
// v76: the author on every book card is a tappable "📚 <autor> ›" chip that opens
//      that writer's other books. The only route there used to be LOADING one of
//      their books first, which swaps the book you are on.
// v77: browsing the biblioteca, not just searching it. The 88k-book list pages
//      300 at a time, so the ‹/› pager alone was ~175 taps to the Z's. An A–Z
//      strip under the count now jumps straight to an author-initial's page
//      (alphabetical order only — the date sorts scatter the initials).
// v78: "libros abiertos" was a graveyard — most of its rows were books already
//      ✔ terminado. The finished ones now fold into a collapsed "✔ Terminados"
//      section (with a count) between the shelf and the queue. They are NOT
//      pruned: a read book is how you get back to its author, and pruning stays
//      a hand job (🗑, from the long-press menu). ✅ sends one straight back up.
// v79: the biblioteca is a browse SESSION. Opening a book closes it, and half the
//      time the book doesn't take — so the page, the list scroll, the 🎛️ drawer
//      and the 🎲 spotlight now survive the close and come back on the next 📚.
//      Only a change to the filter SET rewinds them. An in-place repaint (a ⭐/🔜/
//      ✅ from the long-press menu) no longer throws you to the top either.
// v80: the book card is ONE box again — title + author + saga in the same frame,
//      with the author still tappable (a <span role="link">, not the sibling chip
//      that split every card in two). The long-press menu's ❓ key was painted on
//      every menu (a `display: flex` rule outranked its `hidden` flag) and swapped
//      the buttons away when tapped; it now unfolds BELOW them, and starts folded.
//      ✔ Terminados is a bordered white bar — it was a whisper guarding a closed
//      fold, so the books behind it went unseen.
// v81: "En curso" revamp. The active book now heads its own "Libro en progreso"
//      section at the top of the 📖 modal and leaves "Libros abiertos" (no book is
//      in both). Tapping the main active card opens that modal (not the author
//      page); when no book is loaded, its slot shows a button that opens it too.
//      Author-browse moved OFF the card: the author line is a plain caption on
//      every card, and "more by this writer" is the new 💬 on the right-click
//      menu's second row (before 🗑). That menu docks to the TOP of the screen now,
//      not the bottom.
// v86: text cleaned at IMPORT is frozen in IndexedDB, so every speech rule
//      shipped since a book was added had no effect on it — "27 000" was still
//      stored verbatim and still read "veintisiete cero cero cero" long after
//      the space-grouped-number pass landed. The engines now re-clean each
//      paragraph at speak time (speechTextFrom): idempotent, so it is free for a
//      new book and a retrofit for an old one, and it touches no stored offset.
//      Also: opening a book now pre-renders the paragraph ▶ would start on, so
//      the first press plays instead of waiting on synthesis.
// v87: an unreachable pi no longer reads as "the app lost my books". Opening 📖
//      awaited ensureCatalog() BEFORE the first paint, and that fetch (~14 MB,
//      over the tailnet) was untimed — a tunnel that has associated but is not
//      routing yet accepts the request and never answers, so the await never
//      settled, paintOpenBooks never ran, and BOTH lists sat as the bare markup
//      index.html ships: no rows and not even the "no hay libros / cola vacía"
//      text. The memoised catalogPromise made it stick for the whole session.
//      Reported 2026-07-18 as "lost track of all my libros abiertos y en cola",
//      with the server blobs fully intact (18 live progress entries, 7 queued);
//      it came back on a shelf toggle, which only worked because the toggle
//      re-runs renderEnCurso after the hung fetch had finally settled. Now: the
//      catalog fetch is capped (AbortSignal.timeout, 30 s), renderEnCurso paints
//      from cache FIRST and only then touches the network, and a failed refresh
//      says "⚠️ No se pudo contactar con el servidor" instead of showing an
//      empty shelf. An empty list must always be a FACT, never a timeout.
// v88 is a MANDATORY bump even though no shell file changed: the COOP/COEP pair
// that makes Piper multi-threaded (see the Caddyfile) rides on the DOCUMENT's
// response headers, and a client still replaying the v87 index.html would serve
// the pre-header copy and stay single-threaded forever. The bump forces one
// fresh network fetch, after which the cached document carries the headers and
// the page is cross-origin isolated offline too.
// v89: a pull-down at the top of the transcript no longer reloads the app,
//      killing playback and the loaded voice model. css/_base.css already set
//      overscroll-behavior-y: contain, which is the documented fix and works on
//      Chromium — but WebKit ships the property while deliberately refusing to
//      let it cancel the top pull-to-refresh gesture, so on iOS Safari the CSS
//      was silently doing nothing. The new shared _shared/ui/pullToRefreshGuard.js
//      keeps the CSS and adds the touch guard WebKit needs, and is installed by
//      all three apps so the behavior is one rule, not three.
// v90: category headers in the «Book and author» modal gained a 🔝 / ⬇️ pair
//      that queues the WHOLE section. Shell change (index.html gained the modal's
//      own #authorToast slot, which is where the "N libros a la cola" receipt and
//      its ↩ Deshacer land — #toast sits under the player card, which the modal
//      covers).
// v97: the app no longer refreshes itself two or three times before settling.
//      Three sources, all of them capable of producing a reload the user did
//      not ask for: install's cache.addAll had no retry, so one failed fetch on
//      a warming tunnel discarded the whole precache and the next load redid
//      the install→claim→reload cycle (now retried, see precacheShell); nothing
//      capped the SEQUENCE of automatic reloads, since both latches are
//      per-document (index.html now keeps a sessionStorage budget: one
//      automatic reload per tab per 30 s); and the ⚙️ "nueva versión" flag
//      compared this bundle's APP_BUILD against sw.js's Last-Modified, which a
//      `git pull` rewrites on every deploy, so it invited a manual refresh onto
//      already-current clients (js/main.js now reads the APP_BUILD stamp out of
//      the served js/config.js instead).
// v98: the UI stops assembling itself in front of the reader. The active-book
//      card is stamped with its finished appearance (rating ring/tint, 📚 author
//      count, saga, provenance) so a cold boot paints it complete instead of
//      bare-then-decorated, and an unchanged repaint no longer swaps the DOM
//      node; the card slot holds an explicit "⏳ Abriendo tu libro…" state until
//      boot decides, instead of claiming "elige un libro" before the library is
//      read; and 📚 is on the bar from the first frame, opening onto a loading
//      state when pressed before the catalog lands.
// v99: the CDN pdf.js tag is `defer` — a parser-blocking cross-origin script
//      sitting above js/main.js made every cold load wait on cdnjs before the
//      app could start. Order (and so `window.pdfjsLib`) is unchanged.
// v106: 🌙⇄☀️ shelf-move button in the book menu's row 2 (día↔noche), shown for a
//       book on «En curso»; and the active «Libro en progreso» is now per-shelf
//       (shown only on its own día/noche estantería) instead of on both.
// v108: the «Book and author» modal is a breadcrumb trail — tapping a book inside
//       it re-renders in place and back walks book-by-book (restoring each list's
//       scroll) before closing at the root (js/biblioteca.js, js/modal.js).
// v110: the precached shell (navigation + every listed module/stylesheet) is
//       served cache-FIRST with a background revalidate. Android evicting the
//       browser re-navigates the tab from scratch, and network-first made that
//       restore wait on the tailnet before first paint — seconds of white page
//       on every app switch, with the bytes already cached.
// v120: the sync banner is tappable — a tap forces an immediate pull-then-push
//       (js/progress.js retrySyncNow) instead of waiting out the 6s retry tick,
//       for "I'm back online but the banner is still up". Cause texts gained a
//       «toca para reintentar» hint.
// v121: the Caddy redirect now lands LAN clients on the https deSEC origin
//       instead of the tailnet, and the injected window.__PI_HOSTS__ gained
//       lanHttps. The shell changed, so the old precache must not survive.
// v122: main.js now installs the secureFace prefer-LAN downgrade — a client
//       already secure on the tailnet at home hops DOWN to the LAN https face
//       (no VPN; same-origin /api backup then rides the LAN too). Shell bytes
//       changed, so the old precache must not survive.
// v123: the ▶ press and 📚 open now raise a centered, BLOCKING overlay while
//       they are genuinely slow (Piper synthesis; the warm library's 88k render)
//       and swallow taps for that window — the fix for the offline "two players
//       intertwined" report, where repeated ▶ taps queued a second reader. The
//       unplanned corner minispinner on 📚 (boot warm-up + open) is gone.
//       busy.js/_base.css/biblioteca.js/player.js changed — refresh the shell.
//       ALSO fixes a v122 gap: _shared/net/secureFace.js (imported by main.js
//       since the secureFace commit) was never added to APP_SHELL_URLS, so an
//       offline launch would have failed at module-load. Added below.
// v124: kill the LAST per-control rings. The filter/sort chips now raise the same
//       centered overlay as ▶ and 📚 (withBusyOverlay, revealed + painted before
//       the synchronous 88k re-filter). markBusy/withBusy and the `.is-busy` CSS
//       are gone — one spinner in the app, never a spinner inside a button.
// v125: streamlined ⚙️ Ajustes — every section is a collapsible <details class=
//       "fold"> (custom caret, no more full-row native ▸), folded ones carry a
//       value badge (😴 config, 📈 horas acumuladas), all prose hidden behind a
//       bottom ℹ️ toggle, the "barra espaciadora" line is gone; 📈 log drops the
//       "sin lectura" rows + the 7-día total; volume persists on `input`.
// v126: ALL sections now fold closed to start (Volumen/Velocidad too). 📈 Registro
//       renders INLINE on expand (no button, no separate modal) with a visible
//       "Total escuchado" headline; the standalone progress-log modal is gone.
// v129: book-menu rows regrouped — row 1 = TOGGLES (⭐👤👍👎 ✅ 📖), row 2 =
//       ACTIONS (▶️ 🧹 🗑 🌙☀️ 🔜). The 📖 leído button finally gets its green
//       styling (the .leido class had none → always grey) and its cue tracks
//       entryFinished (done OR genuine 100%), so a finished book shows 📖 green.
//       Active-mark wash is a louder, more saturated green.
// v130: right-clicking the ACTIVE book card showed no ⭐👤👍👎 rating toggles —
//       the card painted on a cold boot bound its menu to a _local stand-in, which
//       isCatalog gates out. buildActionHeader now upgrades a _local book to the
//       real catalog entry when its path resolves, so the toggles come back.
// v137: the backup-wifi face. secureFace.js now knows a THIRD secure origin (the
//       deSEC sibling name bound to the Pi's wlan0 address) and — the actual bug
//       — probes the CURRENT face instead of trusting it. THIS worker is why the
//       bug existed: it serves the shell from cache, so the app opened fine on
//       the wired deSEC name after the phone moved to the Starlink AP, while
//       every /api call failed against a host it had no route to. The sync
//       banner stops blaming Tailscale for it. Both the module and the shell
//       that receives the injected window.__PI_HOSTS__ changed, so without a
//       bump an installed client keeps precaching the two-face version forever.
// v138: /api calls now travel through _shared/net/transport.js, which picks a
//       FACE per request instead of the document hopping origins to change
//       networks — the hop is what kept resetting this app's IndexedDB to empty.
//       The face list moved to _shared/net/faces.js so both share ONE preference
//       order. Both are new imports of the shell, and an uncached import is not a
//       partial failure — the shell dies at module-load offline — so this bump is
//       mandatory. The transitive scan that caught it also surfaced a LATENT gap
//       of the same shape, uncached here since the v123 secureFace commit:
//       _shared/net/offlineChrome.js, which secureFace.js has always imported.
//       An offline launch has been one module-resolution away from dead since
//       then; only the network-first shell fetch usually beating the cache hid
//       it. Both are added below.
// v139: transport.js now sends through _shared/platform.js, the seam that lets
//       these same app files run under the pi-shell host — whose requests are
//       made outside the webview, where CORS does not apply — without the app
//       knowing which stack it is on. In a browser tab the seam is a
//       pass-through to window.fetch and nothing here changes, but it is a new
//       transitive import of the shell, and an uncached import is not a partial
//       failure: the shell dies at module-load offline. Hence the bump.
// v143: the espeak-ng data package (18 MB) is fetched once per DEVICE and kept
//       in OPFS, not pulled again by every `predict()` (vendor/piper-tts-web.js,
//       PARCHE 4). Here it changed nothing — this worker was serving those bytes
//       from RUNTIME_CACHE, which is exactly why the cost was invisible in a
//       browser tab and brutal under pi-shell, which has no service worker at
//       all. The bump is for the vendored file itself.
// v144: the 14.8 MB biblioteca catalog is stored in IndexedDB and re-checked
//       with `If-None-Match` (biblioteca.js, ensureCatalog), instead of being
//       downloaded whole on every 📚 and every «Book and author». It is NOT
//       precached here on purpose: it is data, not shell, it dwarfs everything
//       this worker holds, and a CACHE_NAME bump would throw it away — which is
//       the one thing the fix exists to stop. Caddy stamps `no-store` on the
//       whole route table, so the app keeping its own copy is the only place a
//       copy can live, in a tab or under pi-shell.
// v145: the two catalog-less views say so and carry a 🔄 Reintentar — folder
//       mode is no longer a silent swap of the card grid for a file tree, and
//       «Book and author» no longer ends at a header above one flat sentence.
//       New CSS (.bib-catalog-retry), so the stylesheet has to come with it.
// v146: the voice engine is kept on the device, so a downloaded voice speaks
//       offline where there is no service worker to keep it for us. The runtime
//       cache below is exactly that guarantee IN A TAB; under pi-shell there is
//       no SW at all, so onnxruntime-web, its .wasm and piper_phonemize.wasm
//       went to a CDN on every session and an offline ▶ hung forever on a fetch
//       that could not land. They now live in OPFS beside the voice model and
//       the espeak package (PARCHE 5 in vendor/piper-tts-web.js), and js/piper.js
//       gained the deadline that stops any such hang from freezing the whole
//       synthesis queue behind it.
// v149: one reader, both halves of it. (a) The lock screen / media notification
//       / headset buttons are answered by the app (js/mediakeys.js) instead of
//       falling through to a raw pause on the <audio> element, which stopped the
//       sound while the app went on believing it was reading. ⏭/⏮ are bound
//       INERT — an unbound skip key is that same raw pause, not a no-op. (b) The
//       single-reader claim now also travels through the json store
//       (/api/audiobooks-reader), so the installed shell and a browser tab —
//       different ORIGINS, so deaf to each other's BroadcastChannel — can no
//       longer read one book at once.
// v153: ⏸/▶ stops going back to the engine. (a) A pause now HOLDS the audio
//       element — source, decode and playhead intact — so ▶ is a play() and
//       nothing else; it used to tear the source down and re-render. (b) A
//       paragraph is rendered WHOLE and a mid-paragraph resume SEEKS into it, so
//       the resume word is no longer part of the cache key and a paused
//       paragraph is a cache hit instead of a guaranteed miss. (c) Queued
//       renders the reader has moved past are dropped instead of occupying the
//       one WASM thread ahead of the tap that mattered. (d) An idle precache
//       renders ~4000 chars ahead of any open, not-playing book (the bedside
//       table, sleep mode armed, a book restored at boot), and eviction is by
//       DISTANCE from the playhead rather than insertion order — a look-ahead
//       buffer's oldest entry is the paragraph about to be played.
// v171: the sync banner stops blaming the server for a request that never left
//       the phone. Under pi-shell an /api GET that reached no face still answers
//       200 out of the shell's own disk cache; js/progress.js read that as "the
//       server answered" and showed "el servidor no acepta la sincronización"
//       while nothing had been sent anywhere. It now asks isStaleAnswer()
//       (_shared/net/connectivity.js, newly precached) and a cached answer
//       neither clears the network flag nor authorises a push. The retry loop
//       also stopped stacking: one round-trip at a time, because a 6 s tick
//       against a ~19 s budget filled Android's intercept thread pool until the
//       app could not load its own files.
// v172: the ⚙️ 😴 dropdowns follow the armed preset. «⏱️ Corto» was two constants
//       (30 · ↺8) with no screen anywhere to change them, and the two controls
//       always showed the LONG pair — so arming it left the panel reading 40 · ↺15
//       over a night that was going to stop at 30. #sleepMin / #rewindMin now show
//       and EDIT whichever preset is armed, a line above them says which, and the
//       short pair persists + syncs (`sleepShortMin` / `sleepShortRewind`) while
//       the arming stays one-shot. Option lists widened (5–15 min runs, 2–8 min
//       step-backs) because the short preset needs values the long one never would.
//
// v188: the día/noche toggle parks the off-shelf book. It kept playing on the
//       card, so both shelves shared one reader.
//
// v191: ▶ Play is four times taller. A thumb found the seek bar instead.
//
// v192: 🎚️ Modulación picks how peaks are handled. The old chain ducked for a
//       quarter second and the speaker went quiet with it.
//
// v196: ⏭️ Siguiente / ✅ Terminar. Handing the open book back and starting the
//       next one took a trip through two other lists.
//
//       The queue pair is 🔝 / ⬇️ too. The 🔜 read as "cola" on both.
//
// v204: holds. ▶ Play crosses to Música and the transcript flips día⇄noche, so
//       the shelf no longer needs 📖 open to change.
//
// v208: a hold is 0,8 s, not 2 s. The 😴 and ⚡ chips take one too (⏱️ Corto,
//       180⇄150%), and the corner ❓ hides under an open sheet.
//
// v214: a hold is 0,5 s. 🔝/⬇️ on the book you are READING park it: the player
//       empties instead of promoting a neighbour. Progress stays.
//
// v215: a parked player stays parked across a reload and a shelf flip.
//
// v217: a held ▶ crosses to Música without the browser's leave-the-page confirm.
const CACHE_NAME = "audiobooks-network-first-v234";

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

// Network-first tuning. Over the tailnet (esp. mobile) the first request after
// the app wakes can fail while the tunnel reconnects; retry a few times before
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
  "_shared/net/secureFace.js",
  "_shared/net/faces.js",
  "_shared/net/transport.js",
  "_shared/platform.js",
  "_shared/net/offlineChrome.js",
  // js/progress.js asks it whether a resolved answer came off the network or out
  // of the disk cache pi-shell keeps — see isStaleAnswer.
  "_shared/net/connectivity.js",
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
  "js/biblioteca.js",
  "js/reactions.js",
  "js/wishlist.js",
  "js/profile.js",
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
 * fetch rejecting — the warming tailnet tunnel this file already retries for in
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
 * the tailnet — radio wake + tunnel reconnect — before a single pixel was
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

  // The progress blob is mutable state, never a cacheable asset. If we let
  // network-first cache it, an OFFLINE boot would fall back to the stale cached
  // 200 and the app would treat it as a real server read (progressReady=true),
  // then push over fresher data. Go network-only so an offline GET fails cleanly
  // and progressReady stays false until the store is genuinely reachable. Other
  // /api/* blobs (favorites/reactions/queue) stay cacheable for offline reads.
  // Same for the single-reader claim: it says who is reading RIGHT NOW, and a
  // cached copy is a claim from the past. Served from the cache it would either
  // pause a book nobody took, or hide a claim that was made — both worse than
  // an offline GET that fails cleanly and leaves the local half in charge.
  if (
    url.pathname === "/api/audiobooks-progress" ||
    url.pathname === "/api/audiobooks-reader"
  ) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  // The precached shell — every module, stylesheet and icon the app boots on.
  // Cache first so a restored tab paints immediately instead of waiting on the
  // tailnet for ~50 requests; the background revalidate keeps the bucket warm.
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

  try {
    // Pull the server blob and merge (newer ts per book wins) IMMEDIATELY before
    // the PUT, to minimise the lost-update window vs a live tab. A failed/!ok GET
    // must NOT authorise a PUT (that would overwrite the store with our partial
    // map) — throw so Chromium retries with backoff.
    const r = await fetch("/api/audiobooks-progress", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
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
    const push = await fetch("/api/audiobooks-progress", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
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
