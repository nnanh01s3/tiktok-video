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
import { execSync, spawnSync } from "child_process";
import { getClient, markKeyExhausted, DAILY_QUOTAS } from "./gemini-keys.js";
import { getCharacter, buildCharacterPrompt, MASTER_STYLE_PROMPT, MASTER_NEGATIVE_PROMPT } from "./voices.mjs";

// Veo 3.1 Lite — cheapest paid tier ($0.05/s @ 720p), supports image-to-video + 9:16
// Requires GCP billing on the API key's project (use GEMINI_VEO_KEY_* env vars)
const VEO_MODEL = "veo-3.1-lite-generate-preview";
const IMAGEN_MODEL = "imagen-4.0-fast-generate-001";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

// ── Reference image generation (Approach A) ──────────────────────────
const IMAGE_MODEL_WITH_REFS = "gemini-2.5-flash-image";
const IMAGE_MODEL_LEGACY = IMAGEN_MODEL;
const USE_REFERENCE_IMAGES = process.env.VUNG_USE_REFS !== "0";

const REFERENCE_DIR = "D:/tiktok/vung/nhan_vat/canonical";
const REFERENCE_MAP = {
  momo: "momo.png",
  tiko: "tiko.png",
  lala: "lala.png",
  bobo: "bobo.png",
};
const LINEUP_REFERENCE = "lineup.png";  // size ratio reference, injected into EVERY scene

const _referenceCache = new Map();

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 60; // 10 min max per Veo gen

// FFmpeg binaries and fonts for text overlay (CTA scenes)
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FONT_BOLD = "D:/tiktok/assets/fonts/Montserrat-Bold.ttf";
const FONT_SEMI = "D:/tiktok/assets/fonts/Montserrat-SemiBold.ttf";

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

// Some keys lack access to specific models (e.g., Imagen 3 only on paid plans
// for some projects). Trigger key rotation in those cases too.
function isKeyAccessDenied(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("only available on paid") ||
         (msg.includes("invalid_argument") && msg.includes("imagen")) ||
         msg.includes("permission_denied") ||
         msg.includes("failed_precondition");
}

// Transient API errors — Veo/Imagen/TTS sometimes return empty results
// for a successful operation, time out, or hit internal server errors.
// These are NOT key problems (don't mark key exhausted) but ARE worth
// retrying, possibly with a different key or after a short delay.
function isTransientApiError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("returned no videos") ||
         msg.includes("returned no image") ||
         msg.includes("returned no audio") ||
         msg.includes("veo timeout") ||
         msg.includes("internal error") ||
         msg.includes("internal server error") ||
         msg.includes("503") ||
         msg.includes("unavailable") ||
         msg.includes("deadline exceeded");
}

/**
 * Retry helper: rotate through keys until success or all exhausted.
 * Handles three error categories:
 *   - Exhausted/access denied → mark key exhausted, rotate to next
 *   - Transient Veo errors → rotate key without marking exhausted, small delay
 *   - Other errors → bubble up (likely code bug or unrecoverable)
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
      if (isKeyAccessDenied(err)) {
        console.log(`[Render] ${keyId} lacks access to ${model}, rotating...`);
        markKeyExhausted(keyId, model);
        continue;
      }
      if (isTransientApiError(err)) {
        console.log(`[Render] ${keyId} transient error (${err.message?.slice(0, 80)}), retrying in 3s...`);
        await sleep(3000);
        continue;
      }
      // Non-quota error → bubble up
      throw err;
    }
  }
  throw lastErr || new Error("All rotation attempts failed");
}

// ── Step 1: Build Imagen prompt for a scene ─────────────────────────────

/**
 * Vietnamese species anchor for each character.
 *
 * Problem: scene breakdowns in tiếng Việt often say just "Momo" without any
 * species word. Imagen reads a long Vietnamese action paragraph mentioning
 * "bàn tay", "mặt", "miệng", "lông mày" — all human anatomy words — and
 * defaults to rendering humans (or dogs) because Vietnamese prose training
 * data rarely maps bare names to specific animal species.
 *
 * Fix: every mention of the character name in action text is prefixed with
 * the Vietnamese species word ("chú khỉ", "cô cáo"...). The FIRST mention
 * keeps the character name too ("chú khỉ Momo"); subsequent mentions drop
 * the name but keep the species ("chú khỉ"). This simultaneously:
 *   1. Anchors species on EVERY mention (no more "cậu" ambiguity)
 *   2. Avoids the "2 Momos" duplicate bug (only 1 "Momo" in the prompt)
 *   3. Stays grammatical Vietnamese (important for Veo which reads prompt
 *      for both video AND audio — English pronouns produce broken speech)
 *
 * Mapping (keep in sync with voices.mjs visualPrompt species):
 *   - momo: "chú khỉ"   (male monkey)
 *   - tiko: "chú rùa"   (male turtle)
 *   - bobo: "chú gấu"   (male bear)
 *   - lala: "cô cáo"    (female fox)
 *   - narrator: skipped (not a visual subject)
 */
