// Edge-safe chat API bolted onto the mirror worker.
// No Node/Bun APIs: only fetch, crypto.subtle, Response, atob/btoa.
// The browser-pass trick from the mirror stays in headers.js; here we
// call duck.ai server-to-server with a pasted pass (DUCKAI_VQD).

import { takePass, dropPass } from './kv.js';

const DUCK_BASE = "https://duck.ai";
const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEFAULT_FE_VERSION = "serp_20260825_094908_ET-b43980abc826d50478fe6ad7605a6087b9b31757";
const MAX_BODY = 18 * 1024;
const MAX_REQUEST_BODY = 256 * 1024;
const MAX_MODEL_LEN = 200;

const LABELS = {
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "mistral-small-2603": "Mistral Small 4",
  "tinfoil/gpt-oss-120b": "gpt-oss 120B",
  "tinfoil/gemma4-31b": "Gemma 4 31B",
};

const ALIASES = {
  "gpt-5.6": "gpt-5.6-luna",
  "gpt-5": "gpt-5.4",
  "gpt-4o-mini": "gpt-5.4-mini",
  "claude-haiku": "claude-haiku-4-5",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-8",
  "mistral-small": "mistral-small-2603",
  "gpt-oss-120b": "tinfoil/gpt-oss-120b",
  "gemma4-31b": "tinfoil/gemma4-31b",
};

function resolveModel(name) {
  if (!name) return "gpt-5.6-luna";
  const n = String(name).trim().slice(0, MAX_MODEL_LEN);
  if (!n) return "gpt-5.6-luna";
  if (LABELS[n]) return n;
  const low = n.toLowerCase();
  if (ALIASES[low]) return ALIASES[low];
  if (low.startsWith("gpt-5.6")) return "gpt-5.6-luna";
  if (low.startsWith("claude-haiku")) return "claude-haiku-4-5";
  if (low.startsWith("claude-sonnet")) return "claude-sonnet-4-6";
  if (low.startsWith("claude-opus")) return "claude-opus-4-8";
  if (low.startsWith("mistral")) return "mistral-small-2603";
  return n;
}

function toolChoice(tools, choice) {
  if (!tools || tools.length === 0 || choice === "none") return undefined;
  const out = {};
  const names = tools.map((t) => (t && t.function && t.function.name) || "").filter(Boolean);
  if (choice && choice.function && choice.function.name) names.push(choice.function.name);
  for (const raw of names) {
    const n = String(raw).toLowerCase();
    if (n.includes("generate_image") || n.includes("create_image") || n === "image") out.GenerateImage = true;
    else if (n.includes("news")) out.NewsSearch = true;
    else if (n.includes("video")) out.VideosSearch = true;
    else if (n.includes("local") || n.includes("place") || n.includes("maps")) out.LocalSearch = true;
    else if (n.includes("weather") || n.includes("forecast")) out.WeatherForecast = true;
    else out.WebSearch = true;
  }
  return Object.keys(out).length ? out : undefined;
}

function envGet(env, name) {
  if (env && typeof env === "object" && env[name]) return String(env[name]);
  try {
    if (typeof Deno !== "undefined" && Deno.env) {
      const v = Deno.env.get(name);
      if (v) return v;
    }
  } catch { /* no env permission */ }
  return "";
}

function getUA(env) {
  return envGet(env, "DUCKAI_UA") || DEFAULT_UA;
}

function getFeVersion(env) {
  return envGet(env, "DUCKAI_FE_VERSION") || DEFAULT_FE_VERSION;
}

function foldMessages(input) {
  const sys = [];
  const rest = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") { if (m.content) sys.push(String(m.content)); }
    else if (m.role === "tool") rest.push({ role: "user", content: `[tool_result] ${String(m.content ?? "")}` });
    else rest.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") });
  }
  if (!sys.length) return rest;
  const prefix = sys.join("\n\n");
  if (!rest.length) return [{ role: "user", content: prefix }];
  const idx = rest.findIndex((m) => m.role === "user");
  if (idx >= 0) rest[idx] = { role: "user", content: `${prefix}\n\n${rest[idx].content}` };
  else rest.unshift({ role: "user", content: prefix });
  return rest;
}

async function newEnvelope() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    messageId: crypto.randomUUID().replaceAll("-", ""),
    conversationId: crypto.randomUUID().replaceAll("-", ""),
    publicKey: {
      alg: "RSA-OAEP-256", e: jwk.e || "AQAB", ext: true,
      key_ops: ["encrypt"], kty: "RSA", n: jwk.n || "", use: "enc",
    },
  };
}

