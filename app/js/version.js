/**
 * "How fresh is the running app?" helpers for the ⚙️ Ajustes header.
 *
 * `agoEs` is a pure, coarse Spanish "hace X" formatter (unit-tested). The DOM /
 * network side (fetching the server's live sw.js Last-Modified, painting the
 * header, wiring the force-refresh tap) lives in main.js so this module stays
 * import-clean under the test shim.
 */

/**
 * Coarse Spanish relative time for a PAST timestamp `then` (ms epoch), measured
 * against `now`. Deliberately low-resolution — the point is "recent vs stale",
 * not exact minutes. A future/invalid `then` reads as "hace un momento".
 */
export function agoEs(then, now = Date.now()) {
  const ms = now - then;
  if (!Number.isFinite(ms) || ms < 60000) return "hace un momento";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d} día${d === 1 ? "" : "s"}`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `hace ${mo} mes${mo === 1 ? "" : "es"}`;
  const y = Math.floor(d / 365);
  return `hace ${y} año${y === 1 ? "" : "s"}`;
}