const VIETNAMESE_SPECIES = {
  momo: "chú khỉ",
  tiko: "chú rùa",
  bobo: "chú gấu",
  lala: "cô cáo",
};

function dedupeActionText(action, characters) {
  if (!action || !characters || characters.length === 0) return action;
  let result = action;
  for (const charKey of characters) {
    if (charKey === "narrator") continue;
    const species = VIETNAMESE_SPECIES[charKey];
    if (!species) continue;
    // Character keys are lowercase; breakdown uses Capitalized form
    const capitalized = charKey.charAt(0).toUpperCase() + charKey.slice(1);
    const regex = new RegExp(`\\b${capitalized}\\b`, "g");
    let count = 0;
    result = result.replace(regex, (match) => {
      count++;
      // First mention: "chú khỉ Momo" (name + species anchor)
      // Subsequent:    "chú khỉ"      (species only, drops name so Imagen
      //                                 doesn't see 2+ "Momo" tokens)
      return count === 1 ? `${species} ${match}` : species;
    });
  }
  return result;
}

function loadCharacterReference(charKey) {
  if (_referenceCache.has(charKey)) return _referenceCache.get(charKey);
  const filename = charKey === "_lineup" ? LINEUP_REFERENCE : REFERENCE_MAP[charKey];
  if (!filename) {
    _referenceCache.set(charKey, null);
    return null;
  }
  const path = `${REFERENCE_DIR}/${filename}`;
  if (!existsSync(path)) {
    console.log(`[Render] ⚠ Missing reference PNG: ${path}`);
    _referenceCache.set(charKey, null);
    return null;
  }
  const base64 = readFileSync(path).toString("base64");
  _referenceCache.set(charKey, base64);
  return base64;
}

/**
 * Condense action text for Imagen prompt.
 *
 * v2 breakdowns are 1500+ chars of detailed Vietnamese prose — too long for
 * Imagen when combined with 5 reference images. Causes two bugs:
 *   1. Model drops characters (overloaded by long text + many images)
 *   2. Vietnamese nouns get rendered as text labels ("kim cương", "vương miện")
 *
 * Fix: strip quoted strings, strip camera/editing directions, keep only
 * character actions + key visual elements, truncate to ~800 chars.
 */
function condenseActionText(rawAction) {
  if (!rawAction) return rawAction;
  let text = rawAction;
  // Strip quoted dialogue/text embedded in breakdown (causes Imagen to render text)
  text = text.replace(/[""\u201C\u201D][^""\u201C\u201D]{2,}[""\u201C\u201D]/g, "");
  // Strip camera/editing directions (not visual content — confuses image generation)
  text = text.replace(/Camera [^.]+\./gi, "");
  text = text.replace(/\b(close-?up|medium shot|wide shot|tracking|push-?in|tilt|pan|whip|zoom|handheld)\b[^.]*\.?/gi, "");
  // Strip "lớp hình tưởng tượng" descriptions (causes floating text/objects)
  text = text.replace(/[Ll]ớp hình[^.]+\./g, "");
  text = text.replace(/tưởng tượng[^.]+\./g, "");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  // Truncate to ~800 chars at sentence boundary
  if (text.length > 800) {
    const cut = text.lastIndexOf(".", 800);
    text = cut > 200 ? text.slice(0, cut + 1) : text.slice(0, 800);
  }
  return text;
}