async function statusHash(env) {
  try {
    const r = await fetch(`${DUCK_BASE}/duckchat/v1/status`, {
      headers: {
        "User-Agent": getUA(env), Accept: "*/*", Origin: DUCK_BASE, Referer: `${DUCK_BASE}/`,
        "x-vqd-accept": "1", "x-ddg-journey-id": crypto.randomUUID().replaceAll("-", ""),
      },
    });
    return (r.headers.get("x-vqd-hash-1") || "").trim();
  } catch (e) {
    console.warn("[api] status fetch failed:", String(e).slice(0, 120));
    return "";
  }
}

function parseLine(line) {
  if (!line.startsWith("data:")) return null;
  const p = line.slice(5).trim();
  if (!p) return null;
  if (p === "[DONE]") return { type: "done" };
  if (p === "[PING]") return { type: "ping" };
  if (p.startsWith("[CHAT_TITLE:")) return { type: "title", content: p.slice(12, -1) };
  try {
    const m = JSON.parse(p);
    if (m.role === "assistant" && m.message) return { type: "message", content: m.message };
    if (m.role === "tool-invocation" && m.state === "call") {
      return { type: "tool_call", toolName: m.toolName || "WebSearch" };
    }
    if (m.role === "source" && m.source && m.source.url) {
      return { type: "source", url: m.source.url, title: m.source.title || m.source.url, site: m.source.site || "" };
    }
  } catch { /* skip */ }
  return null;
}

function dedupeSources(list) {
  const seen = new Set();
  return list.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

function toAnnotations(sources) {
  return dedupeSources(sources).map((s) => ({ type: "url_citation", url: s.url, title: s.title }));
}

async function duckChat({ model, messages, tools, tool_choice }, pass, env) {
  const envelope = await newEnvelope();
  const body = {
    model, messages: foldMessages(messages),
    canUseTools: Boolean(toolChoice(tools, tool_choice)),
    reasoningEffort: "none",
    metadata: (() => { const t = toolChoice(tools, tool_choice); return t ? { toolChoice: t } : {}; })(),
    durableStream: envelope,
  };
  // Trim until the upstream payload fits. Always shrink the current
  // biggest message so a second huge message can't keep us over budget.
  for (let i = 0; i < 5; i++) {
    const raw = JSON.stringify(body);
    if (raw.length <= MAX_BODY || body.messages.length === 0) break;
    let bigIdx = 0;
    for (let j = 1; j < body.messages.length; j++) {
      if ((body.messages[j].content || "").length > (body.messages[bigIdx].content || "").length) bigIdx = j;
    }
    const big = body.messages[bigIdx];
    if (!big || !big.content) break;
    const over = raw.length - MAX_BODY;
    big.content = big.content.slice(0, Math.max(0, big.content.length - over - 64)) + "...(trimmed)";
    if (!big.content.startsWith("...(trimmed)") && big.content.length <= 12) break;
  }
  const res = await fetch(`${DUCK_BASE}/duckchat/v1/chat`, {
    method: "POST",
    headers: {
      "User-Agent": getUA(env), Accept: "text/event-stream", "Content-Type": "application/json",
      Origin: DUCK_BASE, Referer: `${DUCK_BASE}/`,
      "x-fe-version": getFeVersion(env), "x-fe-signals": btoa("{}"),
      "X-Vqd-Hash-1": pass, "x-ddg-journey-id": envelope.conversationId,
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function collectFull(res) {
  if (!res.body) return { text: "", annotations: [] };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  const sources = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const ev = parseLine(line.trim());
      if (!ev) continue;
      if (ev.type === "message") full += ev.content;
      if (ev.type === "source") sources.push({ url: ev.url, title: ev.title, site: ev.site });
    }
  }
  return { text: full, annotations: toAnnotations(sources) };
}

function json(data, status = 200, req) {
  const h = new Headers({ "Content-Type": "application/json" });
  const o = req.headers.get("Origin");
  h.set("Access-Control-Allow-Origin", o || "*");
  h.append("Vary", "Origin");
  return new Response(JSON.stringify(data), { status, headers: h });
}

// Read the request body with a hard cap so one huge POST can't OOM the
// isolate. Returns { value } or { error: "too-large" | "bad-json" | ... }.
async function readJsonLimited(request) {
  const lenHeader = request.headers.get("content-length");
  if (lenHeader) {
    const n = Number(lenHeader);
    if (Number.isFinite(n) && n > MAX_REQUEST_BODY) return { error: "too-large" };
  }
  if (!request.body) {
    try {
      const text = await request.text();
      if (text.length > MAX_REQUEST_BODY) return { error: "too-large" };
      if (!text.trim()) return { error: "empty" };
      return { value: JSON.parse(text) };
    } catch {
      return { error: "bad-json" };
    }
  }
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    try {
      const text = await request.text();
      if (text.length > MAX_REQUEST_BODY) return { error: "too-large" };
      return { value: JSON.parse(text) };
    } catch {
      return { error: "bad-json" };
    }
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY) {
        try { await reader.cancel(); } catch {}
        return { error: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { error: "bad-read" };
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const text = new TextDecoder().decode(buf);
  if (!text.trim()) return { error: "empty" };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "bad-json" };
  }
}

export function isApiPath(pathname) {
  return pathname === "/healthz" || pathname === "/v1/models" ||
    pathname === "/v1/chat/completions" || pathname === "/v1/messages";
}

function openAIStreamResponse(upstream, { id, model, req }) {
  const keepAliveMs = 15000;
  const s = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (t) => controller.enqueue(enc.encode(t));
      let first = true;
      const ping = setInterval(() => { try { send(": ping\n\n"); } catch {} }, keepAliveMs);
      try {
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const sources = [];
        const chunk = (id_, model_, delta, role) => JSON.stringify({
          id: id_, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
          model: model_, choices: [{ index: 0, delta: { ...(role ? { role } : {}), content: delta }, finish_reason: null }],
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const ev = parseLine(line.trim());
            if (!ev) continue;
            if (ev.type === "message") {
              send(`data: ${chunk(id, model, ev.content, first ? "assistant" : undefined)}\n\n`);
              first = false;
            }
            if (ev.type === "source" && ev.url) sources.push({ url: ev.url, title: ev.title });
          }
        }
        const annotations = toAnnotations(sources);
        if (annotations.length) {
          const annChunk = JSON.stringify({
            id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
            model, choices: [{ index: 0, delta: { annotations }, finish_reason: null }],
          });
          send(`data: ${annChunk}\n\n`);
        }
        const doneChunk = JSON.stringify({
          id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
          model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        send(`data: ${doneChunk}\n\n`);
        send("data: [DONE]\n\n");
      } catch (e) {
        console.warn("[api] openai stream failed:", String(e).slice(0, 160));
        try { send(`data: ${JSON.stringify({ error: String(e).slice(0, 200) })}\n\n`); } catch {}
      } finally {
        clearInterval(ping);
        controller.close();
      }
    },
  });
  return new Response(s, {
    headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": req.headers.get("Origin") || "*",
    },
  });
}

