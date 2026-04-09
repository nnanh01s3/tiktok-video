/**
 * Title card renderer — generate title scenes WITHOUT Veo.
 *
 * Why bypass Veo for title scenes?
 *   1. AI video models can't render Vietnamese text reliably (any non-English really)
 *      → text comes out as gibberish/scribbles.
 *   2. Veo costs $0.40 per 8s clip; FFmpeg drawtext is free.
 *   3. Title cards need EXACT text, not "creative interpretation".
 *
 * Flow:
 *   1. Imagen generates a beautiful background (forest landscape, NO text in prompt)
 *   2. FFmpeg uses drawtext with Montserrat font for Vietnamese text overlay
 *   3. Ken Burns zoom adds motion (replaces what Veo would have done)
 *   4. Output is an 8s MP4 clip — same interface as Veo-generated clips
 *
 * The output integrates seamlessly with composer.mjs (same file naming).
 */
import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { dirname } from "path";
import { getClient, markKeyExhausted } from "./gemini-keys.js";
import { MASTER_STYLE_PROMPT } from "./voices.mjs";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FONT_BOLD = "D:/tiktok/assets/fonts/Montserrat-Bold.ttf";
const FONT_SEMI = "D:/tiktok/assets/fonts/Montserrat-SemiBold.ttf";
const IMAGEN_MODEL = "imagen-4.0-fast-generate-001";

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isExhausted(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return err?.status === 429 ||
         msg.includes("resource_exhausted") ||
         msg.includes("quota") ||
         msg.includes("rate limit");
}

async function withKeyRotation(model, fn) {
  const maxAttempts = 15;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = getClient(model);
    if (!handle) throw new Error(`All keys exhausted for ${model} today.`);
    try {
      return await fn(handle.client);
    } catch (err) {
      lastErr = err;
      if (isExhausted(err)) {
        markKeyExhausted(handle.keyId, model);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("All rotation attempts failed");
}

// ── Step 1: Generate background image (NO text in prompt) ────────────────
function buildBackgroundPrompt(scene) {
  if (scene.isFirstScene) {
    // Intro: magical forest scene, cinematic
    return [
      "Magical fantasy forest landscape at golden hour",
      "Vibrant green trees, soft sunlight rays through canopy, sparkling fireflies",
      "Wide cinematic shot, depth of field, lens flare, warm atmosphere",
      "Empty foreground space at top and bottom for text overlay",
      "NO TEXT, NO LETTERS, NO WRITING, NO SIGNS, NO LOGOS",
      MASTER_STYLE_PROMPT,
    ].join(". ");
  }
  // CTA / outro: warm sunset forest
  return [
    "Warm sunset forest scene with friendly atmosphere",
    "Soft pink and orange sky, silhouetted trees, gentle bokeh lights",
    "Dreamy cinematic landscape, inviting and cheerful mood",
    "Empty center space for text overlay",
    "NO TEXT, NO LETTERS, NO WRITING, NO SIGNS, NO LOGOS",
    MASTER_STYLE_PROMPT,
  ].join(". ");
}

async function generateBackground(scene, outputPath, log) {
  if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
    log(`[Title] Background image exists, skipping`);
    return outputPath;
  }
  ensureDir(outputPath);
  const prompt = buildBackgroundPrompt(scene);
  log(`[Title] Imagen background: "${prompt.slice(0, 70)}..."`);

  const buffer = await withKeyRotation("imagen", async (client) => {
    const res = await client.models.generateImages({
      model: IMAGEN_MODEL,
      prompt,
      config: { numberOfImages: 1, aspectRatio: "9:16" },
    });
    const img = res.generatedImages?.[0];
    if (!img?.image?.imageBytes) throw new Error("Imagen returned no image");
    return Buffer.from(img.image.imageBytes, "base64");
  });

  writeFileSync(outputPath, buffer);
  log(`[Title] Background saved: ${(buffer.length / 1024).toFixed(0)}KB`);
  return outputPath;
}

// ── Step 2: Compose video with Ken Burns + text overlay ─────────────────
//
// FFmpeg drawtext escaping rules:
//   - colons must be escaped: \: → \\:
//   - single quotes around text value
//   - special chars in text need careful handling
//
// We escape: : ' \ % to be safe
// Strip emoji and other non-Latin/Vietnamese characters that the font
// doesn't have glyphs for (Montserrat lacks emoji → renders as ▢ tofu).
// Vietnamese accented characters (ậ, ẩ, ố, etc.) ARE supported and kept.
function stripUnsupportedGlyphs(s) {
  // Remove emoji ranges + miscellaneous symbols
  return String(s)
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "") // misc symbols & pictographs, emoticons, transport
    .replace(/[\u{2600}-\u{27BF}]/gu, "")    // misc symbols + dingbats (sun, star, etc.)
    .replace(/[\u{1F000}-\u{1F2FF}]/gu, "")  // Mahjong, dominos, playing cards
    .replace(/[\u{1FA00}-\u{1FAFF}]/gu, "")  // Symbols & pictographs extended
    .replace(/\s+/g, " ")
    .trim();
}

function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019") // smart quote substitute (FFmpeg-safe)
    .replace(/%/g, "\\%");
}

