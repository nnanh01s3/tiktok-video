/**
 * Title card renderer — multi-sub-shot cinematic intro/outro with text overlay.
 *
 * Why multi-sub-shot?
 *   Veo 8s clips can't handle 5 distinct beats (space → clouds → forest → sign → text).
 *   Veo simplifies/skips beats and the result is a single static-ish scene.
 *
 *   Solution: split the cinematic intro into N sub-shots, each with its own
 *   Imagen starting frame + Veo motion. Concat with crossfades. Add text
 *   overlay on the last sub-shot (FFmpeg drawtext for reliable Vietnamese).
 *
 * Flow per sub-shot:
 *   1. Imagen generates starting frame (e.g., "Earth from space")
 *   2. Veo image-to-video animates that frame ("Camera dives toward Earth")
 *   3. FFmpeg trims to desired duration (e.g., 2.5s)
 *
 * After all sub-shots rendered:
 *   4. FFmpeg concat with crossfades
 *   5. Add Vietnamese text overlay on the LAST segment (drawtext + Montserrat)
 *
 * Cost per scene: 3 Imagen ($0.06) + 3 Veo ($1.20) = $1.26
 * Compared to single Veo ($0.42) but vastly better quality.
 */
import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { dirname } from "path";
import { getClient, markKeyExhausted } from "./gemini-keys.js";
import { getSubShotsForTitleScene } from "./intro-config.mjs";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FONT_BOLD = "D:/tiktok/assets/fonts/Montserrat-Bold.ttf";
const FONT_SEMI = "D:/tiktok/assets/fonts/Montserrat-SemiBold.ttf";
const IMAGEN_MODEL = "imagen-4.0-fast-generate-001";
const VEO_MODEL = "veo-3.1-lite-generate-preview";

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 60;

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

// Some keys lack access to specific models (e.g., Imagen 3 only on paid plans).
// These should also trigger key rotation — try another key from the pool.
function isKeyAccessDenied(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("only available on paid") ||
         msg.includes("invalid_argument") && msg.includes("imagen") ||
         msg.includes("permission_denied") ||
         msg.includes("failed_precondition");
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
      if (isKeyAccessDenied(err)) {
        // Key doesn't have access to this model — mark exhausted to skip it
        console.log(`[KeyPool] ${handle.keyId} lacks access to ${model}, rotating...`);
        markKeyExhausted(handle.keyId, model);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("All rotation attempts failed");
}

// ── Strip emoji/symbol glyphs that Montserrat lacks (renders as ▢ tofu) ──
function stripUnsupportedGlyphs(s) {
  return String(s)
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{1F000}-\u{1F2FF}]/gu, "")
    .replace(/[\u{1FA00}-\u{1FAFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%");
}

function escapePath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// ── Step 1: Generate starting frame for a sub-shot (Imagen) ──────────────
async function generateSubShotImage(subShot, outputPath, log) {
  if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
    log(`[Title]   Image cached: ${subShot.id}`);
    return outputPath;
  }
  ensureDir(outputPath);
  log(`[Title]   Imagen: ${subShot.id} - "${subShot.imagenPrompt.slice(0, 60)}..."`);

  const buffer = await withKeyRotation("imagen", async (client) => {
    const res = await client.models.generateImages({
      model: IMAGEN_MODEL,
      prompt: subShot.imagenPrompt,
      config: { numberOfImages: 1, aspectRatio: "9:16" },
    });
    const img = res.generatedImages?.[0];
    if (!img?.image?.imageBytes) throw new Error("Imagen returned no image");
    return Buffer.from(img.image.imageBytes, "base64");
  });

  writeFileSync(outputPath, buffer);
  log(`[Title]   ✅ Image saved: ${(buffer.length / 1024).toFixed(0)}KB`);
  return outputPath;
}

// ── Step 2: Animate sub-shot image with Veo (image-to-video) ─────────────
async function generateSubShotClip(subShot, imagePath, outputPath, log) {
  if (existsSync(outputPath) && statSync(outputPath).size > 10000) {
    log(`[Title]   Veo clip cached: ${subShot.id}`);
    return outputPath;
  }
  ensureDir(outputPath);
  log(`[Title]   Veo: ${subShot.id} - "${subShot.motionPrompt.slice(0, 60)}..."`);

  const imageBytes = readFileSync(imagePath).toString("base64");

  await withKeyRotation("veo", async (client) => {
    let operation = await client.models.generateVideos({
      model: VEO_MODEL,
      prompt: subShot.motionPrompt,
      image: { imageBytes, mimeType: "image/png" },
      config: { aspectRatio: "9:16" },
    });

    let attempts = 0;
    while (!operation.done) {
      if (++attempts > MAX_POLL_ATTEMPTS) {
        throw new Error(`Veo timeout for sub-shot ${subShot.id}`);
      }
      if (attempts % 3 === 0) {
        log(`[Title]   ${subShot.id} Veo... ${attempts * 10}s elapsed`);
      }
      await sleep(POLL_INTERVAL_MS);
      operation = await client.operations.getVideosOperation({ operation });
    }

    const videos = operation.response?.generatedVideos;
    if (!videos || videos.length === 0) {
      throw new Error(`Veo returned no videos for sub-shot ${subShot.id}`);
    }
    await client.files.download({ file: videos[0].video, downloadPath: outputPath });
  });

  log(`[Title]   ✅ Veo clip saved: ${subShot.id}`);
  return outputPath;
}

// ── Step 3: Trim each sub-shot clip to desired duration ──────────────────
function trimClip(inputPath, outputPath, durationSec, log) {
  if (existsSync(outputPath) && statSync(outputPath).size > 10000) return outputPath;

  const cmd = `${FFMPEG} -y -i "${inputPath}" -t ${durationSec.toFixed(2)} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -an "${outputPath}"`;
  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`FFmpeg trim failed: ${result.stderr?.slice(-300)}`);
  }
  log(`[Title]   Trimmed to ${durationSec}s`);
  return outputPath;
}

