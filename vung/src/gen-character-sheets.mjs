/**
 * One-time script: generate 4 canonical Pixar 3D character sheets.
 * Output: vung/nhan_vat/canonical/{momo,tiko,lala,bobo}.png
 *
 * Usage: node vung/src/gen-character-sheets.mjs
 *        node vung/src/gen-character-sheets.mjs --only momo
 */
import "../../src/env.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { getClient, markKeyExhausted } from "./gemini-keys.js";

const MODEL = "gemini-2.5-flash-image";
const OUTPUT_DIR = "D:/tiktok/vung/nhan_vat/canonical";

const CHARACTER_PROMPTS = {
  momo: {
    name: "Momo",
    prompt: [
      "A full-body character design sheet of Momo, a mischievous monkey character.",
      "Slim body, light brown fur, cream-colored belly and face area.",
      "Big round expressive brown eyes, large rounded ears.",
      "Long curved tail with a slight curl at the tip.",
      "Playful mischievous smile showing teeth.",
      "Standing in a confident energetic pose, arms slightly out.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, dark, aggressive, humans, people.",
    ].join(" "),
  },
  tiko: {
    name: "Tiko",
    prompt: [
      "A full-body character design sheet of Tiko, a wise turtle character.",
      "Green shell with hexagonal pattern, slightly darker green on top.",
      "Wearing round reddish-brown glasses.",
      "Calm gentle expression, small wise smile.",
      "Light green skin, slightly slow posture.",
      "Standing upright in a composed thoughtful pose.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, dark, humans, broken shell.",
    ].join(" "),
  },
  lala: {
    name: "Lala",
    prompt: [
      "A full-body character design sheet of Lala, a stylish female fox character.",
      "Orange fur with white chest, white tail tip, big fluffy tail.",
      "Wearing a turquoise-green button-up blouse and blue denim jeans with a brown belt.",
      "Confident sassy expression, slightly feminine elegant pose.",
      "Big expressive brown eyes with long eyelashes, pointed ears with dark tips.",
      "Standing with one hand on hip.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, dark, aggressive, humans, people.",
    ].join(" "),
  },
  bobo: {
    name: "Bobo",
    prompt: [
      "A full-body character design sheet of Bobo, a chubby friendly bear character.",
      "Brown fur, big round belly with lighter cream belly patch.",
      "Wearing a blue polo shirt with a small yellow logo patch and blue denim shorts.",
      "Round face, small eyes, big black nose, friendly silly grin.",
      "Standing in a slightly clumsy but lovable pose.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, angry, dark, humans, people, dogs.",
    ].join(" "),
  },
};

const onlyArg = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const targets = onlyArg
  ? { [onlyArg]: CHARACTER_PROMPTS[onlyArg] }
  : CHARACTER_PROMPTS;

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

async function generateSheet(charKey, { name, prompt }) {
  const outPath = `${OUTPUT_DIR}/${charKey}.png`;
  if (existsSync(outPath)) {
    console.log(`[CharSheet] ${name} already exists, skipping. Delete to re-generate.`);
    return;
  }

  console.log(`[CharSheet] Generating ${name}...`);
  console.log(`[CharSheet] Prompt: "${prompt.slice(0, 100)}..."`);

  const maxAttempts = 15;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = getClient("imagen");
    if (!handle) throw new Error("All keys exhausted for imagen");
    try {
      const res = await handle.client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseModalities: ["IMAGE"] },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part?.inlineData?.data) {
        throw new Error("Model returned no image");
      }
      const buffer = Buffer.from(part.inlineData.data, "base64");
      writeFileSync(outPath, buffer);
      console.log(`[CharSheet] ✅ ${name} saved: ${outPath} (${(buffer.length / 1024).toFixed(0)}KB)`);
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "").toLowerCase();
      if (err?.status === 429 || msg.includes("quota") || msg.includes("resource_exhausted")) {
        markKeyExhausted(handle.keyId, "imagen");
        console.log(`[CharSheet] Key ${handle.keyId} exhausted, trying next...`);
        continue;
      }
      if (msg.includes("returned no") || msg.includes("503") || msg.includes("unavailable")) {
        console.log(`[CharSheet] Transient error (${msg.slice(0, 60)}), retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`Failed to generate ${name} after ${maxAttempts} attempts`);
}

async function main() {
  console.log(`\n🎨 Generating canonical character sheets → ${OUTPUT_DIR}\n`);
  for (const [key, config] of Object.entries(targets)) {
    if (!config) {
      console.error(`Character "${key}" not found. Available: ${Object.keys(CHARACTER_PROMPTS).join(", ")}`);
      process.exit(1);
    }
    await generateSheet(key, config);
  }
  console.log("\n✅ Done! Please visually inspect the 4 PNGs in vung/nhan_vat/canonical/ before proceeding.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
