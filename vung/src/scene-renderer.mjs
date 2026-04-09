/**
 * Scene renderer — generate all assets for a single scene.
 *
 * For each scene:
 *   1. Build Imagen prompt (breakdown + character prompts + master style)
 *   2. Generate scene image via Imagen 4.0 Fast (key pool)
 *   3. Animate image with Veo 2.0 (key pool) — 8s clip, 9:16
 *   4. Generate TTS audio for each dialogue line (key pool, per-character voice)
 *
 * All files saved to: vung/output/tap_NN/
 *   - scene_NN.png    - Imagen scene image
 *   - scene_NN.mp4    - Veo animated clip
 *   - voice_NN_X.wav  - TTS audio (X = dialogue index)
 *
 * Resumable: if file exists, skip generation (allows retry after failure).
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, statSync } from "fs";
import { dirname } from "path";
import { execSync } from "child_process";
import { getClient, markKeyExhausted, DAILY_QUOTAS } from "./gemini-keys.js";
import { getCharacter, buildCharacterPrompt, MASTER_STYLE_PROMPT, MASTER_NEGATIVE_PROMPT } from "./voices.mjs";

// Veo 3.1 Lite — cheapest paid tier ($0.05/s @ 720p), supports image-to-video + 9:16
// Requires GCP billing on the API key's project (use GEMINI_VEO_KEY_* env vars)
const VEO_MODEL = "veo-3.1-lite-generate-preview";
const IMAGEN_MODEL = "imagen-4.0-fast-generate-001";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 60; // 10 min max per Veo gen

// ── Helpers ──────────────────────────────────────────────────────────────
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isExhausted(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return err?.status === 429 ||
         msg.includes("resource_exhausted") ||
         msg.includes("quota") ||
         msg.includes("rate limit");
}

/**
 * Retry helper: rotate through keys until success or all exhausted.
 *
 * @param {string} model - "veo" | "imagen" | "tts"
 * @param {(client) => Promise<T>} fn - action that uses the client
 * @returns {Promise<T>}
 */
async function withKeyRotation(model, fn) {
  const maxAttempts = 15; // safety cap
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = getClient(model);
    if (!handle) {
      throw new Error(`All keys exhausted for ${model} today. Retry tomorrow.`);
    }
    const { client, keyId } = handle;
    try {
      return await fn(client);
    } catch (err) {
      lastErr = err;
      if (isExhausted(err)) {
        markKeyExhausted(keyId, model);
        console.log(`[Render] ${keyId} exhausted (${model}), trying next...`);
        continue;
      }
      // Non-quota error → bubble up
      throw err;
    }
  }
  throw lastErr || new Error("All rotation attempts failed");
}

// ── Step 1: Build Imagen prompt for a scene ─────────────────────────────
function buildScenePrompt(scene) {
  // IMPORTANT: Don't include "Scene N: TITLE" prefix — that text gets
  // rendered as garbled letters in the generated image. Imagen treats
  // any text in the prompt as a hint to draw text in the image.
  //
  // Strategy:
  //   - Pure visual description (action from breakdown)
  //   - Character visual prompts injected
  //   - Master style for consistency
  //   - Explicit "no text" negative
  const action = scene.visualDescription || scene.goal || "";
  const charPrompt = buildCharacterPrompt(scene.characters);

  const parts = [
    action,
    charPrompt,
    MASTER_STYLE_PROMPT,
    "NO TEXT, NO LETTERS, NO WRITING, NO SIGNS, NO LOGOS in the image",
  ].filter(Boolean);

  return parts.join(". ");
}

// ── Step 2: Generate scene image (Imagen 4.0) ────────────────────────────
async function generateSceneImage(scene, outputPath) {
  if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
    console.log(`[Render] Scene ${scene.id} image exists, skipping`);
    return outputPath;
  }

  ensureDir(outputPath);
  const prompt = buildScenePrompt(scene);
  console.log(`[Render] Scene ${scene.id} → Imagen: "${prompt.slice(0, 80)}..."`);

  const buffer = await withKeyRotation("imagen", async (client) => {
    const res = await client.models.generateImages({
      model: IMAGEN_MODEL,
      prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: "9:16",
      },
    });
    const img = res.generatedImages?.[0];
    if (!img?.image?.imageBytes) throw new Error("Imagen returned no image");
    return Buffer.from(img.image.imageBytes, "base64");
  });

  writeFileSync(outputPath, buffer);
  console.log(`[Render] Scene ${scene.id} image saved: ${(buffer.length / 1024).toFixed(0)}KB`);
  return outputPath;
}

// ── Step 3: Animate image with Veo 3.1 Lite ──────────────────────────────
function buildVeoMotionPrompt(scene) {
  // Lesson learned: Veo 3.1 Lite struggles when prompt lists 5 separate beats
  // joined with "→" — it tries to fit too much into 8 seconds and ends up
  // animating only the first or last beat.
  //
  // Better strategy: Use the FIRST 1-2 beats as the dominant motion,
  // mention later beats as "ending with..." for context only.
  const beats = scene.breakdown;
  const primaryAction = beats.slice(0, 2).join(" Then "); // first 2 beats = main action
  const endingHint = beats.length > 2
    ? ` Ending with ${beats[beats.length - 1].slice(0, 80)}.`
    : "";
  const dialogueHint = scene.dialogue.length > 0
    ? " Characters express emotion matching their dialogue."
    : "";

  return [
    primaryAction || scene.goal || scene.title,
    endingHint,
    dialogueHint,
    "Smooth fluid animation, cinematic camera movement, vibrant colors,",
    "pixar-style 3D cartoon, expressive characters, no text overlay",
  ].join(" ").replace(/\s+/g, " ").trim();
}

