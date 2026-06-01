import { Router } from "express";
import { randomUUID } from "crypto";
import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import { db, userKeysTable, requestLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getNextCcKey, incrementCcKeyUsage, markCcKeyInvalid } from "../lib/key-pool";
import { getNextRcKey, incrementRcKeyUsage, markRcKeyInvalid } from "../lib/rc-pool";
import { isRoutingModel, extractRuleName, resolveRoute } from "../lib/routing-engine";

const router = Router();

const COMMANDCODE_URL        = "https://api.commandcode.ai/alpha/generate";
const COMMANDCODE_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
const COMMANDCODE_VERSION    = "0.26.23";

// ── Right Code (right.codes) ───────────────────────────────────────────────
const RC_BASE             = "https://right.codes";
const RC_MODELS_PUBLIC    = "https://right.codes/models/public";

// ── AiGoCode (aigocode.com) ────────────────────────────────────────────────
const AG_BASE = "https://www.aigocode.com";

type AgApiType = "openai" | "anthropic" | "gemini";

function getAgApiType(modelId: string): AgApiType {
  const m = modelId.replace(/^ag:/, "");
  if (m.startsWith("claude-")) return "anthropic";
  if (m.startsWith("gemini-")) return "gemini";
  return "openai";
}

// API format each channel prefix uses
type RcApiType = "openai" | "openai-responses" | "anthropic" | "gemini";

const RC_CHANNEL_API_TYPE: Record<string, RcApiType> = {
  "/deepseek":           "openai",
  "/codex-pro":          "openai",
  "/codex":              "openai-responses",
  "/deepseek/anthropic": "anthropic",
  "/claude":             "anthropic",
  "/claude-aws":         "anthropic",
  "/gemini":             "gemini",
};

// Human-readable group names shown in the model dropdown
const RC_CHANNEL_GROUP: Record<string, string> = {
  "/deepseek":           "DeepSeek",
  "/codex-pro":          "Codex (Stable)",
  "/codex":              "Codex (Daily)",
  "/deepseek/anthropic": "DeepSeek (Anthropic)",
  "/claude":             "Claude (Official)",
  "/claude-aws":         "Claude (AWS)",
  "/gemini":             "Gemini",
};

// Channels to exclude from chat (image-generation etc.)
const RC_SKIP_PREFIXES = new Set(["/draw"]);

// ── Full benchmark (parallel run, "say hi" prompt, one round) ──────────────────
// zai-org/GLM-5            1891ms  0 reasoning chunks  ← FASTEST (no reasoning!)
// MiniMaxAI/MiniMax-M2.5   1907ms  1 reasoning chunk
// zai-org/GLM-5.1          2422ms  12 reasoning chunks
// deepseek/deepseek-v4-flash 2469ms 22 reasoning chunks
// deepseek/deepseek-v4-pro 3423ms  44 reasoning chunks
// Qwen/Qwen3.7-Max         3523ms  43 reasoning chunks
// stepfun/Step-3.5-Flash   3893ms  52 reasoning chunks
// MiniMaxAI/MiniMax-M2.7   4511ms  30 reasoning chunks  ← slower than M2.5!
// moonshotai/Kimi-K2.5     6149ms  232 reasoning chunks
// Qwen/Qwen3.6-Max-Preview 8202ms  51 reasoning chunks
// Qwen/Qwen3.6-Plus       10582ms  333 reasoning chunks
// moonshotai/Kimi-K2.6    16187ms  39 reasoning chunks  ← SLOWEST (16s!)
// Pro plan models (Claude/GPT/Gemini) → 403 FORBIDDEN on current CC subscription

type ModelDef = { id: string; name: string; group: string; description: string; tier: string; provider?: string };

// ── Enriched metadata for known CC models (group, description, benchmark) ─────
const CC_MODEL_META: Record<string, Partial<ModelDef>> = {
  "zai-org/GLM-5":              { name: "GLM-5 ⚡",             group: "⚡ Fastest",  description: "Fastest — ~1.9s, zero reasoning overhead",       tier: "free" },
  "MiniMaxAI/MiniMax-M2.5":     { name: "MiniMax M2.5 ⚡",      group: "⚡ Fastest",  description: "Fast & consistent — ~1.9s, minimal thinking",    tier: "free" },
  "zai-org/GLM-5.1":            { name: "GLM-5.1 ⚡",           group: "⚡ Fastest",  description: "Fast autonomous agent — ~2.4s",                  tier: "free" },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash ⚡", group: "⚡ Fastest",  description: "Fast & free — ~2.5s (variable)",                 tier: "free" },
  "deepseek/deepseek-v4-pro":   { name: "DeepSeek V4 Pro",      group: "Open Source", description: "High quality, long-context — ~3.4s",             tier: "free" },
  "Qwen/Qwen3.7-Max":           { name: "Qwen 3.7 Max",         group: "Open Source", description: "Frontier coding — ~3.5s",                        tier: "free" },
  "stepfun/Step-3.5-Flash":     { name: "Step 3.5 Flash",       group: "Open Source", description: "Sparse-MoE reasoning — ~3.9s",                   tier: "free" },
  "MiniMaxAI/MiniMax-M2.7":     { name: "MiniMax M2.7",         group: "Open Source", description: "Engineering agent — ~4.5s",                     tier: "free" },
  "moonshotai/Kimi-K2.5":       { name: "Kimi K2.5",            group: "Slow (6s+)", description: "Multimodal frontend coding — ~6s",               tier: "free" },
  "Qwen/Qwen3.6-Max-Preview":   { name: "Qwen 3.6 Max Preview", group: "Slow (6s+)", description: "Agentic coding — ~8s",                           tier: "free" },
  "Qwen/Qwen3.6-Plus":          { name: "Qwen 3.6 Plus",        group: "Slow (6s+)", description: "Heavy reasoning — ~10s (333 thinking steps)",    tier: "free" },
  "moonshotai/Kimi-K2.6":       { name: "Kimi K2.6",            group: "Slow (6s+)", description: "Long-horizon coding — ~16s (slowest)",           tier: "free" },
};

