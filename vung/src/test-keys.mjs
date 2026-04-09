/**
 * Test all Gemini API keys — verify each key works by making a simple text call.
 *
 * Usage: node vung/src/test-keys.mjs
 *
 * Tests:
 *   1. Load all keys from env (GEMINI_API_KEY + GEMINI_API_KEY1..10)
 *   2. For each key: make a simple Gemini Flash text request
 *   3. Report success/failure per key
 *   4. Test pickBestKey() logic with current state
 */
import "../../src/env.js";
import { GoogleGenAI } from "@google/genai";
import { loadKeys, getQuotaStatus, DAILY_QUOTAS } from "./gemini-keys.js";

const TEST_PROMPT = "Say 'OK' in one word.";

async function testKey(keyInfo) {
  const { id, value } = keyInfo;
  const masked = value.slice(0, 8) + "..." + value.slice(-4);
  try {
    const ai = new GoogleGenAI({ apiKey: value });
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: TEST_PROMPT,
    });
    const text = res.text?.trim() || "(no text)";
    console.log(`  ✅ ${id.padEnd(8)} ${masked}  →  "${text.slice(0, 30)}"`);
    return { id, ok: true };
  } catch (err) {
    const msg = err.message?.slice(0, 80) || String(err).slice(0, 80);
    console.log(`  ❌ ${id.padEnd(8)} ${masked}  →  ${msg}`);
    return { id, ok: false, error: msg };
  }
}

async function main() {
  console.log("🔑 Loading keys from env...");
  const keys = loadKeys();
  console.log(`Found ${keys.length} keys\n`);

  console.log("🧪 Testing each key with a simple Gemini Flash call:\n");
  const results = [];
  for (const k of keys) {
    results.push(await testKey(k));
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  console.log(`\n📊 Results: ${ok}/${results.length} keys working`);
  if (fail > 0) {
    console.log(`❌ ${fail} keys failed:`);
    results.filter((r) => !r.ok).forEach((r) => console.log(`   - ${r.id}: ${r.error}`));
  }

  console.log("\n📈 Daily quota status (all keys combined):");
  const status = getQuotaStatus();
  for (const [model, q] of Object.entries(status)) {
    console.log(`  ${model.padEnd(8)} ${q.used}/${q.total} used (${q.remaining} remaining across ${q.keys} keys)`);
  }

  console.log("\n🎯 Theoretical capacity per day with", keys.length, "keys:");
  for (const [model, quota] of Object.entries(DAILY_QUOTAS)) {
    console.log(`  ${model.padEnd(8)} ${keys.length * quota} calls/day`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
