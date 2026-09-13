// Run: node --test test/
import assert from "node:assert/strict";
import test from "node:test";
import { stampAfterMove } from "../app/js/sleepPreset.js";

const M = 60000;
const CHECK = 40 * M;
const EXT = 15 * M;
const left = (now, stamp) => stamp + CHECK - now;

test("a move with under EXT left raises the remainder to EXT, never past it", () => {
  let now = 100 * M;
  let stamp = now - 30 * M; // 10 min left
  for (let i = 0; i < 3; i++) {
    stamp = stampAfterMove(now, stamp, CHECK, EXT);
    assert.equal(left(now, stamp), EXT);
    now += M;
  }
});

test("a move with EXT or more left restarts the whole interval", () => {
  const now = 100 * M;
  assert.equal(left(now, stampAfterMove(now, now - 10 * M, CHECK, EXT)), CHECK);
  assert.equal(left(now, stampAfterMove(now, now - 25 * M, CHECK, EXT)), CHECK);
});

test("a move during the warning beeps, past the deadline, gets EXT", () => {
  const now = 100 * M;
  assert.equal(left(now, stampAfterMove(now, now - CHECK - 5000, CHECK, EXT)), EXT);
});