// Fallback static CC list (used if API unreachable)
const CC_MODELS_FALLBACK: ModelDef[] = Object.entries(CC_MODEL_META).map(([id, meta]) => ({
  id,
  name: meta.name ?? id,
  group: meta.group ?? "Other",
  description: meta.description ?? "",
  tier: meta.tier ?? "free",
}));

const CACHE_TTL_MS = 10 * 60 * 1000;

// ── CC models cache (refreshed every 10 minutes) ──────────────────────────────
let ccModelsCache: { models: ModelDef[]; fetchedAt: number } | null = null;

async function fetchCcModels(apiKey: string): Promise<ModelDef[]> {
  if (ccModelsCache && Date.now() - ccModelsCache.fetchedAt < CACHE_TTL_MS) {
    return ccModelsCache.models;
  }
  try {
    const res = await fetch(COMMANDCODE_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-command-code-version": COMMANDCODE_VERSION,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
    const rawModels = data.data ?? [];

    const mapped: ModelDef[] = rawModels.map((m) => {
      const meta = CC_MODEL_META[m.id];
      const autoGroup = (() => {
        if (m.id.startsWith("claude-") || m.id.startsWith("gpt-") || m.id.startsWith("google/")) return "CC Pro Required";
        if (m.owned_by) return m.owned_by;
        return "Other";
      })();
      const autoTier = (m.id.startsWith("claude-") || m.id.startsWith("gpt-") || m.id.startsWith("google/")) ? "pro" : "free";
      return {
        id: m.id,
        name: meta?.name ?? m.id.split("/").pop() ?? m.id,
        group: meta?.group ?? autoGroup,
        description: meta?.description ?? `Model ID: ${m.id}`,
        tier: (meta?.tier ?? autoTier) as "free" | "pro",
      };
    });

    const knownOrder = Object.keys(CC_MODEL_META);
    mapped.sort((a, b) => {
      const ai = knownOrder.indexOf(a.id);
      const bi = knownOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return a.id.localeCompare(b.id);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    ccModelsCache = { models: mapped, fetchedAt: Date.now() };
    return mapped;
  } catch {
    return ccModelsCache?.models ?? CC_MODELS_FALLBACK;
  }
}

// ── RC models cache (public endpoint, no auth needed) ─────────────────────────
let rcModelsCache: { models: ModelDef[]; fetchedAt: number } | null = null;

function prettifyRcModelName(raw: string): string {
  return raw
    .replace(/^(claude)-(opus|sonnet|haiku)-(\d[\d-]*)/i, (_, __, tier, v) =>
      `Claude ${tier.charAt(0).toUpperCase() + tier.slice(1)} ${v}`)
    .replace(/^gemini-(\d+\.\d+)-(.*)/i, (_, v, tier) => `Gemini ${v} ${tier}`)
    .replace(/^gpt-(\S+)/i, (_, v) => `GPT-${v}`)
    .replace(/^deepseek-(v\d+)-(flash|pro)/i, (_, v, tier) =>
      `DeepSeek ${v} ${tier.charAt(0).toUpperCase() + tier.slice(1)}`)
    .replace(/^codex-auto-review$/i, "Codex Auto Review")
    .replace(/-/g, " ")
    .replace(/\b(\w)/g, (c) => c.toUpperCase())
    // Undo over-capitalisation of version segments that look like "4 5"
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchRcModels(): Promise<ModelDef[]> {
  if (rcModelsCache && Date.now() - rcModelsCache.fetchedAt < CACHE_TTL_MS) {
    return rcModelsCache.models;
  }
  try {
    const res = await fetch(RC_MODELS_PUBLIC);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      upstreams: Array<{
        name: string;
        prefix: string;
        models: Array<{ name: string; is_available: boolean }>;
      }>;
    };

    const models: ModelDef[] = [];

    for (const upstream of data.upstreams) {
      if (RC_SKIP_PREFIXES.has(upstream.prefix)) continue;
      const group = RC_CHANNEL_GROUP[upstream.prefix] ?? upstream.name;

      for (const m of upstream.models) {
        models.push({
          // encode channel prefix and model name separated by |
          id: `rc:${upstream.prefix}|${m.name}`,
          name: prettifyRcModelName(m.name),
          group,
          description: `${m.name} • ${group} (${m.is_available ? "available" : "unavailable"})`,
          tier: "free",
          provider: "rightcode",
        });
      }
    }

    rcModelsCache = { models, fetchedAt: Date.now() };
    return models;
  } catch (err) {
    return rcModelsCache?.models ?? [];
  }
}

// Parse rc:{channelPrefix}|{modelName} → { prefix, modelName }
// Falls back to guessing prefix for old-format rc:{modelName} IDs.
function parseRcModelId(id: string): { prefix: string; modelName: string } {
  const rest = id.startsWith("rc:") ? id.slice(3) : id;
  const pipe = rest.indexOf("|");
  if (pipe !== -1) {
    return { prefix: rest.slice(0, pipe), modelName: rest.slice(pipe + 1) };
  }
  // Legacy / fallback: guess channel from model name
  if (rest.startsWith("claude-"))   return { prefix: "/claude",    modelName: rest };
  if (rest.startsWith("gemini-"))   return { prefix: "/gemini",    modelName: rest };
  if (rest.startsWith("deepseek-")) return { prefix: "/deepseek",  modelName: rest };
  return { prefix: "/codex-pro", modelName: rest };
}

// Build the upstream URL for an RC model
function getRcUpstreamUrl(prefix: string, modelName: string): string {
  const apiType = RC_CHANNEL_API_TYPE[prefix] ?? "openai";
  if (apiType === "gemini")
    return `${RC_BASE}${prefix}/rbeta/models/${modelName}:streamGenerateContent?alt=sse`;
  if (apiType === "anthropic")
    return `${RC_BASE}${prefix}/v1/messages`;
  if (apiType === "openai-responses")
    return `${RC_BASE}${prefix}/v1/responses`;
  // "openai"
  return `${RC_BASE}${prefix}/v1/chat/completions`;
}

// ── AG models cache (per-key, 10 min TTL) ─────────────────────────────────────
const agModelsCache = new Map<string, { models: ModelDef[]; fetchedAt: number }>();

async function fetchAgModels(apiKey: string): Promise<ModelDef[]> {
  const cached = agModelsCache.get(apiKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.models;
  try {
    const res = await fetch(`${AG_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
    const rawModels = data.data ?? [];

    const models: ModelDef[] = rawModels.map((m) => {
      const apiType = getAgApiType(`ag:${m.id}`);
      const group =
        apiType === "anthropic" ? "Claude" :
        apiType === "gemini"    ? "Gemini" :
        m.id.startsWith("gpt-") ? "GPT" :
        m.id.startsWith("deepseek-") ? "DeepSeek" :
        "Other";
      return {
        id: `ag:${m.id}`,
        name: m.id,
        group,
        description: `${m.id} via AiGoCode`,
        tier: "free" as const,
        provider: "aigocode",
      };
    });

    agModelsCache.set(apiKey, { models, fetchedAt: Date.now() });
    return models;
  } catch {
    return agModelsCache.get(apiKey)?.models ?? [];
  }
}

// ── GET /chat/models — CommandCode models (dynamic, cached) ──────────────────
router.get("/chat/models", async (req, res) => {
  const apiKey =
    process.env.COMMANDCODE_API_KEY ||
    (await (async () => { const k = await getNextCcKey(); return k?.key; })());
  if (!apiKey) {
    res.json({ models: CC_MODELS_FALLBACK });
    return;
  }
  const models = await fetchCcModels(apiKey);
  res.json({ models });
});

// ── GET /chat/rc-pool-status — how many active server-side RC keys exist ─────
router.get("/chat/rc-pool-status", async (_req, res) => {
  try {
    const key = await getNextRcKey();
    res.json({ active: key ? 1 : 0 });
  } catch {
    res.json({ active: 0 });
  }
});

// ── GET /chat/rc-models — Right Code models (public, cached 10 min) ──────────
router.get("/chat/rc-models", async (req, res) => {
  try {
    const models = await fetchRcModels();
    res.json({ models });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch Right Code models");
    res.status(500).json({ error: "Failed to fetch Right Code models" });
  }
});

// ── GET /chat/ag-models — AiGoCode models (per-key, cached 10 min) ───────────
router.get("/chat/ag-models", async (req, res) => {
  const agKey = req.headers["x-aigocode-key"] as string | undefined;
  if (!agKey) {
    res.status(400).json({ error: "AiGoCode API key required (X-Aigocode-Key header)" });
    return;
  }
  try {
    const models = await fetchAgModels(agKey);
    res.json({ models });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch AiGoCode models");
    res.status(500).json({ error: "Failed to fetch AiGoCode models" });
  }
});

router.post("/chat/stream", async (req, res) => {
  const headerKey = req.headers["x-api-key"] as string | undefined;

  let resolvedApiKey: string | undefined;
  let userKeyId: string | undefined;
  let ccKeyId: string | undefined;
  const startTime = Date.now();

  if (headerKey) {
    if (headerKey.startsWith("sk-cc-")) {
      const rows = await db.select().from(userKeysTable).where(eq(userKeysTable.key, headerKey)).limit(1);
      if (!rows[0]) { res.status(403).json({ error: "Invalid API key" }); return; }
      if (!rows[0].isActive) { res.status(403).json({ error: "API key is disabled" }); return; }
      userKeyId = rows[0].id;
      const poolKey = await getNextCcKey();
      if (!poolKey) { res.status(503).json({ error: "No active CommandCode API keys in pool" }); return; }
      resolvedApiKey = poolKey.key;
      ccKeyId = poolKey.id;
    } else {
      resolvedApiKey = headerKey;
    }
  } else {
    const poolKey = await getNextCcKey();
    if (poolKey) { resolvedApiKey = poolKey.key; ccKeyId = poolKey.id; }
    else { resolvedApiKey = process.env.COMMANDCODE_API_KEY; }
  }

  if (!resolvedApiKey) {
    res.status(500).json({ error: "No API key configured" });
    return;
  }

  type WireImage = { data: string; mimeType: string };
  type WireMessage = { role: string; content: string; images?: WireImage[] };

  const { messages, model, system } = req.body as {
    messages: WireMessage[];
    model?: string;
    system?: string;
  };

  // ── Vision content builders ───────────────────────────────────────────────
  function buildAnthropicContent(content: string, images?: WireImage[]) {
    if (!images || images.length === 0) return content;
    const parts: unknown[] = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data },
    }));
    if (content) parts.push({ type: "text", text: content });
    return parts;
  }

  function buildOpenAIContent(content: string, images?: WireImage[]) {
    if (!images || images.length === 0) return content;
    const parts: unknown[] = [
      ...images.map((img) => ({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.data}` },
      })),
      ...(content ? [{ type: "text", text: content }] : []),
    ];
    return parts;
  }

  function buildGeminiParts(content: string, images?: WireImage[]) {
    const parts: unknown[] = [];
    if (images && images.length > 0) {
      parts.push(...images.map((img) => ({
        inlineData: { mimeType: img.mimeType, data: img.data },
      })));
    }
    if (content) parts.push({ text: content });
    return parts;
  }

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const requestedModel = model || "zai-org/GLM-5";

  // ── Smart Routing: resolve route:* model references ──────────────────────
  let selectedModel = requestedModel;
  if (isRoutingModel(requestedModel)) {
    const ruleName = extractRuleName(requestedModel);
    const result = await resolveRoute(ruleName);
    if (!result.ok) {
      const errMsg = result.reason === "all_rate_limited"
        ? `All providers in routing rule "${ruleName}" are rate-limited. Try again shortly.`
        : `Routing rule "${ruleName}" not found or inactive.`;
      res.status(result.reason === "all_rate_limited" ? 429 : 404).json({ error: errMsg });
      return;
    }
    selectedModel = result.route.modelId;
    req.log.info({ ruleName, resolved: result.route }, "Smart routing resolved");
  }

  const isRightCode = selectedModel.startsWith("rc:");
  const isAiGoCode  = selectedModel.startsWith("ag:");

  // ── Logging helper ────────────────────────────────────────────────────────────
  const logRequest = (status: "ok" | "error", errorMsg?: string) => {
    const elapsedMs = Date.now() - startTime;
    const ops: Promise<unknown>[] = [
      db.insert(requestLogsTable).values({
        id: randomUUID(),
        userKeyId: userKeyId ?? null,
        ccKeyId: ccKeyId ?? null,
        model: selectedModel,
        elapsedMs,
        status,
        errorMsg: errorMsg?.slice(0, 255) ?? null,
      }),
    ];
    if (userKeyId) {
      ops.push(
        db.update(userKeysTable)
          .set({ usageCount: sql`${userKeysTable.usageCount} + 1`, lastUsedAt: new Date() })
          .where(eq(userKeysTable.id, userKeyId))
      );
    }
    if (ccKeyId) ops.push(incrementCcKeyUsage(ccKeyId));
    Promise.all(ops).catch(() => {});
  };

  // ── SSE helpers ───────────────────────────────────────────────────────────────
  const flush = (r: typeof res) => (r as unknown as { flush?: () => void }).flush?.();

  const startSse = () => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Transfer-Encoding", "chunked");
    // Disable TCP Nagle to send SSE chunks immediately without batching
    (res.socket as import("node:net").Socket | null)?.setNoDelay?.(true);
    res.flushHeaders();
  };

  const sendText = (text: string) => {
    res.write(`data: ${JSON.stringify({ type: "text-delta", id: "0", text })}\n\n`);
    flush(res);
  };

  // ════════════════════════════════════════════════════════════════════════════
  // RIGHT CODE path
  // ════════════════════════════════════════════════════════════════════════════
  if (isRightCode) {
    const userRcKey = req.headers["x-rightcode-key"] as string | undefined;
    let rcKey = userRcKey;
    let rcPoolKeyId: string | undefined;

    if (!rcKey) {
      // Fall back to server-side RC key pool
      const poolKey = await getNextRcKey();
      if (poolKey) {
        rcKey = poolKey.key;
        rcPoolKeyId = poolKey.id;
      } else {
        res.status(400).json({
          error: "Right Code API key required. Add your key in System Configuration, or ask the admin to add pool keys.",
        });
        return;
      }
    }

    const { prefix, modelName } = parseRcModelId(selectedModel);
    const apiType = RC_CHANNEL_API_TYPE[prefix] ?? "openai";
    const upstreamUrl = getRcUpstreamUrl(prefix, modelName);
    const systemMsg = system || "You are a helpful AI assistant.";

    req.log.info({ prefix, modelName, apiType, upstreamUrl }, "RC stream request");

    // ── /claude Official: use @anthropic-ai/sdk directly ─────────────────────
    // right.codes /claude channel requires an exact Claude Code CLI request:
    // Bearer auth (ANTHROPIC_AUTH_TOKEN), correct stainless SDK headers, thinking
    // param, temperature:1 — the SDK generates all of this automatically.
    if (prefix === "/claude") {
      // SDK version 0.100.x corresponds to Claude Code 2.x releases.
      // user-agent must be consistent with the SDK's own stainless headers.
      const client = new Anthropic({
        authToken: rcKey,
        baseURL: `${RC_BASE}/claude`,
        defaultHeaders: {
          "user-agent": "claude-code/2.1.148",
          "x-claude-code-disable-nonessential-traffic": "1",
          "x-app": "cli",
          "anthropic-beta": "claudecode-2025-05-14,interleaved-thinking-2025-05-14,files-api-2025-04-14,output-128k-2025-02-19,extended-cache-ttl-2025-04-11",
        },
      });

      startSse();
      try {
        const sdkMessages: Anthropic.MessageParam[] = messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: buildAnthropicContent(m.content, m.images) as Anthropic.ContentBlockParam[] | string,
        }));

        const stream = client.messages.stream({
          model: modelName,
          max_tokens: 32000,
          messages: sdkMessages,
          ...(systemMsg ? { system: systemMsg } : {}),
          thinking: { type: "adaptive", budget_tokens: 10000 },
          temperature: 1,
        });

        for await (const event of stream) {
          if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              sendText(delta.text);
            } else if (delta.type === "thinking_delta") {
              res.write(`data: ${JSON.stringify({ type: "reasoning-delta", id: "0", text: delta.thinking })}\n\n`);
              flush(res);
            }
          }
        }

        res.write("data: [DONE]\n\n");
        flush(res);
        logRequest("ok");
        if (rcPoolKeyId) incrementRcKeyUsage(rcPoolKeyId).catch(() => {});
        res.end();
      } catch (err) {
        const errStr = String(err);
        req.log.error({ err }, "Anthropic SDK error for /claude channel");
        logRequest("error", errStr);
        if (rcPoolKeyId && (errStr.includes("401") || errStr.includes("403"))) {
          markRcKeyInvalid(rcPoolKeyId).catch(() => {});
        }
        if (!res.headersSent) {
          res.status(500).json({ error: errStr });
        } else {
          res.write(`data: ${JSON.stringify({ type: "error", error: errStr })}\n\n`);
          res.end();
        }
      }
      return;
    }

    let upstreamHeaders: Record<string, string>;
    let upstreamBody: Record<string, unknown>;

    if (apiType === "anthropic") {
      // ── Anthropic-compatible (/claude-aws, /deepseek/anthropic) ──────────
      upstreamHeaders = {
        "Content-Type": "application/json",
        "x-api-key": rcKey,
        "anthropic-version": "2023-06-01",
      };
      upstreamBody = {
        model: modelName,
        messages: messages.map((m) => ({
          role: m.role,
          content: buildAnthropicContent(m.content, m.images),
        })),
        system: systemMsg,
        max_tokens: 16000,
        stream: true,
      };
    } else if (apiType === "gemini") {
      // ── Gemini-compatible ─────────────────────────────────────────────────
      upstreamHeaders = {
        "Content-Type": "application/json",
        "x-api-key": rcKey,
      };
      upstreamBody = {
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: buildGeminiParts(m.content, m.images),
        })),
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
        generationConfig: { temperature: 1 },
      };
    } else if (apiType === "openai-responses") {
      // ── OpenAI Responses API (/v1/responses) ─────────────────────────────
      upstreamHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rcKey}`,
      };
      const inputMsgs: unknown[] = systemMsg
        ? [{ role: "system", content: systemMsg }, ...messages.map((m) => ({
            role: m.role,
            content: buildOpenAIContent(m.content, m.images),
          }))]
        : messages.map((m) => ({
            role: m.role,
            content: buildOpenAIContent(m.content, m.images),
          }));
      upstreamBody = {
        model: modelName,
        input: inputMsgs,
        stream: true,
      };
    } else {
      // ── OpenAI Chat Completions (/v1/chat/completions) ────────────────────
      upstreamHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rcKey}`,
      };
      const allMsgs: unknown[] = systemMsg
        ? [{ role: "system", content: systemMsg }, ...messages.map((m) => ({
            role: m.role,
            content: buildOpenAIContent(m.content, m.images),
          }))]
        : messages.map((m) => ({
            role: m.role,
            content: buildOpenAIContent(m.content, m.images),
          }));
      upstreamBody = { model: modelName, messages: allMsgs, stream: true };
    }

    try {
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamBody),
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        req.log.error({ status: upstream.status, body: text, upstreamUrl }, "Right Code API error");
        if (rcPoolKeyId && (upstream.status === 401 || upstream.status === 403)) {
          markRcKeyInvalid(rcPoolKeyId).catch(() => {});
        }
        let userMessage = text.slice(0, 300);
        // Improve "anomaly detected" / auth errors
        if (upstream.status === 400 && text.includes("anomaly")) {
          userMessage = "right.codes رفض الطلب (anomaly detected). قد يكون المفتاح مرتبطاً بجلسة محددة ولا يعمل عبر السيرفر.";
        } else if (upstream.status === 401 || upstream.status === 403) {
          userMessage = `مفتاح Right Code غير صالح أو انتهت صلاحيته. (${upstream.status})`;
        }
        logRequest("error", userMessage.slice(0, 255));
        res.status(upstream.status).json({ error: userMessage });
        return;
      }

      startSse();
      if (!upstream.body) { logRequest("ok"); res.end(); return; }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let lastEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            lastEvent = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith("data:")) { lastEvent = ""; continue; }
          const jsonStr = line.slice(5).trim();
          if (jsonStr === "[DONE]") { lastEvent = ""; continue; }
          try {
            const chunk = JSON.parse(jsonStr) as Record<string, unknown>;

            if (apiType === "openai" || apiType === "openai-responses") {
              // OpenAI chat completions delta
              const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
              const content = choices?.[0]?.delta?.content;
              if (content) { sendText(content); lastEvent = ""; continue; }

              // OpenAI responses API delta (event: response.output_text.delta)
              if (lastEvent === "response.output_text.delta") {
                const delta = chunk.delta as string | undefined;
                if (delta) sendText(delta);
              } else if (chunk.type === "response.output_text.delta") {
                const delta = chunk.delta as string | undefined;
                if (delta) sendText(delta);
              }
            } else if (apiType === "anthropic") {
              if (lastEvent === "content_block_delta") {
                const delta = chunk.delta as { type?: string; text?: string; thinking?: string } | undefined;
                if (delta?.type === "text_delta" && delta.text) {
                  sendText(delta.text);
                } else if (delta?.type === "thinking_delta" && delta.thinking) {
                  // Forward thinking content as reasoning-delta (same format as CC)
                  res.write(`data: ${JSON.stringify({ type: "reasoning-delta", id: "0", text: delta.thinking })}\n\n`);
                  flush(res);
                }
              }
            } else if (apiType === "gemini") {
              const candidates = chunk.candidates as Array<{
                content?: { parts?: Array<{ text?: string }> };
              }> | undefined;
              const text = candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) sendText(text);
            }

            lastEvent = "";
          } catch { /* skip malformed */ }
        }
      }

      res.write("data: [DONE]\n\n");
      flush(res);
      logRequest("ok");
      if (rcPoolKeyId) incrementRcKeyUsage(rcPoolKeyId).catch(() => {});
      res.end();
    } catch (err) {
      req.log.error({ err }, "Error proxying to Right Code");
      logRequest("error", String(err));
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AIGOCODE path
  // ════════════════════════════════════════════════════════════════════════════
  if (isAiGoCode) {
    const agKey = req.headers["x-aigocode-key"] as string | undefined;
    if (!agKey) {
      res.status(400).json({ error: "AiGoCode API key required. Add your key in settings." });
      return;
    }

    const rawModelId = selectedModel.replace(/^ag:/, "");
    const apiType = getAgApiType(selectedModel);
    const systemMsg = system || "You are a helpful AI assistant.";

    req.log.info({ rawModelId, apiType }, "AG stream request");

    let upstreamUrl: string;
    let upstreamHeaders: Record<string, string>;
    let upstreamBody: Record<string, unknown>;

    if (apiType === "anthropic") {
      upstreamUrl = `${AG_BASE}/v1/messages`;
      upstreamHeaders = {
        "Content-Type": "application/json",
        "x-api-key": agKey,
        "anthropic-version": "2023-06-01",
      };
      upstreamBody = {
        model: rawModelId,
        messages: messages.map((m) => ({
          role: m.role,
          content: buildAnthropicContent(m.content, m.images),
        })),
        system: systemMsg,
        max_tokens: 16000,
        stream: true,
      };
    } else if (apiType === "gemini") {
      upstreamUrl = `${AG_BASE}/v1beta/models/${rawModelId}:streamGenerateContent?alt=sse`;
      upstreamHeaders = {
        "Content-Type": "application/json",
        "x-api-key": agKey,
      };
      upstreamBody = {
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: buildGeminiParts(m.content, m.images),
        })),
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
        generationConfig: { temperature: 1 },
      };
    } else {
      // OpenAI-compatible (default)
      upstreamUrl = `${AG_BASE}/v1/chat/completions`;
      upstreamHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agKey}`,
      };
      const allMsgs: unknown[] = systemMsg
        ? [{ role: "system", content: systemMsg }, ...messages.map((m) => ({
            role: m.role,
            content: buildOpenAIContent(m.content, m.images),
          }))]
        : messages.map((m) => ({
            role: m.role,
            content: buildOpenAIContent(m.content, m.images),
          }));
      upstreamBody = { model: rawModelId, messages: allMsgs, stream: true };
    }

    try {
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamBody),
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        req.log.error({ status: upstream.status, body: text, upstreamUrl }, "AiGoCode API error");
        let userMessage = text.slice(0, 300);
        if (upstream.status === 401 || upstream.status === 403) {
          userMessage = `مفتاح AiGoCode غير صالح أو انتهت صلاحيته. (${upstream.status})`;
        }
        logRequest("error", userMessage.slice(0, 255));
        res.status(upstream.status).json({ error: userMessage });
        return;
      }

      startSse();
      if (!upstream.body) { logRequest("ok"); res.end(); return; }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let lastEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) { lastEvent = line.slice(6).trim(); continue; }
          if (!line.startsWith("data:")) { lastEvent = ""; continue; }
          const jsonStr = line.slice(5).trim();
          if (jsonStr === "[DONE]") { lastEvent = ""; continue; }
          try {
            const chunk = JSON.parse(jsonStr) as Record<string, unknown>;

            if (apiType === "openai") {
              const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
              const content = choices?.[0]?.delta?.content;
              if (content) sendText(content);
            } else if (apiType === "anthropic") {
              if (lastEvent === "content_block_delta") {
                const delta = chunk.delta as { type?: string; text?: string } | undefined;
                if (delta?.type === "text_delta" && delta.text) sendText(delta.text);
              }
            } else if (apiType === "gemini") {
              const candidates = chunk.candidates as Array<{
                content?: { parts?: Array<{ text?: string }> };
              }> | undefined;
              const text = candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) sendText(text);
            }

            lastEvent = "";
          } catch { /* skip malformed */ }
        }
      }

      res.write("data: [DONE]\n\n");
      flush(res);
      logRequest("ok");
      res.end();
    } catch (err) {
      req.log.error({ err }, "Error proxying to AiGoCode");
      logRequest("error", String(err));
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // COMMANDCODE path (existing logic)
  // ════════════════════════════════════════════════════════════════════════════
  function resolveOssProvider(modelId: string): string | null {
    if (modelId.startsWith("deepseek/")) return "deepseek";
    if (modelId.startsWith("google/")) return "google";
    if (modelId.startsWith("stepfun/")) return "stepfun";
    if (modelId.startsWith("claude-")) return "anthropic";
    if (modelId.startsWith("gpt-")) return "openai";
    if (modelId.startsWith("moonshotai/")) return "moonshotai";
    if (modelId.startsWith("MiniMaxAI/")) return "MiniMaxAI";
    if (modelId.startsWith("zai-org/")) return "zai-org";
    if (modelId.startsWith("Qwen/")) return "Qwen";
    return null;
  }

  const osName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const ossProvider = resolveOssProvider(selectedModel);

  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${resolvedApiKey}`,
    "Content-Type": "application/json",
    "x-command-code-version": COMMANDCODE_VERSION,
    "x-cli-environment": "production",
    "x-project-slug": "chatbot-session",
    "x-session-id": randomUUID(),
    "User-Agent": "node-fetch",
    ...(ossProvider ? { "x-oss-primary-provider": ossProvider } : {}),
  };

  const body = {
    config: {
      workingDir: "/workspace",
      date: new Date().toISOString().split("T")[0],
      environment: `${osName}-${os.arch()}, Node.js v20.0.0`,
      structure: [],
      isGitRepo: false,
      currentBranch: "main",
      mainBranch: "main",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: null,
    skills: null,
    permissionMode: "auto-accept",
    params: {
      model: selectedModel,
      messages,
      tools: [],
      system: system || "You are a helpful AI assistant.",
      max_tokens: 64000,
      stream: true,
    },
  };

  try {
    const upstream = await fetch(COMMANDCODE_URL, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      req.log.error({ status: upstream.status, body: text }, "CommandCode API error");
      if ((upstream.status === 401 || upstream.status === 403) && ccKeyId) {
        await markCcKeyInvalid(ccKeyId);
      }
      let userMessage = text;
      try {
        const outer = JSON.parse(text) as { error?: string };
        const inner = JSON.parse(outer.error ?? "{}") as { error?: { code?: string; message?: string } };
        const msg = inner?.error?.message ?? "";
        const code = inner?.error?.code ?? "";
        if (code === "MODEL_NOT_IN_PLAN" || upstream.status === 403) {
          userMessage = `MODEL_NOT_IN_PLAN: ${msg || "This model requires a Pro plan."}`;
        } else if (msg) {
          userMessage = msg;
        }
      } catch { /* keep raw */ }
      logRequest("error", userMessage);
      res.status(upstream.status).json({ error: userMessage });
      return;
    }

    startSse();
    if (!upstream.body) { logRequest("ok"); res.end(); return; }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed) as Record<string, unknown>;
          const type = chunk.type as string | undefined;
          if (type === "text-delta" || type === "reasoning-delta") {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            flush(res);
          } else if (type === "finish" || type === "error") {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            flush(res);
          }
        } catch {
          res.write(`data: ${trimmed}\n\n`);
          flush(res);
        }
      }
    }

    if (lineBuffer.trim()) {
      try {
        const chunk = JSON.parse(lineBuffer.trim()) as Record<string, unknown>;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } catch { /* ignore */ }
    }

    res.write("data: [DONE]\n\n");
    flush(res);
    logRequest("ok");
    res.end();
  } catch (err) {
    req.log.error({ err }, "Error proxying to CommandCode");
    logRequest("error", String(err));
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CUSTOM PROVIDER STREAM  — POST /chat/custom-stream
// Accepts: { baseUrl, apiKey, apiType, model, messages, system }
// apiType: "auto" | "openai" | "codex" | "anthropic"
// When "auto": tries openai → codex → anthropic until one succeeds.
// ════════════════════════════════════════════════════════════════════════════

type CustomApiType = "openai" | "codex" | "anthropic";

type CustomWireMessage = { role: string; content: string };

function buildCustomUpstream(
  base: string,
  type: CustomApiType,
  apiKey: string | undefined,
  model: string,
  messages: CustomWireMessage[],
  systemMsg: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const auth: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};

  if (type === "openai") {
    const allMsgs = systemMsg
      ? [{ role: "system", content: systemMsg }, ...messages]
      : messages;
    return {
      url: `${base}/v1/chat/completions`,
      headers: { "Content-Type": "application/json", ...auth },
      body: { model, messages: allMsgs, stream: true },
    };
  }

  if (type === "codex") {
    const inputMsgs = systemMsg
      ? [{ role: "system", content: systemMsg }, ...messages]
      : messages;
    return {
      url: `${base}/v1/responses`,
      headers: { "Content-Type": "application/json", ...auth },
      body: { model, input: inputMsgs, stream: true },
    };
  }

  // anthropic
  return {
    url: `${base}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: {
      model,
      messages,
      system: systemMsg || undefined,
      max_tokens: 16384,
      stream: true,
    },
  };
}

function parseCustomChunk(
  type: CustomApiType,
  jsonStr: string,
  lastEvent: string,
): string | null {
  try {
    const chunk = JSON.parse(jsonStr) as Record<string, unknown>;

    if (type === "openai") {
      // Standard SSE delta
      const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
      const text = choices?.[0]?.delta?.content;
      if (text) return text;
      // Responses API delta (event: response.output_text.delta)
      if (lastEvent === "response.output_text.delta" || chunk.type === "response.output_text.delta") {
        const delta = chunk.delta as string | undefined;
        if (delta) return delta;
      }
      return null;
    }

    if (type === "codex") {
      // Codex /v1/responses SSE events
      if (lastEvent === "response.output_text.delta" || chunk.type === "response.output_text.delta") {
        const delta = chunk.delta as string | undefined;
        if (delta) return delta;
      }
      // Also handle openai-like delta in case the provider maps it
      const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined;
      const content = choices?.[0]?.delta?.content;
      if (content) return content;
      return null;
    }

    // anthropic
    if (lastEvent === "content_block_delta") {
      const delta = chunk.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) return delta.text;
    }
    return null;
  } catch {
    return null;
  }
}

router.post("/chat/custom-stream", async (req, res) => {
  const {
    baseUrl,
    apiKey,
    apiType,
    model,
    messages,
    system,
  } = req.body as {
    baseUrl?: string;
    apiKey?: string;
    apiType?: "auto" | CustomApiType;
    model?: string;
    messages?: CustomWireMessage[];
    system?: string;
  };

  if (!baseUrl || !model) {
    res.status(400).json({ error: "baseUrl and model are required" });
    return;
  }
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const base = baseUrl.replace(/\/$/, "");
  const systemMsg = system || "You are a helpful AI assistant.";

  const typesToTry: CustomApiType[] =
    !apiType || apiType === "auto"
      ? ["openai", "codex", "anthropic"]
      : [apiType];

  const flush = () => (res as unknown as { flush?: () => void }).flush?.();
  const sendText = (text: string) => {
    res.write(`data: ${JSON.stringify({ type: "text-delta", id: "0", text })}\n\n`);
    flush();
  };

  let lastError = "";

  for (const type of typesToTry) {
    const { url, headers, body } = buildCustomUpstream(base, type, apiKey, model, messages, systemMsg);

    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => `HTTP ${upstream.status}`);
        lastError = text.slice(0, 300);
        req.log.warn({ type, status: upstream.status, url }, "custom-stream attempt failed, trying next");
        continue;
      }

      // ── Stream found — start SSE ─────────────────────────────────────────
      req.log.info({ type, url }, "custom-stream connected");
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-Custom-Api-Type", type);
      (res.socket as import("node:net").Socket | null)?.setNoDelay?.(true);
      res.flushHeaders();

      if (!upstream.body) { res.write("data: [DONE]\n\n"); res.end(); return; }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let lastEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) { lastEvent = line.slice(6).trim(); continue; }
          if (!line.startsWith("data:")) { lastEvent = ""; continue; }
          const jsonStr = line.slice(5).trim();
          if (jsonStr === "[DONE]") { lastEvent = ""; continue; }

          const text = parseCustomChunk(type, jsonStr, lastEvent);
          if (text) sendText(text);
          lastEvent = "";
        }
      }

      res.write("data: [DONE]\n\n");
      flush();
      res.end();
      return;
    } catch (err) {
      lastError = String(err).slice(0, 200);
      req.log.warn({ type, err }, "custom-stream attempt error, trying next");
    }
  }

  // All types failed
  req.log.error({ baseUrl, model, typesToTry, lastError }, "custom-stream: all types failed");
  if (!res.headersSent) {
    res.status(502).json({
      error: `فشل الاتصال بـ ${base}. جُرِّبت الأنواع: ${typesToTry.join(", ")}. آخر خطأ: ${lastError}`,
    });
  }
});

export default router;
