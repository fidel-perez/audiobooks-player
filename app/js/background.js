/**
 * Keeping playback alive: a screen wake lock held for as long as the book plays,
 * and a silent looping audio track (so mobile browsers don't throttle or discard
 * the tab).
 *
 * None of this makes the DEVICE voice survive backgrounding — Android speaks it
 * outside the page and Chromium suspends it the moment the page hides. The wake
 * lock is what keeps the page visible, and therefore what keeps it speaking.
 */

import { state } from "./state.js";

/* ---------- screen wake lock (follows playback) ----------
 * There is no keep-screen checkbox: the screen is held on exactly while the book
 * is playing and let go the moment it isn't. The device voice cannot speak from
 * a hidden page (Android renders it outside the page and Chromium suspends it),
 * so a lit screen IS the playback requirement, not a preference. The browser
 * drops the lock by itself whenever the page hides; main.js re-acquires it on
 * `visibilitychange` if we're still playing.
 */
export async function acquireWake() {
  if (state.wakeLock) return;
  try {
    if ("wakeLock" in navigator) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      // Released behind our back (page hidden, tab discarded) → forget it, so a
      // later acquireWake() asks for a fresh one instead of short-circuiting.
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    }
  } catch (_) {
    state.wakeLock = null;
  }
}

export async function releaseWake() {
  try {
    if (state.wakeLock) {
      const l = state.wakeLock;
      state.wakeLock = null;
      await l.release();
    }
  } catch (_) {}
}

/* ---------- silent audio keep-alive (anti-throttling) ---------- */
function buildKeepAliveUrl() {
  const sr = 8000;
  const secs = 10;
  const n = sr * secs;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, (Math.random() * 8 - 4) | 0, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export function startKeepAlive() {
  try {
    if (!state.keepAlive) {
      state.keepAlive = new Audio(buildKeepAliveUrl());
      state.keepAlive.loop = true;
      state.keepAlive.volume = 0.04;
    }
    state.keepAlive.play().catch(() => {});
  } catch (_) {}
}

export function stopKeepAlive() {
  try {
    if (state.keepAlive) state.keepAlive.pause();
  } catch (_) {}
}

/* ---------- telling the shell a book is being read ----------
 * Under the pi-shell (Android) a `mediaPlayback` foreground service is what
 * keeps this page out of the freezer with the screen off, and it may only run
 * while something is playing — so the shell watches the <audio> elements. That
 * reading is a FALSE NEGATIVE for a Piper paragraph seam and for the whole of a
 * synthesis, which is where the wake lock was released and, 15 minutes later,
 * the service stopped itself: the book ended in the middle of the night with no
 * sleep-mode rewind, because a frozen page has no timers either.
 *
 * The keep-alive above closes that window in the element answer, and this closes
 * it in the shell's: the player states, in so many words, that it is reading. Two
 * belts on purpose — the keep-alive is a real sound the OS can take away (audio
 * focus, a call), while this is a plain flag; either one alone holds the service.
 *
 * A no-op anywhere else. In a browser tab `__PI_MEDIA__` does not exist, and an
 * older shell has no `hold` on it.
 */
export function holdPlayback(on) {
  try {
    const media = window.__PI_MEDIA__;
    if (media && typeof media.hold === "function") media.hold(!!on);
  } catch (_) {}
}

/* ---------- and whether the shell managed to hold it ----------
 * Telling the shell we are reading is a REQUEST, and until 2026-07-31 the answer
 * was thrown away. `startForegroundService` is refused for a backgrounded app on
 * Android 12+, the Kotlin side logged the refusal and returned, and this page
 * carried on believing the freezer could not reach it — which is exactly the
 * night that was measured: play at 22:23, last save at 22:28:46, then a cached,
 * frozen process until the app was opened at 04:21. The shell now answers, and
 * these two are how the page hears it.
 */

/**
 * Is playback currently held out of Android's freezer? True everywhere there is
 * no service to lose — a browser tab, a desktop, an older shell — because a
 * warning about a service that was never needed is noise.
 */
export function isPlaybackProtected() {
  try {
    const media = window.__PI_MEDIA__;
    return !media || media.protected !== false;
  } catch (_) {
    return true;
  }
}

/**
 * Call `onLost` when the shell reports it could not keep the service up.
 *
 * ONLY THE LOSING EDGE. Regaining protection needs no announcement — the reader
 * has nothing to do about good news — while losing it means this process may be
 * frozen at the next paragraph seam, which is the last moment anything here can
 * still write to disk.
 */
export function watchPlaybackProtection(onLost) {
  window.addEventListener?.("pi-playback-protection", (e) => {
    if (e?.detail?.ok === false) onLost();
  });
}