async function generateSceneClip(scene, imagePath, outputPath) {
  if (existsSync(outputPath) && statSync(outputPath).size > 10000) {
    console.log(`[Render] Scene ${scene.id} clip exists, skipping`);
    return outputPath;
  }

  ensureDir(outputPath);
  const motionPrompt = buildVeoMotionPrompt(scene);
  console.log(`[Render] Scene ${scene.id} → Veo: "${motionPrompt.slice(0, 80)}..."`);

  // Read image as bytes for image-to-video
  const imageBytes = readFileSync(imagePath).toString("base64");

  const result = await withKeyRotation("veo", async (client) => {
    let operation = await client.models.generateVideos({
      model: VEO_MODEL,
      prompt: motionPrompt,
      image: {
        imageBytes,
        mimeType: "image/png",
      },
      config: {
        aspectRatio: "9:16",
      },
    });

    // Poll until done
    let attempts = 0;
    while (!operation.done) {
      if (++attempts > MAX_POLL_ATTEMPTS) {
        throw new Error(`Veo timeout for scene ${scene.id}`);
      }
      if (attempts % 3 === 0) {
        console.log(`[Render] Scene ${scene.id} Veo... ${attempts * 10}s elapsed`);
      }
      await sleep(POLL_INTERVAL_MS);
      operation = await client.operations.getVideosOperation({ operation });
    }

    const videos = operation.response?.generatedVideos;
    if (!videos || videos.length === 0) {
      throw new Error(`Veo returned no videos for scene ${scene.id}`);
    }

    await client.files.download({ file: videos[0].video, downloadPath: outputPath });
    return outputPath;
  });

  console.log(`[Render] Scene ${scene.id} clip saved: ${outputPath}`);
  return result;
}

// ── Step 4: Generate dialogue TTS audio ──────────────────────────────────
function writeWavHeader(pcmBuffer, sampleRate = 24000) {
  // Gemini TTS returns raw PCM (16-bit mono 24kHz).
  // Wrap it in a WAV container so ffmpeg can mux it.
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function generateDialogueAudio(scene, outputDir) {
  /**
   * Returns array of { path, character, text, duration } for each dialogue line.
   * Caller will use these to mix into the final video at the right timestamps.
   */
  const results = [];

  for (let i = 0; i < scene.dialogue.length; i++) {
    const line = scene.dialogue[i];
    const char = getCharacter(line.character);
    if (!char) {
      console.log(`[Render] Scene ${scene.id} unknown character: ${line.character}, skipping line`);
      continue;
    }

    const filename = `voice_${String(scene.id).padStart(2, "0")}_${i}_${line.character}.wav`;
    const outputPath = `${outputDir}/${filename}`;

    if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
      results.push({ path: outputPath, character: line.character, text: line.text });
      continue;
    }

    // Style instruction + line text (Gemini TTS format)
    const styleDirection = line.direction ? ` (${line.direction})` : "";
    const fullText = `${char.style}\n\n${line.text}${styleDirection}`;

    console.log(`[Render] Scene ${scene.id} → TTS ${char.name}: "${line.text.slice(0, 40)}..."`);

    const pcmBuffer = await withKeyRotation("tts", async (client) => {
      const res = await client.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: fullText }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: char.voice },
            },
          },
        },
      });
      const part = res.candidates?.[0]?.content?.parts?.[0];
      if (!part?.inlineData?.data) throw new Error("TTS returned no audio");
      return Buffer.from(part.inlineData.data, "base64");
    });

    const wavBuffer = writeWavHeader(pcmBuffer, 24000);
    ensureDir(outputPath);
    writeFileSync(outputPath, wavBuffer);
    results.push({ path: outputPath, character: line.character, text: line.text });
  }

  return results;
}

// ── Public API: render one complete scene ───────────────────────────────

/**
 * Render all assets for a scene: image, clip, dialogue audio.
 *
 * @param {import("./scene-parser.mjs").ParsedScene} scene
 * @param {string} outputDir - e.g., "vung/output/tap_01"
 * @returns {Promise<{imagePath, clipPath, dialogue: Array}>}
 */
export async function renderScene(scene, outputDir) {
  ensureDir(`${outputDir}/.keep`);

  // Title scenes (intro, CTA) bypass Veo entirely:
  // Vietnamese text needs FFmpeg drawtext for reliability,
  // and saves $0.40/scene vs Veo.
  if (scene.isTitle) {
    const { renderTitleScene } = await import("./title-card-renderer.mjs");
    return renderTitleScene(scene, outputDir);
  }

  const sceneIdPadded = String(scene.id).padStart(2, "0");
  const imagePath = `${outputDir}/scene_${sceneIdPadded}.png`;
  const clipPath = `${outputDir}/scene_${sceneIdPadded}.mp4`;

  // Step 1: Imagen
  await generateSceneImage(scene, imagePath);

  // Step 2: Veo animate
  await generateSceneClip(scene, imagePath, clipPath);

  // Step 3: TTS for dialogue
  const dialogue = await generateDialogueAudio(scene, outputDir);

  return { imagePath, clipPath, dialogue };
}