function buildScenePromptWithReference(scene, refChars) {
  const rawAction = dedupeActionText(
    scene.visualDescription || scene.goal || "",
    scene.characters
  );
  const action = condenseActionText(rawAction);

  const header =
    "Generate a single cinematic still frame for a cute 3D Pixar cartoon animated short. " +
    "Anthropomorphic animal characters only, no humans in the scene. " +
    "No clothing on any character, natural animal bodies with fur/shell only. " +
    "9:16 vertical aspect ratio, vibrant magical forest environment, soft cinematic lighting.";

  // Reference image 1 is always the lineup (size ratio reference)
  // Subsequent reference images are individual character sheets
  const refLabels = [];
  refLabels.push("Reference image 1 is a CHARACTER SIZE LINEUP showing correct height ratios — Bobo (bear) is tallest, Lala (fox) is medium, Momo (monkey) is small, Tiko (turtle) is shortest. Keep these size proportions.");

  // IMPORTANT: list ALL characters that should appear, not just those with refs
  const allCharsInScene = scene.characters.filter((c) => c !== "narrator");
  if (allCharsInScene.length > 0) {
    refLabels.push(
      `This scene MUST show exactly these characters: ${allCharsInScene.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(", ")}. Do not omit any character.`
    );
  }

  refChars.forEach((c, i) => {
    refLabels.push(`Reference image ${i + 2} is ${c.charAt(0).toUpperCase() + c.slice(1)} — keep appearance IDENTICAL.`);
  });

  const referenceCallout = refLabels.join(" ");

  const uniquenessConstraint = allCharsInScene.length > 0
    ? allCharsInScene
        .map((c) => `ONLY ONE ${c.charAt(0).toUpperCase() + c.slice(1)}`)
        .join(", ") + " in the scene"
    : "";

  const negative =
    "Avoid: humans, people, human hands, human faces, photorealism, real animals, " +
    "dogs, cats, horses, duplicate characters, multiple instances of the same character, " +
    "watermarks, logos, ANY TEXT in the image, ANY LETTERS, ANY WORDS, " +
    "Vietnamese text, Korean text, Chinese text, English text, captions, subtitles, " +
    "labels, speech bubbles, thought bubbles, floating text, " +
    "Pixar watermark, TikTok caption, stock footage artifacts, clothing, shirts, pants, robes";

  return [
    header,
    referenceCallout,
    `Scene action: ${action}`,
    uniquenessConstraint,
    "NO TEXT, NO LETTERS, NO WRITING, NO CAPTIONS, NO WATERMARKS in the image",
    negative,
  ].filter(Boolean).join(" ");
}

async function generateSceneImageWithRefs(scene, outputPath) {
  if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
    console.log(`[Render] Scene ${scene.id} image exists, skipping`);
    return outputPath;
  }
  ensureDir(outputPath);

  // Always include lineup as first reference (size ratios)
  const refParts = [];
  const refChars = [];
  const lineupBase64 = loadCharacterReference("_lineup");
  if (lineupBase64) {
    refParts.push({ inlineData: { data: lineupBase64, mimeType: "image/png" } });
  }

  // Then add individual character references
  for (const charKey of scene.characters) {
    if (charKey === "narrator") continue;
    const base64 = loadCharacterReference(charKey);
    if (base64) {
      refParts.push({ inlineData: { data: base64, mimeType: "image/png" } });
      refChars.push(charKey);
    }
  }

  const prompt = buildScenePromptWithReference(scene, refChars);
  console.log(
    `[Render] Scene ${scene.id} → Gemini Image (${refParts.length} refs: lineup + ${refChars.join(",")}): ` +
    `"${prompt.slice(0, 100)}..."`
  );

  const buffer = await withKeyRotation("imagen", async (client) => {
    const res = await client.models.generateContent({
      model: IMAGE_MODEL_WITH_REFS,
      contents: [{
        role: "user",
        parts: [{ text: prompt }, ...refParts],
      }],
      config: { responseModalities: ["IMAGE"] },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData?.data) throw new Error("Image model returned no image");
    return Buffer.from(part.inlineData.data, "base64");
  });

  // gemini-2.5-flash-image outputs 1024x1024 (no aspect ratio control via
  // generateContent). Post-process to 1080x1920 (9:16) for Veo starting frame.
  // Strategy: scale width to 1080, then pad height to 1920 with blurred
  // extension of the image (looks more natural than black bars).
  const rawPath = outputPath.replace(/\.png$/, "_raw.png");
  writeFileSync(rawPath, buffer);

  const padCmd = [
    `${FFMPEG} -y -i "${rawPath}"`,
    `-vf "scale=1080:-1,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black"`,
    `"${outputPath}"`,
  ].join(" ");
  const padResult = spawnSync(padCmd, { shell: true, encoding: "utf8", timeout: 30_000 });
  if (padResult.status !== 0) {
    // Fallback: keep raw image if FFmpeg fails
    console.log(`[Render] ⚠ FFmpeg pad failed, using raw 1024x1024`);
    writeFileSync(outputPath, buffer);
  } else {
    console.log(`[Render] Scene ${scene.id} padded to 1080x1920 (9:16)`);
  }
  // Clean raw temp file
  try { unlinkSync(rawPath); } catch {}

  console.log(`[Render] Scene ${scene.id} image saved: ${(statSync(outputPath).size / 1024).toFixed(0)}KB`);
  return outputPath;
}

