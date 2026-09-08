/**
 * The one seam every /api/<key> call goes through: progress, queue,
 * settings, the log, the solo-reader claim. Same `fetch(path, init)`
 * signature as the transport.js it replaces.
 */
// Two backends, by whether Settings holds a sync-server URL.
//
// Unset (default): IndexedDB via js/db.js's meta store, nothing leaves
// the device.
//
// Set: a plain fetch to `<url>/api/<key>`, on the json_store contract —
// deep-merge PATCH, `null` deletes a key, `_op: "progress_merge"` for
// the progress map.
//
// Point it at your own instance; this repo ships no server.

import { idbGetMeta, idbSetMeta } from "./db.js";
import { mergeServerMap } from "./progress-merge.js";

const SYNC_URL_LS_KEY = "audiobooks:sync-server-url";
const KV_PREFIX = "store:";

export function getSyncServerUrl() {
  try {
    return (localStorage.getItem(SYNC_URL_LS_KEY) || "").trim();
  } catch (_e) {
    return "";
  }
}

export function setSyncServerUrl(url) {
  const v = (url || "").trim().replace(/\/+$/, "");
  try {
    if (v) localStorage.setItem(SYNC_URL_LS_KEY, v);
    else localStorage.removeItem(SYNC_URL_LS_KEY);
  } catch (_e) {
    // private mode / blocked storage — still works, just unsynced
  }
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function keyFromPath(path) {
  return path.startsWith("/api/") ? path.slice(5) : path;
}

// A `null` value deletes that key; matches json_store PATCH for every key
// here except `audiobooks-progress` (see mergeServerMap below).
function deepMergeDelta(base, delta) {
  const out = { ...(base || {}) };
  for (const k of Object.keys(delta)) {
    if (delta[k] === null) delete out[k];
    else out[k] = delta[k];
  }
  return out;
}

async function localFetch(key, init) {
  const method = (init.method || "GET").toUpperCase();
  const storeKey = KV_PREFIX + key;
  if (method === "GET") {
    const current = await idbGetMeta(storeKey);
    return jsonResponse(current === undefined ? {} : current);
  }
  const body = init.body ? JSON.parse(init.body) : {};
  const current = (await idbGetMeta(storeKey)) || {};
  let next;
  if (method === "PUT") {
    next = body;
  } else if (method === "PATCH" && body && body._op === "progress_merge") {
    next = mergeServerMap({ ...current }, body.entries || {});
  } else if (method === "PATCH") {
    next = deepMergeDelta(current, body);
  } else {
    return jsonResponse({ error: `unsupported method ${method}` }, 405);
  }
  await idbSetMeta(storeKey, next);
  return jsonResponse(next);
}

/** Drop-in for `fetch` on this app's `/api/<key>` paths. @type {typeof fetch} */
export async function apiFetch(path, init) {
  const key = keyFromPath(path);
  const base = getSyncServerUrl();
  if (!base) return localFetch(key, init || {});
  return fetch(`${base}/api/${key}`, init);
}
