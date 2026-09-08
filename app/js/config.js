/**
 * Audiolibros — configuration constants.
 *
 * Pure data, no logic. Importable from any module.
 */

// Library limits.
export const MAX_DOCS = 20;

// Reading-speed model (words per minute at rate 1.0) + chunk sizing.
export const BASE_WPM = 155;
export const MIN_CHUNK = 180;
export const MAX_CHUNK = 360;

// Synthesis read-ahead + first-play cushion, measured in CHARACTERS of upcoming
// text — NOT paragraphs. A paragraph count is the wrong unit now that each
// sentence is its own chunk (see pdf.js): three tiny sentences ahead is almost
// no audio, so a run of short lines outran the single WASM synthesis thread and
// the reader heard "⏳ Generando voz…" mid-play. A char budget stays constant
// whatever the sentences weigh.
//   READAHEAD_CHARS — how much upcoming text to keep rendered ahead WHILE playing.
//   PREBUFFER_CHARS — how much to render BEFORE the first paragraph of a
//     reader-initiated ▶/seek starts, so the early short phrases have a cushion
//     and don't play faster than the next can be synthesised (the startup gaps).
//   MAX_READAHEAD_CHUNKS — hard cap so a passage of ultra-short sentences
//     ("—Sí. —No.") can't turn a char budget into dozens of queued jobs (and
//     evict still-unplayed audio from the bounded synth cache). Must stay below
//     piper.js CACHE_MAX so nothing rendered ahead is dropped before it plays.
export const READAHEAD_CHARS = 1200;
export const PREBUFFER_CHARS = 500;
export const MAX_READAHEAD_CHUNKS = 16;

// THE IDLE PRECACHE — the buffer built while nobody is listening.
//
// The read-ahead only runs behind a paragraph that is already playing, so all
// the time the app spends merely OPEN — on the bedside table with sleep mode
// armed, in a hand between chapters, freshly restored at boot — used to render
// nothing at all, and the next ▶ paid the engine from cold. That is the wait the
// reader actually notices, because it is the one they are sitting through.
//
//   PRECACHE_CHARS — how far ahead of the resume point to render while stopped.
//     Much deeper than READAHEAD_CHARS: there is no seam to hit and nothing
//     competing for the single WASM thread, and a ▶ abandons the rest anyway.
//     ~4000 chars is roughly four minutes of speech at BASE_WPM.
//   MAX_PRECACHE_CHUNKS — the same backstop READAHEAD has, for a passage of
//     one-word sentences.
//   PRECACHE_TICK_MS — how often the idle loop tops the buffer back up. It is a
//     cheap no-op when everything ahead is already rendered.
export const PRECACHE_CHARS = 4000;
export const MAX_PRECACHE_CHUNKS = 40;
export const PRECACHE_TICK_MS = 4000;

// What the rendered-audio cache is allowed to hold. A WAV is ~44 KB per second
// of speech, so a precache this deep is bounded by BYTES long before it is
// bounded by entries — the entry cap is only a backstop against a book of
// one-word sentences. Eviction is by distance from the playhead, never by
// insertion order (see piper.js): a look-ahead buffer's oldest entry is the one
// about to be played.
export const CACHE_MAX_BYTES = 48 * 1024 * 1024;
export const CACHE_MAX_ENTRIES = 240;

// Plain-text / Markdown docs have no real pages, so we synthesise "pages" of
// this many characters (~a paperback page) to keep the page readout and the
// "go to page" control meaningful. See js/text.js.
export const CHARS_PER_PAGE = 1800;

// Sleep mode ("modo dormir"): the "still awake?" check that stops the book when
// you have stopped moving the phone. It no longer touches the screen at all —
// no fullscreen, no blackout, no wake lock (see js/sleep.js for why that whole
// apparatus existed and why it could go).
export const SLEEP_GRACE_MS = 30000; // time to move after the warning beep
export const SLEEP_MOTION_THRESHOLD = 1.2; // m/s² of movement counted as "awake"
// Diagnostic: blip on every move the watchdog counts, so "does shaking the phone
// register with the screen off?" can be answered in five seconds instead of by
// waiting out the whole stop interval to see whether the grace beep is
// answerable. Off by default and local-only — it is a test instrument, not a
// feature of the night. Throttled so a stream of accelerometer events (~62/s in
// a visible tab) is one blip per shake, not a siren.
export const SLEEP_TEST_BEEP_MS = 1200;
// How long the 3 s watchdog may go without running before the page is taken to
// have been STOPPED, not merely slow — see sleep.js#reconcileSleepDeadline.
//
// The number has to clear the worst legitimate tick gap, which is a backgrounded
// browser tab: Chromium throttles a hidden page's timers to roughly one run a
// minute, and never further. Anything past five of those is not throttling, it is
// Android's freezer — and the deadline that was running when the page stopped has
// to be settled against the wall clock rather than resumed as if no time passed.
export const SLEEP_FROZEN_MS = 5 * 60000;