function buildScenePrompt(scene) {
  // IMPORTANT: Don't include "Scene N: TITLE" prefix — that text gets
  // rendered as garbled letters in the generated image. Imagen treats
  // any text in the prompt as a hint to draw text in the image.
  //
  // Strategy (LEAD WITH STYLE + SPECIES, trailing negatives):
  //   1. Header: style + "anthropomorphic animal characters only" so Imagen
  //      commits to cartoon animal interpretation BEFORE reading action text.
  //      This is critical — Vietnamese action text is long (1500+ chars) and
  //      if style/species declarations come after, Imagen defaults to humans.
  //   2. Character visual prompts (English, specific body/fur/tail details)
  //   3. Action text with inline Vietnamese species anchor (from dedupe)
  //   4. Uniqueness constraint ("ONLY ONE X in scene")
  //   5. Explicit negatives against humans, realism, duplicates, text
  const rawAction = scene.visualDescription || scene.goal || "";
  const action = dedupeActionText(rawAction, scene.characters);
  const charPrompt = buildCharacterPrompt(scene.characters);

  // Subject anchor that front-loads the interpretation frame. Imagen commits
  // to this before parsing the Vietnamese action text that follows.
  const header =
    "Cute 3D Pixar cartoon animation short. " +
    "Anthropomorphic animal characters only, no humans in the scene. " +
    "Vibrant magical forest environment, soft cinematic lighting, " +
    "9:16 vertical aspect ratio";

  // Explicit "only one of each" constraint — helps Imagen avoid duplicating
  // characters when the scene's action implies multiple interactions.
  // e.g. "ONLY ONE Momo in the scene, ONLY ONE Tiko"
  const uniquenessConstraint = scene.characters.length > 0
    ? scene.characters
        .map((c) => `ONLY ONE ${c.charAt(0).toUpperCase() + c.slice(1)}`)
        .join(", ") + " in the scene"
    : "";

  // Strong negatives: humans (user rule: "không liên quan đến con người"),
  // realistic photography (v4 wants Pixar cartoon), common misinterpretations
  // (dogs/cats when species isn't anchored), duplicate characters.
  const humansNegative =
    "NO humans, NO people, NO human characters, NO human hands, NO human faces, " +
    "NO realistic photography, NO real animals, NO photorealism, " +
    "NO dogs, NO cats, NO horses";
  const duplicateNegative =
    "multiple instances of the same character, duplicate characters, " +
    "twin characters, cloned characters, two of the same animal";

  const parts = [
    header,                 // 1. Style + animal-only frame (FIRST)
    charPrompt,             // 2. Specific character visual prompts
    `Scene: ${action}`,     // 3. Vietnamese action (species-anchored via dedupe)
    uniquenessConstraint,   // 4. "ONLY ONE X"
    MASTER_STYLE_PROMPT,    // 5. Master style reminder
    "NO TEXT, NO LETTERS, NO WRITING, NO SIGNS, NO LOGOS in the image",
    `Negative: ${humansNegative}. Avoid: ${duplicateNegative}`,
  ].filter(Boolean);

  return parts.join(". ");
}

