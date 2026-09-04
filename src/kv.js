// Shared pass pool: Workers KV -> Deno KV -> memory.
// Every fresh mirror pass is kept (deduped, capped). takePass spreads load
// across passes so one stale visitor can't sink every API call. Entries live
// until a 418/429 drops them via dropPass. No TTL.
//
// Concurrency note: takePass is read-only (no cursor write-back) and picks
// via a process-local round-robin cursor. This avoids a read-modify-write
// race when many isolates/requests run at once, and halves KV ops.

const KEY = ["duckai", "vqd-pool"];
const MAX_PASSES = 10;

const mem = { passes: [] };
// Random start so every isolate doesn't hammer passes[0] on boot.
let localCursor = Math.floor(Math.random() * MAX_PASSES);

function workersKV(env) {
  const ns = env && (env.DUCKAI_KV || env.duckai_kv);
  if (ns && typeof ns.get === "function" && typeof ns.put === "function") return ns;
  return null;
}

async function withDenoKv(fn) {
  let kv = null;
  try {
    if (typeof Deno !== "undefined" && Deno.openKv) kv = await Deno.openKv();
  } catch (e) {
    console.warn("[kv] Deno.openKv failed, falling back to memory:", String(e).slice(0, 120));
    return await fn(null);
  }
  if (!kv) return await fn(null);
  try {
    return await fn(kv);
  } finally {
    try { kv.close(); } catch {}
  }
}

function cleanPasses(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const p of value) {
    if (typeof p !== "string") continue;
    const v = p.trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_PASSES) break;
  }
  return out;
}

function parsePool(raw) {
  if (!raw) return { passes: [] };
  try {
    const pool = JSON.parse(raw);
    return { passes: cleanPasses(pool && pool.passes) };
  } catch (e) {
    console.warn("[kv] corrupt pool, starting fresh:", String(e).slice(0, 120));
    return { passes: [] };
  }
}

async function readWorkersPool(ns) {
  let raw = null;
  try {
    raw = await ns.get("vqd-pool");
  } catch (e) {
    console.warn("[kv] Workers KV read failed:", String(e).slice(0, 120));
    return { passes: [] };
  }
  let pool = parsePool(raw);
  if (pool.passes.length > 0) return pool;
  // Pool empty: check the old single-pass key once, then drop it.
  let legacy = null;
  try {
    legacy = await ns.get("vqd-pass");
  } catch {
    return pool;
  }
  if (!legacy) return pool;
  let migrated = "";
  try {
    const r = JSON.parse(legacy);
    migrated = (r && r.value ? String(r.value) : "").trim();
  } catch {
    migrated = String(legacy).trim();
  }
  if (!migrated) return pool;
  pool = { passes: [migrated] };
  try { await ns.delete("vqd-pass"); } catch {}
  try { await ns.put("vqd-pool", JSON.stringify(pool)); } catch (e) {
    console.warn("[kv] Workers KV migrate write failed:", String(e).slice(0, 120));
  }
  return pool;
}

async function readPool(env) {
  const ns = workersKV(env);
  if (ns) return readWorkersPool(ns);
  return withDenoKv(async (kv) => {
    if (!kv) return mem;
    let stored = null;
    try {
      stored = await kv.get(KEY);
    } catch (e) {
      console.warn("[kv] Deno KV read failed:", String(e).slice(0, 120));
      return { passes: [] };
    }
    const pool = stored && stored.value;
    if (pool && Array.isArray(pool.passes)) return { passes: cleanPasses(pool.passes) };
    // Pool missing: check the old single-pass key once.
    let old = null;
    try {
      old = await kv.get(["duckai", "vqd-pass"]);
    } catch {
      return { passes: [] };
    }
    const rawOld = old && old.value;
    const v = typeof rawOld === "string" ? rawOld.trim()
      : rawOld && typeof rawOld.value === "string" ? rawOld.value.trim() : "";
    if (!v) return { passes: [] };
    const pool2 = { passes: [v] };
    try {
      await kv.set(KEY, pool2);
      await kv.delete(["duckai", "vqd-pass"]);
    } catch (e) {
      console.warn("[kv] Deno KV migrate write failed:", String(e).slice(0, 120));
    }
    return pool2;
  });
}

async function writePool(env, pool) {
  const ns = workersKV(env);
  if (ns) {
    try {
      await ns.put("vqd-pool", JSON.stringify(pool));
    } catch (e) {
      console.warn("[kv] Workers KV write failed:", String(e).slice(0, 120));
    }
    return;
  }
  await withDenoKv(async (kv) => {
    if (!kv) {
      mem.passes = pool.passes;
      return;
    }
    try {
      await kv.set(KEY, pool);
    } catch (e) {
      console.warn("[kv] Deno KV write failed:", String(e).slice(0, 120));
    }
  });
}

export async function savePass(env, value) {
  const v = (value || "").trim();
  if (!v) return;
  const pool = await readPool(env);
  if (pool.passes.includes(v)) return;
  pool.passes.unshift(v);
  pool.passes = pool.passes.slice(0, MAX_PASSES);
  await writePool(env, pool);
}

/** Next pass in rotation, or "" when the pool is empty. Read-only. */
export async function takePass(env) {
  const pool = await readPool(env);
  if (!pool.passes.length) return "";
  const idx = Math.abs(localCursor++) % pool.passes.length;
  return pool.passes[idx] || "";
}

/** Drop one dead pass (rejected with 418/429). */
export async function dropPass(env, value) {
  if (!value) return;
  const pool = await readPool(env);
  if (!pool.passes.includes(value)) return;
  pool.passes = pool.passes.filter((p) => p !== value);
  await writePool(env, pool);
}