// IndexedDB (extracted-text cache) + localStorage keys.
export const DB_NAME = "audiobooks_db";
// Bumped to 2 to add the META_STORE alongside `docs` (guard-created, docs
// untouched). The service worker opens its own connection at this SAME version
// with an identical guard-create, so a background-sync open can't hit a
// VersionError. See js/db.js. Bumped to 3 for FILE_STORE (the offline book
// buffer) — same guard-create rule.
export const DB_VERSION = 3;
export const STORE = "docs";
// Raw book FILES (EPUB/PDF bytes) kept ahead for offline reading, keyed by the
// book's catalog path: the queued books, the cross-device "en curso" books this
// device hasn't opened yet, and — when the queue is short — a few random picks
// from the current filters. IndexedDB, NOT the SW Cache Storage: the SW purges
// its whole cache on every CACHE_NAME bump, which would throw the buffer away on
// each deploy. See js/catalog.js syncOfflineBuffer.
export const FILE_STORE = "files";
// The random top-up target: how many random in-filter picks to hold so a night
// offline still auto-advances into a fresh book. Only the QUEUE eats into this
// budget (random count = OFFLINE_BUFFER_SIZE − queue length); the open-book shelf
// is ALWAYS held on top, so open books never shrink the random pool. A queue of
// this length or longer leaves no room for random picks. See bufferKeepSet.
export const OFFLINE_BUFFER_SIZE = 10;
// Small key/value store for the durable progress mirror the service worker can
// read (localStorage isn't reachable from a SW). One record `{k:"progress",
// v:{map, dirty}}` — the whole progress map plus whether it holds edits the
// server hasn't confirmed. See js/db.js idbGetMeta/idbSetMeta + js/progress.js.
export const META_STORE = "meta";
export const META_PROGRESS_KEY = "progress";
export const LS_POS_PREFIX = "audiobooks_pos_";
export const LS_RATE = "audiobooks_rate";
// Playback volume: persisted so a chosen level survives a reload instead of
// snapping back to the slider default.
export const LS_VOL = "audiobooks_vol";
// Volume ceiling. The Android device voice is rendered by the OS straight to
// the system mixer — the page never sees it as audio, so no gain node can reach
// it and 100% is a hard cap there. A Piper voice is WAV bytes we own, so it
// goes through a compressor + gain and can genuinely go louder (js/piper.js).
// The slider is shared, so it runs to the Piper ceiling and the device voice
// clamps itself to 1 — see player.js. Past ~4x even the compressor stops
// sounding like a voice.
export const VOL_MAX = 4;
// What the device voice can actually honour. Anything above this is silently
// the same volume there, so the slider says so rather than pretending.
export const VOL_MAX_DEVICE = 1;
// Which peak-handling preset the Piper chain runs (js/modulation.js). Per-device
// like the volume, and for the same reason: it answers the speaker, not the reader.
export const LS_MODULATION = "audiobooks_modulation";

// ---------------------------------------------------------------------------
// Voices.
//
// `audiobooks_voice` holds ONE value that names the engine as well as the voice:
// "device" for the Android voice, or a Piper voice id. It is synced (unlike the
// old per-language voice preference) because the operator asked for the choice
// to follow them across devices.
export const LS_VOICE = "audiobooks_voice";
export const VOICE_DEVICE = "device";
export const VOICE_DEFAULT = VOICE_DEVICE;

