/**
 * Room storage.
 *
 * Default: in-process memory. Perfect for a single long-running server
 * (Render, Railway, Fly, `npm start` on a laptop).
 *
 * If Upstash/Vercel KV env vars are present, rooms are stored in Redis over
 * its REST API instead (no extra dependency, just fetch). That's what makes
 * the app work on serverless platforms, where each request may hit a
 * different instance with its own memory.
 *
 * Env vars picked up automatically:
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL        + KV_REST_API_TOKEN        (Vercel KV / Marketplace)
 */

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const ROOM_TTL_SECONDS = 60 * 60 * 6; // rooms die after 6h of nothing
const KEY = (code) => `imposter:room:${code}`;

/* ------------------------------- memory ------------------------------- */

const rooms = new Map();

function pruneMemory() {
  const cutoff = Date.now() - ROOM_TTL_SECONDS * 1000;
  for (const [code, room] of rooms) {
    if ((room.updatedAt || 0) < cutoff) rooms.delete(code);
  }
}

/* -------------------------------- redis ------------------------------- */

async function redis(path, init) {
  const res = await fetch(`${REDIS_URL}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      ...(init && init.headers)
    },
    cache: 'no-store'
  });
  if (!res.ok) {
    throw new Error(`Redis request failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/* --------------------------------- api -------------------------------- */

async function getRoom(code) {
  if (!code) return null;
  if (!USE_REDIS) {
    pruneMemory();
    return rooms.get(code) || null;
  }
  const out = await redis(`get/${encodeURIComponent(KEY(code))}`);
  if (!out || out.result == null) return null;
  try {
    return JSON.parse(out.result);
  } catch {
    return null;
  }
}

async function setRoom(room) {
  room.updatedAt = Date.now();
  if (!USE_REDIS) {
    rooms.set(room.code, room);
    return room;
  }
  await redis(`set/${encodeURIComponent(KEY(room.code))}?EX=${ROOM_TTL_SECONDS}`, {
    method: 'POST',
    body: JSON.stringify(room),
    headers: { 'Content-Type': 'application/json' }
  });
  return room;
}

async function deleteRoom(code) {
  if (!USE_REDIS) {
    rooms.delete(code);
    return;
  }
  await redis(`del/${encodeURIComponent(KEY(code))}`, { method: 'POST' });
}

module.exports = { getRoom, setRoom, deleteRoom, USE_REDIS };