// ── Step 2: Generate scene image (Imagen 4.0) ────────────────────────────
async function generateSceneImageLegacy(scene, outputPath) {
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

async function generateSceneImage(scene, outputPath) {
  if (!USE_REFERENCE_IMAGES) return generateSceneImageLegacy(scene, outputPath);
  try {
    return await generateSceneImageWithRefs(scene, outputPath);
  } catch (err) {
    if (err.message?.includes("All keys exhausted")) {
      console.log("[Render] ⚠ Reference model exhausted, falling back to Imagen legacy");
      return generateSceneImageLegacy(scene, outputPath);
    }
    throw err;
  }
}

// ── Step 3: Animate image with Veo 3.1 Lite ──────────────────────────────
function buildVeoMotionPrompt(scene) {
  // Veo 3.1 Lite generates both VIDEO and AUDIO from the prompt. Two lessons:
  //
  // 1. Motion: Veo struggles with 3+ beats joined with "→" — it fits too
  //    much into 8s and only animates the first or last beat. Use FIRST 1-2
  //    beats as dominant motion.
  //
  // 2. Audio: Veo can generate character speech AND narration. If the prompt
  //    contains English instruction text (e.g. "cinematic camera movement"),
  //    Veo sometimes interprets these as narration and speaks them aloud as
  //    English voiceover. This produced the "tiếng Anh 1-2 scene" and
  //    "giải thích đi kèm" bugs the user reported in tap_01.
  //
  // Fix: keep the prompt in Vietnamese as much as possible, include the
  // actual character dialogue text so Veo lipsyncs Vietnamese speech, and
  // add an explicit "no narration, Vietnamese only" directive at the end.
  //
  // Also apply character dedup to prevent Veo from interpreting repeated
  // character names as multiple subjects.
  const beats = scene.breakdown;
  const rawPrimary = beats.slice(0, 2).join(" ");
  const primaryAction = dedupeActionText(rawPrimary, scene.characters);
  const endingHint = beats.length > 2
    ? ` Kết thúc: ${dedupeActionText(beats[beats.length - 1].slice(0, 120), scene.characters)}`
    : "";

  // Include actual Vietnamese dialogue text so Veo lipsyncs it rather than
  // generating random English speech. Exclude "narrator" character (CTA
  // voice-over) because that's overlaid separately in post.
  const spokenLines = scene.dialogue.filter((d) => d.character !== "narrator");
  const dialogueHint = spokenLines.length > 0
    ? " Nhân vật nói thoại tiếng Việt: " +
      spokenLines.map((d) => `${d.character} nói "${d.text}"`).join(", ")
    : " Scene không có lời thoại, chỉ có âm thanh môi trường.";

  return [
    primaryAction || scene.goal || scene.title,
    endingHint,
    dialogueHint,
    "Phong cách pixar 3D cartoon, chuyển động mượt, màu sắc tươi.",
    "QUAN TRỌNG: KHÔNG có lời dẫn chuyện, KHÔNG có voice-over tiếng Anh. " +
      "Chỉ có nhân vật nói tiếng Việt và âm thanh môi trường rừng.",
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

    // CRITICAL: Pass ONLY the Vietnamese dialogue text to Gemini TTS.
    //
    // Previously included `char.style` (English instructions like
    // "Speak fast, mischievous, playful..."), which Gemini TTS sometimes
    // read aloud as content, producing:
    //   (a) unwanted narration/explanation in the audio
    //   (b) English speech mixed into pure-Vietnamese dialogue scenes
    //
    // The voice character (Puck/Sadaltager/Aoede/Fenrir/Charon via
    // prebuiltVoiceConfig.voiceName) already provides pitch/tone/personality.
    // Keeping the prompt to pure dialogue text guarantees no language leak
    // and no spurious narration.
    //
    // `line.direction` (e.g. "thì thầm", "hét lớn") is intentionally NOT
    // included either — it would be spoken as part of the audio by Gemini.
    // Future enhancement: encode direction via SSML prosody tags if needed.
    //
    // PADDING FOR ULTRA-SHORT UTTERANCES:
    // Gemini TTS reliably fails on inputs with too few phonemes (e.g.
    // "…Ủa?", "Hả?!", "…chuối?"). The 15-key rotation burns through all
    // keys before 15 retries succeed (if at all). Pre-padding these cases
    // with a short Vietnamese phonetic hint word that blends naturally
    // ("ờ" ~ spoken "uh") satisfies the phoneme minimum without changing
    // the perceived line. Strip the leading `…` first so Gemini doesn't
    // also trip on the ellipsis character.
    //
    // Threshold: strip leading ellipsis, then if text ≤ 8 visible chars,
    // prepend "Ờ, " (Vietnamese hesitation filler) to force longer input.
    function preparTtsText(raw) {
      if (!raw) return raw;
      // Strip leading unicode/ascii ellipsis + spaces
      const stripped = raw.replace(/^[…\.\s]+/, "").trim();
      if (stripped.length <= 8) {
        return `Ờ, ${stripped}`;
      }
      return stripped;
    }
    const fullText = preparTtsText(line.text);

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

// ── Step 5: Text overlay for CTA scenes ──────────────────────────────────
//
// For scenes with `textOverlays` populated (typically CTA/outro scenes like
// scene 15 that have 👉 Text markers in the breakdown), apply an FFmpeg
// drawtext overlay on top of the Veo clip. The overlay fades in during the
// final 2 seconds of the 8s clip and stays visible until the end.
//
// Why FFmpeg drawtext instead of Imagen-rendered text (like scene 1 does)?
//   - Scene 1's text is constant across episodes → Imagen rendering works
//     (hardcoded ASCII "RUNG XI TIN" on a wooden sign).
//   - CTA text changes per episode ("WIFI RỪNG BỊ LAG!" for tập 2,
//     different for tập 3, etc.) → needs dynamic text with Vietnamese
//     diacritics → Montserrat-SemiBold drawtext is reliable.

function stripUnsupportedGlyphs(s) {
  // Remove emoji/symbol glyphs that Montserrat lacks (they render as tofu ▢)
  return String(s)
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "") // Misc symbols & pictographs
    .replace(/[\u{2600}-\u{27BF}]/gu, "")   // Misc symbols (includes 👉 range)
    .replace(/[\u{1F000}-\u{1F2FF}]/gu, "")
    .replace(/[\u{1FA00}-\u{1FAFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeDrawtext(s) {
  // FFmpeg drawtext needs special escaping for colons, backslashes, quotes
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%");
}

function escapeFontPath(p) {
  // FFmpeg fontfile= paths need forward slashes + escaped colons on Windows
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Apply FFmpeg drawtext overlay on top of a Veo scene clip.
 *
 * @param {string} inputPath - source Veo clip (e.g. scene_15.mp4)
 * @param {string} outputPath - overlay clip (e.g. scene_15_overlay.mp4)
 * @param {string[]} textOverlays - lines of text to overlay (1-2 lines supported)
 * @returns {string} outputPath
 */
function overlayTextOnClip(inputPath, outputPath, textOverlays) {
  if (existsSync(outputPath) && statSync(outputPath).size > 10000) {
    console.log(`[Render] Text overlay cached: ${outputPath}`);
    return outputPath;
  }
  if (!textOverlays || textOverlays.length === 0) {
    throw new Error("overlayTextOnClip called with empty textOverlays");
  }

  // Timing: CTA text appears in last 2s of 8s clip, fades in over 0.5s
  const overlayStart = 6.0;
  const fadeInEnd = overlayStart + 0.5;

  const fontBold = escapeFontPath(FONT_BOLD);
  const fontSemi = escapeFontPath(FONT_SEMI);

  // Alpha expression: 0 before start, linear fade 0→1 during fade, 1 after
  const alphaExpr =
    `'if(lt(t,${overlayStart}),0,` +
    `if(lt(t,${fadeInEnd}),(t-${overlayStart})/0.5,1))'`;

  // Build filter chain: dark band + main text (+ subtitle if 2nd line)
  const filters = [];

  // Semi-transparent dark band behind the text for contrast
  filters.push(
    `drawbox=x=0:y=h-340:w=iw:h=260:color=black@0.55:t=fill:` +
      `enable='gte(t,${overlayStart})'`
  );

  // Main CTA text (strip emoji glyphs which Montserrat can't render)
  const mainText = escapeDrawtext(stripUnsupportedGlyphs(textOverlays[0]));
  if (mainText) {
    filters.push(
      `drawtext=fontfile='${fontBold}':text='${mainText}':` +
        `fontsize=58:fontcolor=#FFE08A:` +
        `x=(w-text_w)/2:y=h-270:` +
        `borderw=4:bordercolor=black@0.9:` +
        `shadowcolor=black@0.7:shadowx=3:shadowy=3:` +
        `alpha=${alphaExpr}`
    );
  }

  // Optional secondary line
  if (textOverlays.length > 1) {
    const subText = escapeDrawtext(stripUnsupportedGlyphs(textOverlays[1]));
    if (subText) {
      filters.push(
        `drawtext=fontfile='${fontSemi}':text='${subText}':` +
          `fontsize=42:fontcolor=#FFFFFF:` +
          `x=(w-text_w)/2:y=h-190:` +
          `borderw=3:bordercolor=black@0.85:` +
          `alpha=${alphaExpr}`
      );
    }
  }

  // filter_complex requires explicit [0:v] input and [vout] output labels
  // (unlike -vf which implicitly wires them)
  const filterBody = filters.join(",");
  const filter = `[0:v]${filterBody}[vout]`;

  const filterFile = outputPath.replace(/\.mp4$/, "_overlay_filter.txt");
  writeFileSync(filterFile, filter);

  const cmd = [
    `${FFMPEG} -y`,
    `-i "${inputPath}"`,
    `-filter_complex_script "${filterFile}"`,
    `-map "[vout]" -map 0:a?`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `-c:a copy`,
    `"${outputPath}"`,
  ].join(" ");

  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 120_000 });
  try { unlinkSync(filterFile); } catch {}

  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(-800);
    throw new Error(`FFmpeg text overlay failed:\n${stderr}`);
  }

  console.log(`[Render] ✅ Text overlay applied: ${outputPath.split(/[\\/]/).pop()}`);
  return outputPath;
}

// ── Public API: render one complete scene ───────────────────────────────

/**
 * Render all assets for a scene: image, clip, dialogue audio.
 *
 * @param {import("./scene-parser.mjs").ParsedScene} scene
 * @param {string} outputDir - e.g., "vung/output/tap_01"
 * @returns {Promise<{imagePath, clipPath, dialogue: Array}>}
 */
export async function renderScene(scene, outputDir, opts = {}) {
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
  const rawClipPath = `${outputDir}/scene_${sceneIdPadded}.mp4`;
  const overlayClipPath = `${outputDir}/scene_${sceneIdPadded}_overlay.mp4`;

  // Step 1: Imagen (starting frame)
  await generateSceneImage(scene, imagePath);

  if (opts.skipVeo) {
    console.log(`[Render] Scene ${scene.id} --skip-veo: image only, skipping Veo + TTS`);
    return { imagePath, clipPath: null, dialogue: [] };
  }

  // Step 2: Veo animate (raw 8s clip, no text)
  await generateSceneClip(scene, imagePath, rawClipPath);

  // Step 3: TTS for dialogue (includes narrator voice-overs appended
  // by the parser from "👉 Voice:" markers in the breakdown)
  const dialogue = await generateDialogueAudio(scene, outputDir);

  // Step 4: If the scene has CTA text overlays (from "👉 Text:" markers
  // in the breakdown), bake them onto the clip with FFmpeg drawtext.
  // Returned clipPath switches to the overlay version for downstream
  // composer to use.
  let clipPath = rawClipPath;
  if (scene.textOverlays && scene.textOverlays.length > 0) {
    overlayTextOnClip(rawClipPath, overlayClipPath, scene.textOverlays);
    clipPath = overlayClipPath;
  }

  return { imagePath, clipPath, dialogue };
}