// ── Step 4: Concat all trimmed clips with crossfade transitions ─────────
function concatWithCrossfade(trimmedPaths, totalDuration, outputPath, log) {
  // Use concat demuxer (no transitions, simpler) — quick cuts work for fast intros
  // If we want crossfade, we'd use xfade filter (more complex)
  const concatList = outputPath.replace(/\.mp4$/, "_concat.txt");
  const content = trimmedPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  writeFileSync(concatList, content);

  // Use filter to scale uniformly + concat
  const cmd = [
    `${FFMPEG} -y`,
    `-f concat -safe 0 -i "${concatList}"`,
    `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30"`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `"${outputPath}"`,
  ].join(" ");

  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 120_000 });
  try { unlinkSync(concatList); } catch {}

  if (result.status !== 0) {
    throw new Error(`FFmpeg concat failed: ${result.stderr?.slice(-500)}`);
  }
  log(`[Title]   Concatenated ${trimmedPaths.length} sub-shots`);
  return outputPath;
}

// ── Step 5: Overlay Vietnamese text on the final video ──────────────────
//
// We overlay text starting from the LAST sub-shot's start time, fading in
// during that period. Earlier sub-shots show pure cinematic motion.
function overlayText(inputPath, outputPath, primary, secondary, textStartSec, log) {
  const fontBold = escapePath(FONT_BOLD);
  const fontSemi = escapePath(FONT_SEMI);
  const primaryEsc = escapeDrawtext(stripUnsupportedGlyphs(primary));
  const secondaryEsc = escapeDrawtext(stripUnsupportedGlyphs(secondary));

  // Text fades in starting at textStartSec, becomes fully visible 1s later
  const fadeInStart = textStartSec;
  const fadeInEnd = textStartSec + 1.0;
  const secondaryDelay = textStartSec + 0.5;
  const secondaryFadeEnd = textStartSec + 1.5;

  const filter = [
    // Slight darken on the bottom half for text contrast (semi-transparent gradient)
    `drawbox=x=0:y=ih/2:w=iw:h=ih/2:color=black@0.4:t=fill`,
    // Primary text (large, bold, white)
    `drawtext=fontfile='${fontBold}':text='${primaryEsc}':` +
      `fontsize=84:fontcolor=white:` +
      `x=(w-text_w)/2:y=(h/2)+120:` +
      `borderw=4:bordercolor=black@0.85:` +
      `shadowcolor=black@0.7:shadowx=4:shadowy=4:` +
      `alpha='if(lt(t,${fadeInStart}),0,if(lt(t,${fadeInEnd}),(t-${fadeInStart})/1,1))'`,
    // Secondary text (medium, gold)
    `drawtext=fontfile='${fontSemi}':text='${secondaryEsc}':` +
      `fontsize=56:fontcolor=#FFE08A:` +
      `x=(w-text_w)/2:y=(h/2)+260:` +
      `borderw=3:bordercolor=black@0.85:` +
      `shadowcolor=black@0.7:shadowx=3:shadowy=3:` +
      `alpha='if(lt(t,${secondaryDelay}),0,if(lt(t,${secondaryFadeEnd}),(t-${secondaryDelay})/1,1))'`,
  ].join(",");

  const filterFile = outputPath.replace(/\.mp4$/, "_textfilter.txt");
  writeFileSync(filterFile, filter);

  const cmd = [
    `${FFMPEG} -y`,
    `-i "${inputPath}"`,
    `-filter_complex_script "${filterFile}"`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `-c:a copy`,
    `"${outputPath}"`,
  ].join(" ");

  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 120_000 });
  try { unlinkSync(filterFile); } catch {}

  if (result.status !== 0) {
    throw new Error(`FFmpeg text overlay failed: ${result.stderr?.slice(-500)}`);
  }
  log(`[Title]   ✅ Text overlay added`);
  return outputPath;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Render a title scene as multi-sub-shot cinematic + text overlay.
 *
 * @param {import("./scene-parser.mjs").ParsedScene} scene
 * @param {string} outputDir
 * @returns {Promise<{imagePath, clipPath, dialogue}>}
 */
