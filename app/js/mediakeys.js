/**
 * THE BUTTONS THIS APP DOES NOT OWN THE HARDWARE FOR: the media notification,
 * the lock screen, a headset's play/pause, a car's steering-wheel keys.
 *
 * WHY THIS EXISTS AT ALL, given that the transport layer was deliberately
 * deleted once (see tests/audiobooks-no-mediasession.test.js). Not registering a
 * handler does NOT mean the buttons do nothing — it means something else answers
 * them, and what answers them is worse than any handler here. In the pi-shell the
 * notification's ⏸/⏭/✕ come back into the page as `__PI_MEDIA__.action(...)`,
 * and with no handler registered that function falls through to
 * `current.pause()` on the raw <audio> element (see pi-shell bootstrap.js). In a
 * browser the default handler does the same thing directly.
 *
 * A RAW PAUSE IS THE BUG. It stops the sound and tells the app nothing:
 * `state.speaking` stays true, the button still reads "⏸ Pause", the wake lock is
 * still held, and every watchdog goes on reasoning from "we are reading". The
 * app then believes it is playing while it is silent — proven live on the phone,
 * `__PI_MEDIA__.action("pause")` paused the element with the app still showing
 * ⏸ — and every later decision (resume, seek, restart, the stall watchdogs, the
 * position it saves) is made from a false premise. ⏭ and the notification's
 * swipe-away land on the SAME fallthrough, so a "next" press silently pauses the
 * book too.
 *
 * So the app takes the presses. Play and pause route through the very functions
 * ▶/⏸ use, which is what keeps one state machine instead of two.
 *
 * ⏭/⏮ STAY DEAD, ON PURPOSE — and being dead is exactly why they must be
 * registered. The transport layer that was deleted made ⏭ jump to a random point
 * INSIDE the book and save it at once, so one mispressed steering-wheel key
 * destroyed your place on every device, with no confirm and no undo. Skipping
 * here is a deliberate act, done in the app. But an UNregistered ⏭ is not a no-op
 * — it is the raw pause above. A registered no-op is the only way to actually
 * make the key do nothing. Nothing in this file may move the position.
 *
 * WHAT THIS COSTS, IN A PLAIN BROWSER TAB. ⏸ here is the app's pause, which tears
 * the audio source down (that is what frees the model and saves the word), and a
 * document with no loaded media is a document Chrome eventually stops showing a
 * media notification for — so the widget can vanish on pause instead of waiting
 * there with a ▶. Under pi-shell, where this app actually runs, the notification
 * belongs to the shell's foreground service and survives a pause by design. A
 * lying UI is the worse of the two, so this is accepted, not overlooked.
 */

import { flipShelf } from "./encurso.js";
import { currentMode } from "./mode.js";
import { play, pausePlayback } from "./player.js";
import { isInterrupted, resumeAudio } from "./piper.js";
import { state } from "./state.js";

/**
 * `setActionHandler` throws NotSupportedError for an action the browser does not
 * know, and the shell's stand-in for `navigator.mediaSession` (Android WebView
 * has none) is a different implementation again. One bad action must not leave
 * the rest of the transport unowned.
 */
function bind(ms, action, handler) {
  try {
    ms.setActionHandler(action, handler);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Press ▶ from outside the page.
 *
 * Idempotent: a transport button is pressed blind, and often twice, so a second
 * press while already reading must not re-speak the paragraph (that is a cut, a
 * re-synthesis and a resume a word or two behind).
 *
 * The one case where "already reading" still needs doing something is an
 * INTERRUPTION: Chromium pauses the media element when a call takes audio focus,
 * and the app deliberately leaves that alone to be resumed rather than
 * relaunching the paragraph into it (see piper.js#isInterrupted). If the reader
 * presses ▶ before focus comes back, they mean resume THAT — not start again.
 */
function pressPlay() {
  if (!state.chunks.length) return;
  if (state.speaking && !state.paused) {
    if (isInterrupted()) resumeAudio().catch(() => {});
    return;
  }
  play();
}

/** Press ⏸ from outside the page — the same pause the button does, so the word
 *  is frozen and the place is saved. */
function pressPause() {
  pausePlayback();
}

/**
 * Take ownership of every transport press this app can receive. Returns the
 * actions that were actually bound, so a test (and the console) can see what the
 * platform accepted rather than assume.
 */
export function bindTransportButtons() {
  // The pad's X has no media-session name, so the shell hands it over as an
  // event — ahead of the check below, which would skip it.
  addEventListener("pi-transport", (event) => {
    if (event.detail && event.detail.action === "day") {
      pressDay();
    }
  });
  const ms = typeof navigator !== "undefined" ? navigator.mediaSession : null;
  if (!ms || typeof ms.setActionHandler !== "function") return [];
  const bound = [];
  const claim = (action, handler) => {
    if (bind(ms, action, handler)) bound.push(action);
  };
  claim("play", pressPlay);
  claim("pause", pressPause);
  // The notification's swipe-away sends this. It is a pause, not a teardown: the
  // book stays open at the word it reached.
  claim("stop", pressPause);
  // Registered to be inert — see the header. No position may move here.
  claim("nexttrack", () => {});
  claim("previoustrack", () => {});
  return bound;
}

/**
 * The day shelf, from a car mount.
 *
 * Flipping moves no book: it parks the night one and activates the day one
 * (library.js#syncActiveToShelf), which is the book A then plays.
 */
function pressDay() {
  if (currentMode() !== "day") {
    flipShelf();
  }
}
