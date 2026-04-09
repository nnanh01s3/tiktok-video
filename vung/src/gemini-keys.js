/**
 * Gemini API Key Pool — Smart rotation with per-key per-model usage tracking.
 *
 * Problem: Gemini free tier rate limits are per-project (not per-key).
 * Solution: Use multiple API keys from different projects (10 keys) to scale quota.
 *
 * This module:
 *   - Loads keys from env (GEMINI_API_KEY + GEMINI_API_KEY1..10)
 *   - Tracks usage per (key, model) per day in a state file
 *   - Returns the key with lowest usage for the requested model
 *   - Marks keys as exhausted when API returns 429/RESOURCE_EXHAUSTED
 *
 * Daily quotas (Gemini free tier, as of 2026):
 *   - Veo 2.0: 2 per day per project
 *   - Imagen 4.0: ~50 per day per project
 *   - Gemini TTS: ~100 per day per project
 *
 * Usage:
 *   import { getClient, markKeyExhausted } from "./gemini-keys.js";
 *   const { client, keyId } = getClient("veo");
 *   try {
 *     await client.models.generateVideos(...);
 *   } catch (err) {
 *     if (err.status === 429) markKeyExhausted(keyId, "veo");
 *     throw err;
 *   }
 */
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const STATE_FILE = "D:/tiktok/vung/output/gemini_key_usage.json";

// Daily quota per model per project
// Veo: billed tier (no hard daily limit, only RPM); 50 = safe budget per key
// Others: free tier daily limits
const DAILY_QUOTAS = {
  veo: 50,         // Veo 3.1 Lite billed: ~50/day/key budget (no hard limit)
  imagen: 50,      // Imagen 4.0 free tier: conservative estimate
  tts: 100,        // Gemini TTS free tier: conservative estimate
  text: 250,       // Gemini Flash text: 250/day
};

// ── Load keys from env ───────────────────────────────────────────────────
//
// Two pools of keys:
//   - FREE pool (all keys): GEMINI_API_KEY + GEMINI_API_KEY1..N
//     Used for Imagen, TTS, Gemini text — these models work on free tier
//   - VEO pool (billed only): GEMINI_VEO_KEY_1..N
//     Used for Veo — billing required since April 2026
//
// User must copy their billed API keys to GEMINI_VEO_KEY_1..N in .env
function loadKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) {
    keys.push({ id: "key_0", value: process.env.GEMINI_API_KEY });
  }
  for (let i = 1; i <= 20; i++) {
    const val = process.env[`GEMINI_API_KEY${i}`];
    if (val) keys.push({ id: `key_${i}`, value: val });
  }
  if (keys.length === 0) {
    throw new Error("No GEMINI_API_KEY found in environment");
  }
  return keys;
}

function loadVeoKeys() {
  const keys = [];
  for (let i = 1; i <= 20; i++) {
    const val = process.env[`GEMINI_VEO_KEY_${i}`];
    if (val) keys.push({ id: `veo_key_${i}`, value: val });
  }
  return keys;
}

function loadKeysForModel(model) {
  if (model === "veo") {
    const veoKeys = loadVeoKeys();
    if (veoKeys.length === 0) {
      throw new Error(
        "No Veo-capable keys found. Set GEMINI_VEO_KEY_1..N in .env with billed API keys.\n" +
        "Veo requires GCP billing (enabled per project). Free-tier keys won't work."
      );
    }
    return veoKeys;
  }
  return loadKeys();
}

// ── State management (persistent across runs) ─────────────────────────────
function loadState() {
  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(STATE_FILE)) {
    return { date: today, usage: {} };
  }
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // Reset if new day
    if (state.date !== today) {
      return { date: today, usage: {} };
    }
    return state;
  } catch {
    return { date: today, usage: {} };
  }
}