export async function renderTitleScene(scene, outputDir) {
  const log = console.log;
  const sceneIdPadded = String(scene.id).padStart(2, "0");
  const finalClipPath = `${outputDir}/scene_${sceneIdPadded}.mp4`;
  // Compatibility: composer expects imagePath but title scenes don't really need one.
  // Use the first sub-shot's image as the "representative" image for the scene.

  // Get sub-shots template for this scene type
  const subShots = getSubShotsForTitleScene(scene);
  log(`[Title] Scene ${scene.id}: ${subShots.length} sub-shots`);

  // Get text overlay (provided by parser via episode metadata)
  const [primary, secondary] = scene.textOverlays.length >= 2
    ? scene.textOverlays
    : [scene.textOverlays[0] || "RỪNG XÌ TIN", scene.title];
  log(`[Title] Text: "${primary}" / "${secondary}"`);

  // Step 1+2: Generate Imagen + Veo for each sub-shot
  const trimmedPaths = [];
  let totalDuration = 0;

  for (let i = 0; i < subShots.length; i++) {
    const sub = subShots[i];
    const idx = String(i + 1).padStart(2, "0");
    const imagePath = `${outputDir}/scene_${sceneIdPadded}_sub${idx}.png`;
    const clipPath = `${outputDir}/scene_${sceneIdPadded}_sub${idx}.mp4`;
    const trimmedPath = `${outputDir}/scene_${sceneIdPadded}_sub${idx}_trimmed.mp4`;

    await generateSubShotImage(sub, imagePath, log);
    await generateSubShotClip(sub, imagePath, clipPath, log);
    trimClip(clipPath, trimmedPath, sub.trimDuration, log);
    trimmedPaths.push(trimmedPath);
    totalDuration += sub.trimDuration;
  }

  // Step 3: Concat sub-shots
  const concatPath = `${outputDir}/scene_${sceneIdPadded}_nooverlay.mp4`;
  concatWithCrossfade(trimmedPaths, totalDuration, concatPath, log);

  // Step 4: Add text overlay starting at last sub-shot's beginning
  // (text appears AFTER the cinematic motion, when camera arrives at the sign)
  const lastSubStart = totalDuration - subShots[subShots.length - 1].trimDuration;
  overlayText(concatPath, finalClipPath, primary, secondary, lastSubStart, log);

  // Cleanup intermediates (keep sub-shot files for resumability/debugging)
  try { unlinkSync(concatPath); } catch {}

  // Return path to first sub-shot image as the representative scene image
  const firstSubImage = `${outputDir}/scene_${sceneIdPadded}_sub01.png`;
  return {
    imagePath: firstSubImage,
    clipPath: finalClipPath,
    dialogue: [],
  };
}