function escapePath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Build FFmpeg filter_complex for title card.
 *
 * Layers:
 *   1. Loop background image for 8s at 30fps
 *   2. Ken Burns: slow zoom-in (1.0 → 1.15)
 *   3. Dark gradient overlay (top + bottom) for text contrast
 *   4. Primary text (large, fade-in 0.5-2s, stays until end)
 *   5. Secondary text (medium, fade-in 1.5-3s, stays until end)
 */
function buildTitleFilter(primary, secondary) {
  const fontBold = escapePath(FONT_BOLD);
  const fontSemi = escapePath(FONT_SEMI);
  const primaryEsc = escapeDrawtext(stripUnsupportedGlyphs(primary));
  const secondaryEsc = escapeDrawtext(stripUnsupportedGlyphs(secondary));

  // Image-to-video pipeline:
  //   loop=loop=240:size=1 → 8 seconds at 30fps (240 frames)
  //   zoompan: gradual zoom 1.0 → 1.15 over 240 frames
  //   then drawbox for gradient overlay (semi-transparent dark band)
  //   then drawtext for primary + secondary text
  return [
    // Stage 1: image → video at 30fps, 8s, 1080x1920, with Ken Burns zoom
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "zoompan=z='min(zoom+0.0006,1.15)':d=240:s=1080x1920:fps=30",
    // Stage 2: dark gradient overlay (full screen, low opacity for readability)
    "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.35:t=fill",
    // Stage 3: primary text (top half, large, bold, drop shadow)
    `drawtext=fontfile='${fontBold}':text='${primaryEsc}':` +
      `fontsize=84:fontcolor=white:` +
      `x=(w-text_w)/2:y=(h/2)-160:` +
      `borderw=4:bordercolor=black@0.8:` +
      `shadowcolor=black@0.6:shadowx=4:shadowy=4:` +
      `alpha='if(lt(t,0.5),0,if(lt(t,2),(t-0.5)/1.5,1))'`,
    // Stage 4: secondary text (below primary, semi-bold, medium size)
    `drawtext=fontfile='${fontSemi}':text='${secondaryEsc}':` +
      `fontsize=56:fontcolor=#FFE08A:` +
      `x=(w-text_w)/2:y=(h/2)-40:` +
      `borderw=3:bordercolor=black@0.8:` +
      `shadowcolor=black@0.6:shadowx=3:shadowy=3:` +
      `alpha='if(lt(t,1.5),0,if(lt(t,3),(t-1.5)/1.5,1))'`,
  ].join(",");
}

async function composeTitleCard(backgroundPath, primary, secondary, outputPath, log) {
  ensureDir(outputPath);
  const filter = buildTitleFilter(primary, secondary);

  // Use filter script file (long filter chain may exceed cmd line limit)
  const filterFile = outputPath.replace(/\.mp4$/, "_filter.txt");
  writeFileSync(filterFile, filter);

  const cmd = [
    `${FFMPEG} -y`,
    `-loop 1 -i "${backgroundPath}"`,
    `-filter_complex_script "${filterFile}"`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `-t 8`,
    `-r 30`,
    `"${outputPath}"`,
  ].join(" ");

  log(`[Title] FFmpeg composing 8s title card...`);
  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 120_000 });

  try { unlinkSync(filterFile); } catch {}

  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(-500);
    throw new Error(`FFmpeg title card failed:\n${stderr}`);
  }

  if (!existsSync(outputPath)) {
    throw new Error("Title card output missing after FFmpeg");
  }

  const sizeMB = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
  log(`[Title] ✅ Title card saved: ${sizeMB}MB`);
  return outputPath;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Render a title scene (intro or CTA) with Imagen background + FFmpeg text overlay.
 * Returns same shape as renderScene() so the pipeline can use them interchangeably.
 *
 * @param {import("./scene-parser.mjs").ParsedScene} scene
 * @param {string} outputDir
 * @returns {Promise<{imagePath, clipPath, dialogue}>}
 */
export async function renderTitleScene(scene, outputDir) {
  const log = console.log;
  const sceneIdPadded = String(scene.id).padStart(2, "0");
  const imagePath = `${outputDir}/scene_${sceneIdPadded}.png`;
  const clipPath = `${outputDir}/scene_${sceneIdPadded}.mp4`;

  // Get the 2 overlay texts (provided by parser via episode metadata)
  const [primary, secondary] = scene.textOverlays.length >= 2
    ? scene.textOverlays
    : [scene.textOverlays[0] || "🌳 RỪNG XÌ TIN", scene.title];

  log(`[Title] Scene ${scene.id} title card: "${primary}" / "${secondary}"`);

  // Step 1: Imagen background (no text)
  await generateBackground(scene, imagePath, log);

  // Step 2: FFmpeg compose
  if (!existsSync(clipPath) || statSync(clipPath).size < 10000) {
    await composeTitleCard(imagePath, primary, secondary, clipPath, log);
  } else {
    log(`[Title] Clip exists, skipping FFmpeg`);
  }

  // Title scenes don't have dialogue (CTA may have voiceover but rendered separately)
  return { imagePath, clipPath, dialogue: [] };
}