// The Castilian Piper voices, benchmarked in /main/tts-lab/ before landing here.
// `mb` is the model download, shown in the picker so a 73 MB choice on mobile
// data is an informed one. Ordered cheapest-first: x_low is both the smallest
// and the fastest, and it was the operator's pick on timbre too.
// THE THREE SHERPA ALSO BUILDS, and that is the reason the list is this length.
// Under pi-shell these are rendered by the native engine (see the shell's
// `tts.rs`), which is what makes `davefx` usable at all — on the page's own wasm
// engine it sustains RTF ~1.7 against a reader that plays at 1.8x, so the buffer
// drained and every paragraph seam was a wait.
//
// `es_ES-mls_9972-low` and `es_ES-mls_10246-low` were here and are gone: sherpa
// has never built either, so they would be the only two voices that silently fell
// back to one wasm thread, and nobody had chosen them. A stored setting naming one
// is handled — `voices.js#known` returns the default for an id off this list.
//
// `mb` is the DOWNLOAD, and one number now serves both engines because both pull
// the same fp32 weights: sherpa's compressed tarball for the native engine (27 /
// 67 / 80 MB) and HuggingFace's bare `.onnx` for the wasm one (28 / 63 / 77). The
// native engine briefly took the int8 tarballs, which is where 13/21/23 came from
// — that was reverted for being audibly noisy AND slower, see the header of
// `pi-shell/src-tauri/src/tts.rs`. If those tarballs move, move these with them.
export const PIPER_VOICES = [
  { id: "es_ES-carlfm-x_low", label: "Carlos (rápida)", mb: 27 },
  { id: "es_ES-sharvard-medium", label: "Sharvard (calidad)", mb: 80 },
  { id: "es_ES-davefx-medium", label: "Davefx (calidad)", mb: 67 },
  // English voices from vendor/piper-tts-web.js's VOICE_IDS. norman/kristin,
  // not lessac/amy/ryan: those carry non-commercial or research-only licenses.
  { id: "en_US-norman-medium", label: "Norman (English)", mb: 61 },
  { id: "en_US-kristin-medium", label: "Kristin (English)", mb: 61 },
];