function saveState(state) {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getKeyUsage(state, keyId, model) {
  return state.usage?.[keyId]?.[model] || 0;
}

function incrementKeyUsage(state, keyId, model) {
  if (!state.usage[keyId]) state.usage[keyId] = {};
  state.usage[keyId][model] = (state.usage[keyId][model] || 0) + 1;
  saveState(state);
}

// ── Key selection strategy ───────────────────────────────────────────────
// Strategy: least-used per model, tie-break by total usage, then first-in-array.
// - Spreads load evenly → no single key gets burned first
// - Deterministic → easy to debug ("key_3 was picked at 14:32")
// - Quota-aware → filters exhausted keys before sorting

function pickBestKey(keys, state, model) {
  const quota = DAILY_QUOTAS[model] || 999;

  // Compute [modelUsage, totalUsage] for each key once
  const withUsage = keys.map((key) => {
    const perKey = state.usage?.[key.id] || {};
    const modelUsage = perKey[model] || 0;
    const totalUsage = Object.values(perKey).reduce((a, b) => a + b, 0);
    return { key, modelUsage, totalUsage };
  });

  // Filter out keys that hit the quota for this model
  const available = withUsage.filter((k) => k.modelUsage < quota);
  if (available.length === 0) return null;

  // Sort: model usage ASC → total usage ASC (stable sort preserves array order)
  available.sort((a, b) => a.modelUsage - b.modelUsage || a.totalUsage - b.totalUsage);

  return available[0].key;
}

// ── Public API ───────────────────────────────────────────────────────────
const _clients = new Map(); // Cache clients per key to avoid reconnecting

/**
 * Get a Gemini client with the best available key for the given model.
 *
 * Veo uses billed-only keys (GEMINI_VEO_KEY_*).
 * Other models use full pool (GEMINI_API_KEY + GEMINI_API_KEY1..N).
 *
 * @param {string} model - "veo" | "imagen" | "tts" | "text"
 * @returns {{ client: GoogleGenAI, keyId: string } | null}
 */
export function getClient(model = "text") {
  const keys = loadKeysForModel(model);
  const state = loadState();
  const key = pickBestKey(keys, state, model);

  if (!key) {
    console.log(`[KeyPool] ⚠ All keys exhausted for ${model} today`);
    return null;
  }

  // Reuse cached client for this key
  if (!_clients.has(key.id)) {
    _clients.set(key.id, new GoogleGenAI({ apiKey: key.value }));
  }

  // Track usage (optimistic — increment before call, decrement on failure)
  incrementKeyUsage(state, key.id, model);

  const pool = model === "veo" ? "veo-billed" : "free";
  console.log(`[KeyPool] Using ${key.id} (${pool}) for ${model} (${getKeyUsage(state, key.id, model)}/${DAILY_QUOTAS[model]})`);
  return { client: _clients.get(key.id), keyId: key.id };
}

/**
 * Mark a key as exhausted for a specific model (e.g., on 429 error).
 * Sets usage to quota so it won't be picked again today.
 */
export function markKeyExhausted(keyId, model) {
  const state = loadState();
  if (!state.usage[keyId]) state.usage[keyId] = {};
  state.usage[keyId][model] = DAILY_QUOTAS[model] || 999;
  saveState(state);
  console.log(`[KeyPool] ❌ Marked ${keyId} as exhausted for ${model}`);
}

/**
 * Get current quota status across all keys.
 * Veo uses billed pool, other models use free pool.
 */
export function getQuotaStatus() {
  const state = loadState();
  const status = {};
  for (const model of Object.keys(DAILY_QUOTAS)) {
    const keys = loadKeysForModel(model).catch ? [] : loadKeysForModel(model);
    let actualKeys;
    try {
      actualKeys = loadKeysForModel(model);
    } catch {
      actualKeys = [];
    }
    const quota = DAILY_QUOTAS[model];
    const used = actualKeys.reduce((sum, k) => sum + getKeyUsage(state, k.id, model), 0);
    const total = actualKeys.length * quota;
    status[model] = {
      used,
      total,
      remaining: total - used,
      keys: actualKeys.length,
      pool: model === "veo" ? "billed" : "free",
    };
  }
  return status;
}

export { DAILY_QUOTAS, loadKeys, loadVeoKeys, loadKeysForModel };