function anthropicStreamResponse(upstream, { model, msgId, req }) {
  const keepAliveMs = 15000;
  const s = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const ping = setInterval(() => { try { send("ping", { type: "ping" }); } catch {} }, keepAliveMs);
      let full = "";
      try {
        send("message_start", {
          type: "message_start",
          message: {
            id: msgId, type: "message", role: "assistant", model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const sources = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            const ev = parseLine(line.trim());
            if (!ev) continue;
            if (ev.type === "message") {
              full += ev.content;
              send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ev.content } });
            }
            if (ev.type === "source" && ev.url) sources.push({ url: ev.url, title: ev.title });
          }
        }
        const uniq = dedupeSources(sources);
        if (uniq.length) {
          const tail = "\n\nSources:\n" + uniq.map((x) => `- ${x.title} (${x.url})`).join("\n");
          full += tail;
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tail } });
        }
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: Math.max(1, Math.ceil(full.length / 4)) },
        });
        send("message_stop", { type: "message_stop" });
      } catch (e) {
        console.warn("[api] anthropic stream failed:", String(e).slice(0, 160));
        try { send("error", { type: "error", error: { type: "overloaded_error", message: String(e).slice(0, 200) } }); } catch {}
      } finally {
        clearInterval(ping);
        controller.close();
      }
    },
  });
  return new Response(s, {
    headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": req.headers.get("Origin") || "*",
    },
  });
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const key = envGet(env, "DUCKAI_API_KEY");
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ status: "ok", backend: "duck.ai", mode: "edge-bolt-on" }, 200, request);
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    return json({
      object: "list",
      data: Object.keys(LABELS).map((id) => ({ id, object: "model", owned_by: "duckduckgo" })),
    }, 200, request);
  }
  if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")) {
    // Fail closed: chat endpoints require a configured key.
    if (!key) {
      console.error("[api] missing DUCKAI_API_KEY, rejecting chat request");
      return json({ error: { message: "server not configured (missing API key)" } }, 500, request);
    }
    if (request.headers.get("Authorization") !== `Bearer ${key}`) {
      return json({ error: { message: "bad key" } }, 401, request);
    }
    const parsed = await readJsonLimited(request);
    if (parsed.error === "too-large") {
      return json({ error: { message: "request too large" } }, 413, request);
    }
    const b = parsed.value;
    if (!b || typeof b !== "object") {
      return json({ error: { message: "bad request" } }, 400, request);
    }
    // Anthropic shape -> OpenAI shape on the same path family.
    let model = b.model || "", messages = b.messages || [], stream = b.stream === true;
    let tools = Array.isArray(b.tools) ? b.tools : [], tool_choice = b.tool_choice;
    if (url.pathname === "/v1/messages") {
      const conv = [];
      if (b.system) conv.push({ role: "system", content: typeof b.system === "string" ? b.system : JSON.stringify(b.system) });
      for (const m of messages) {
        if (!m || typeof m !== "object") continue;
        const c = typeof m.content === "string" ? m.content
          : Array.isArray(m.content) ? m.content.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("\n")
          : String(m.content ?? "");
        conv.push({ role: m.role === "assistant" ? "assistant" : "user", content: c });
      }
      messages = conv;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: { message: "messages must be non-empty" } }, 400, request);
    }
    model = resolveModel(model);
    const id = `chatcmpl-${crypto.randomUUID().slice(0, 24)}`;
    const msgId = `msg_${crypto.randomUUID().slice(0, 24)}`;
    // Pass order: mirror-captured KV pool -> pasted DUCKAI_VQD -> live status.
    let pass = await takePass(env) || envGet(env, "DUCKAI_VQD") || await statusHash(env);
    if (!pass) {
      console.warn("[api] no site pass available");
      return json({ error: { message: "missing site pass (visit the mirror and chat once, or set DUCKAI_VQD)" } }, 502, request);
    }

    const run = async (vqd) => duckChat({ model, messages, tools, tool_choice }, vqd, env);
    const runOnce = async (vqd) => {
      try {
        return await run(vqd);
      } catch (e) {
        console.error("[api] duck.ai fetch failed:", String(e).slice(0, 160));
        return new Response("upstream fetch failed", { status: 502 });
      }
    };
    if (!stream) {
      let res = await runOnce(pass);
      if ((res.status === 418 || res.status === 429)) {
        await dropPass(env, pass);
        pass = await takePass(env) || await statusHash(env);
        if (pass) res = await runOnce(pass);
      }
      if (!res.ok) {
        let t = "";
        try { t = await res.text(); } catch {}
        console.warn(`[api] duck.ai said ${res.status}`);
        return json({ error: { message: `duck.ai said ${res.status}: ${String(t).slice(0, 200)}` } }, 502, request);
      }
      let full = "", annotations = [];
      try {
        ({ text: full, annotations } = await collectFull(res));
      } catch (e) {
        console.warn("[api] upstream read failed:", String(e).slice(0, 160));
        return json({ error: { message: "upstream read failed" } }, 502, request);
      }
      if (url.pathname === "/v1/messages") {
        const block = { type: "text", text: full };
        if (annotations.length) {
          block.citations = annotations.map((a) => ({ type: "url_citation", url: a.url, title: a.title }));
        }
        return json({
          id: msgId, type: "message", role: "assistant", model,
          content: [block], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: Math.max(1, Math.ceil(full.length / 4)) },
        }, 200, request);
      }
      const msg = { role: "assistant", content: full };
      if (annotations.length) msg.annotations = annotations;
      return json({
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: msg, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }, 200, request);
    }
    // Streaming: forward live deltas + keep-alive pings so edge idle
    // timeouts don't close quiet gaps.
    let upstream = await runOnce(pass);
    if ((upstream.status === 418 || upstream.status === 429)) {
      await dropPass(env, pass);
      const retry = await takePass(env) || await statusHash(env);
      if (retry) { pass = retry; upstream = await runOnce(pass); }
    }
    if (!upstream.ok || !upstream.body) {
      let t = "";
      try { t = await upstream.text(); } catch {}
      console.warn(`[api] duck.ai stream said ${upstream.status}`);
      return json({ error: { message: `duck.ai said ${upstream.status}: ${String(t).slice(0, 200)}` } }, 502, request);
    }
    if (url.pathname === "/v1/messages") {
      return anthropicStreamResponse(upstream, { model, msgId, req: request });
    }
    return openAIStreamResponse(upstream, { id, model, req: request });
  }
  return json({ error: { message: "not found" } }, 404, request);
}