// Where the library pulls models from, for the settings hint. The voices carry
// their own licences — es_ES-sharvard is CC-BY 3.0 (Edinburgh corpus), not MIT.
export const PIPER_BASE_URL = "https://huggingface.co/diffusionstudio/piper-voices";
// Sleep-mode auto-stop rewind: when sleep mode stops playback (you dozed off),
// step the book back this many minutes of listening first, so a morning ▶
// resumes ~before you stopped taking it in. Configurable in ⚙️ Ajustes and
// synced cross-device via the audiobooks-settings blob (see js/settings.js);
// this is only the fallback default when nothing is stored. 0 = don't rewind.
// Only applies to the sleep-mode auto-stop — no other stop rewinds.
export const REWIND_MIN_DEFAULT = 15;
// Rewind-on-stop minutes: last-used value, restored on load, then reconciled
// with the synced value. Kept locally too so an offline device still rewinds.
export const LS_REWIND_MIN = "audiobooks_rewind_min";
// docKey of the last-activated doc, so a reload reopens the book you were on
// (not just docs[0]). Read on startup by main.js; written by activateDoc.
export const LS_ACTIVE_KEY = "audiobooks_active_key";
// Sleep-mode minutes: last-used value, restored on load (default 40).
export const LS_SLEEP_MIN = "audiobooks_sleep_min";
export const SLEEP_MIN_DEFAULT = 40;
// Is sleep mode armed at all? It used to be a top-bar button you pressed for one
// night; it is now a setting that stays where you left it, ON by default —
// falling asleep to a book is the normal case, and the mode costs nothing when
// you are awake (it only ever acts while playback is running and the phone has
// been still). Local-only, deliberately NOT synced: whether the reader wants the
// watchdog is a property of the device in their hand at night, not of the
// account — the laptop should not inherit the phone's answer.
export const LS_SLEEP_ON = "audiobooks_sleep_on";
export const SLEEP_ON_DEFAULT = true;
// "Pitar al mover" — the diagnostic above. Local-only like LS_SLEEP_ON, and
// remembered rather than reset on reload: a test that has to survive locking the
// screen and putting the phone down cannot be a per-session toggle. It IS shown
// in the folded 😴 badge, so one left on overnight is visible at a glance.
export const LS_SLEEP_BEEP = "audiobooks_sleep_beep";
export const SLEEP_BEEP_DEFAULT = false;
// THE SHORT RUN. A second sleep preset for the OTHER kind of night: waking at
// three, wanting twenty minutes of book and not another forty, and knowing that
// whatever is heard then will be heard again. So it stops sooner and steps back
// less — the long preset's −15 would rewind past everything a short run covered.
//
// It is ONE-SHOT by design: armed for the next stop and spent by it, back to the
// long preset without anyone remembering to switch it. The failure it is built
// against is a preset left on, which is a 30-min night the following bedtime and
// no sign of why. See js/sleepPreset.js.
//
// ITS NUMBERS ARE SETTINGS TOO, since 2026-08-04. They were two fixed constants,
// and the two ⚙️ dropdowns always showed the LONG pair — so with «⏱️ Corto» armed
// the panel displayed 40 · ↺15 over a night that was going to run 30 · ↺8, and
// there was nowhere at all to say "make the short one 20". The dropdowns now
// follow the armed preset: they show and edit whichever pair is in force, which
// is both how you see what tonight will do and how you tune it. These two stay
// as the FACTORY values for the short pair — what an untouched device runs.
export const SLEEP_SHORT_MIN = 30;
export const SLEEP_SHORT_REWIND = 8;
// Local-only like LS_SLEEP_ON (the arming belongs to the phone in your hand at
// 3 a.m., not to the account), and persisted rather than session-scoped: arming
// it is the last thing you do before putting the phone down, and the shell may
// well reload the page before the night ends.
export const LS_SLEEP_SHORT = "audiobooks_sleep_short";
// The short pair's own numbers. Unlike the ARMING above these DO sync (blob keys
// `sleepShortMin` / `sleepShortRewind`), by the same argument that made #sleepMin
// travel: how long a 3 a.m. run should be is a fact about the reader, not about
// the handset — and a value you can only set on one origin is one you cannot
// verify at 3 a.m. Kept locally too, so an offline device still runs your pair.
export const LS_SLEEP_SHORT_MIN = "audiobooks_sleep_short_min";
export const LS_SLEEP_SHORT_REWIND = "audiobooks_sleep_short_rewind";
// AND ITS OWN SPEED (2026-08-06). A 3 a.m. run is not listened to at bedtime
// speed: half awake, the speed you can still follow is lower than the one set for
// a book being given full attention, and having to drag the slider back and forth
// around each short run is exactly the thing nobody does at 3 a.m. So speed became
// the third number of the preset — the ⚡ slider shows and edits whichever preset
// is armed, like the two dropdowns — and the LONG preset's speed stays what it has
// always been, LS_RATE, so an untouched device notices nothing. Factory 150%
// against a long preset that ships at 200%. Synced (`sleepShortRate`) by the same
// argument as the pair above: it is a fact about the reader, not about the handset.
export const SLEEP_SHORT_RATE = 1.5;
export const LS_SLEEP_SHORT_RATE = "audiobooks_sleep_short_rate";
// Progress mirror persisted locally so offline sessions survive a tab close and
// upload on the next online open (see js/progress.js).
export const LS_PROGRESS_MAP = "audiobooks_progress_map";
// The two former "🧪 Experimental" read modes are now BAKED IN, always on: one
// sentence per synthesis (pdf.js) and heavy internal punctuation softened to a
// comma beat at speak time (cleanForSpeech.js#softenPauses). They no longer have
// a toggle or a synced flag — see those files.
// Day/night "en curso" mode — which shelf (each has its OWN libros abiertos +
// en cola) you're viewing / assigning new books to. Per-device (not synced),
// persisted, default night. See js/mode.js.
export const LS_MODE = "audiobooks_mode";
// Per-night reading log ("📈 Registro de progreso"): docKey -> dayKey -> minutes
// advanced / rewound. Mirrored locally so a night read in airplane mode is still
// counted, and uploaded on the next online open. See js/progresslog.js.
export const LS_PROGRESS_LOG = "audiobooks_progress_log";

// Build stamp of THIS bundle — the moment the running code was last changed.
// Shown in ⚙️ Ajustes ("Actualizado hace X") so a stale cache is obvious: if the
// app behaves like old code while this reads a distant date, the client is
// running cached bytes and needs a hard refresh. Compared at runtime against the
// server's live sw.js Last-Modified to flag "a newer version is available".
// BUMP THIS (alongside CACHE_NAME in sw.js) on every shipped change.
export const APP_BUILD = "2026-09-04T08:01:12Z";
