/**
 * Title card renderer — multi-sub-shot cinematic intro/outro with text overlay.
 *
 * Why multi-sub-shot?
 *   Veo 8s clips can't handle 5 distinct beats (space → clouds → forest → sign → text).
 *   Veo simplifies/skips beats and the result is a single static-ish scene.
 *
 *   Solution: split the cinematic intro into N sub-shots, each with its own
 *   Imagen OR chained last-frame starting image + Veo motion. Concat with
 *   xfade crossfades for a smooth "one-shot" feel. Add small episode subtitle
 *   overlay on the final segment (Option C hybrid).
 *
 * v4 innovations:
 *   - LAST-FRAME CHAINING: sub-shots flagged `chainFromPrevious:true` use the
 *     previous clip's last frame as Veo's starting image → pixel-level visual
 *     continuity with no hard cut mid-shot.
 *   - XFADE TRANSITIONS: 0.5s crossfade between all sub-shots instead of hard
 *     concat → extra smoothness even where chaining isn't used.
 *   - HYBRID TEXT: Imagen renders "RUNG XI TIN" carved into the wooden sign
 *     (looks native to the scene), while FFmpeg drawtext adds the per-episode
 *     subtitle "TẬP N: ..." (reliable Vietnamese diacritics).
 *
 * Flow per sub-shot:
 *   1. Starting frame:
 *        - if chainFromPrevious && i > 0 → extractLastFrame(prev clip)
 *        - else                         → Imagen generates frame
 *   2. Veo image-to-video animates that frame
 *
 * After all sub-shots rendered:
 *   3. FFmpeg filter_complex xfade (video) + acrossfade (audio)
 *   4. FFmpeg drawtext overlay for episode subtitle on last segment
 *
 * Cost per scene 1 (v4): 2 Imagen ($0.04) + 3 Veo ($1.26) = $1.30
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

// ── Extract last frame of a video as PNG ────────────────────────────────
// Used for "last-frame chaining": the last frame of clip N becomes the
// starting image for clip N+1, giving pixel-level visual continuity.
//
// Why -sseof -0.1 + -frames:v 1?
//   -sseof -0.1 seeks to 0.1s BEFORE end-of-file (fast, uses index)
//   -frames:v 1 captures a single frame from that point
//   Alternative (-vf "select=eq(n\,last)") would decode every frame.
function extractLastFrame(videoPath, outputImgPath, log) {
  if (existsSync(outputImgPath) && statSync(outputImgPath).size > 1000) {
    log(`[Title]   Last frame cached: ${outputImgPath.split(/[\\/]/).pop()}`);
    return outputImgPath;
  }
  ensureDir(outputImgPath);
  const cmd = `${FFMPEG} -y -sseof -0.1 -i "${videoPath}" -frames:v 1 -q:v 2 "${outputImgPath}"`;
  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`FFmpeg extractLastFrame failed: ${result.stderr?.slice(-500)}`);
  }
  log(`[Title]   ✅ Extracted last frame → ${outputImgPath.split(/[\\/]/).pop()}`);
  return outputImgPath;
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

// ── Step 3: Concat sub-shots with xfade crossfades ──────────────────────
//
// Previous version used the concat demuxer → hard cuts between sub-shots.
// v4 uses filter_complex xfade (video) + acrossfade (audio) for ~0.5s
// crossfade transitions. Combined with last-frame chaining, this gives
// a true "one-shot" feel.
//
// Math (for 3 clips × 8s with 0.5s xfade):
//   Clip 1 plays 0..8s
//   xfade 1: offset=7.5 → clip 2 fades in 7.5..8, output length = 15.5s
//   xfade 2: offset=15  → clip 3 fades in 15..15.5, output length = 23.5s
//   Final duration ≈ N*8 - (N-1)*0.5 = 23s for N=3
//
// Why normalize (scale+pad+fps) first?
//   Veo clips may differ slightly in codec params; normalizing ensures
//   xfade sees identical pixel format/dimensions.
function concatSubShotsWithXfade(clipPaths, outputPath, xfadeDur, log) {
  const n = clipPaths.length;
  if (n === 0) throw new Error("No clips to concat");

  // Single clip → just re-encode to normalized form
  if (n === 1) {
    const cmd = [
      `${FFMPEG} -y -i "${clipPaths[0]}"`,
      `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30"`,
      `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
      `-c:a aac -b:a 128k -ar 44100`,
      `"${outputPath}"`,
    ].join(" ");
    const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 180_000 });
    if (r.status !== 0) throw new Error(`FFmpeg single-clip re-encode failed: ${r.stderr?.slice(-500)}`);
    return outputPath;
  }

  const CLIP_DUR = 8; // Veo 3.1 Lite outputs 8s clips
  const inputs = clipPaths.map((p) => `-i "${p}"`).join(" ");

  // 1) Normalize each video input → [v0n], [v1n], [v2n], ...
  const scaleFilters = clipPaths.map((_, i) =>
    `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30[v${i}n]`
  );

  // 2) Chain video xfade: [v0n][v1n]xfade... → [vx1] → [v2n]xfade... → [vout]
  const videoChain = [];
  let prevV = "[v0n]";
  let offset = CLIP_DUR - xfadeDur; // first xfade offset = 7.5 for 8s clips + 0.5 xfade
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? "[vout]" : `[vx${i}]`;
    videoChain.push(
      `${prevV}[v${i}n]xfade=transition=fade:duration=${xfadeDur}:offset=${offset}${out}`
    );
    prevV = out;
    offset += CLIP_DUR - xfadeDur;
  }

  // 3) Chain audio crossfade (runs in parallel — same number of stages)
  const audioChain = [];
  let prevA = "[0:a]";
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? "[aout]" : `[ax${i}]`;
    audioChain.push(
      `${prevA}[${i}:a]acrossfade=d=${xfadeDur}${out}`
    );
    prevA = out;
  }

  const filterComplex = [...scaleFilters, ...videoChain, ...audioChain].join(";");
  const filterFile = outputPath.replace(/\.mp4$/, "_xfade.txt");
  writeFileSync(filterFile, filterComplex);

  const cmd = [
    `${FFMPEG} -y`,
    inputs,
    `-filter_complex_script "${filterFile}"`,
    `-map "[vout]" -map "[aout]"`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `-c:a aac -b:a 128k -ar 44100`,
    `"${outputPath}"`,
  ].join(" ");

  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 300_000 });
  try { unlinkSync(filterFile); } catch {}

  if (result.status !== 0) {
    throw new Error(`FFmpeg xfade concat failed: ${result.stderr?.slice(-1000)}`);
  }
  log(`[Title]   ✅ Concatenated ${n} sub-shots with ${xfadeDur}s xfade`);
  return outputPath;
}

// ── Step 4: Overlay episode subtitle (Option C hybrid) ──────────────────
//
// Series title "RỪNG XÌ TIN" is rendered by Imagen on the wooden sign
// (looks native). Episode subtitle "TẬP N: ..." needs reliable Vietnamese
// diacritics → FFmpeg drawtext with Montserrat-SemiBold.
//
// Position: small text near the bottom of the frame (doesn't cover the sign).
// Timing: fades in when the sign is fully visible (around 16-17s for 3
// sub-shots × 8s with xfade). Stays visible until the end.
function overlayEpisodeSubtitle(inputPath, outputPath, subtitle, overlayStartSec, log) {
  if (!subtitle) {
    // No subtitle — just copy the concat output to the final path
    const cmd = `${FFMPEG} -y -i "${inputPath}" -c copy "${outputPath}"`;
    const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(`FFmpeg copy failed: ${r.stderr?.slice(-500)}`);
    log(`[Title]   (no episode subtitle, copied as-is)`);
    return outputPath;
  }

  const fontSemi = escapePath(FONT_SEMI);
  const subtitleEsc = escapeDrawtext(stripUnsupportedGlyphs(subtitle));
  const fadeInEnd = overlayStartSec + 0.8;

  // Medium-size gold text near the bottom quarter, fades in smoothly.
  // Box drawn behind for readability contrast (semi-transparent black bar).
  //
  // filter_complex requires explicit [0:v] input and [vout] output labels
  // (unlike -vf which implicitly wires them). Filters inside a chain are
  // comma-separated and feed each other automatically.
  const filterBody = [
    `drawbox=x=0:y=h-260:w=iw:h=140:color=black@0.35:t=fill:` +
      `enable='gte(t,${overlayStartSec})'`,
    `drawtext=fontfile='${fontSemi}':text='${subtitleEsc}':` +
      `fontsize=54:fontcolor=#FFE08A:` +
      `x=(w-text_w)/2:y=h-220:` +
      `borderw=3:bordercolor=black@0.85:` +
      `shadowcolor=black@0.7:shadowx=3:shadowy=3:` +
      `alpha='if(lt(t,${overlayStartSec}),0,if(lt(t,${fadeInEnd}),(t-${overlayStartSec})/0.8,1))'`,
  ].join(",");
  const filter = `[0:v]${filterBody}[vout]`;

  const filterFile = outputPath.replace(/\.mp4$/, "_subtitle.txt");
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
    throw new Error(`FFmpeg episode subtitle overlay failed: ${result.stderr?.slice(-500)}`);
  }
  log(`[Title]   ✅ Episode subtitle overlay added (audio preserved)`);
  return outputPath;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Render a title scene as multi-sub-shot cinematic + hybrid text overlay.
 *
 * @param {import("./scene-parser.mjs").ParsedScene} scene
 * @param {string} outputDir
 * @returns {Promise<{imagePath, clipPath, dialogue}>}
 */
export async function renderTitleScene(scene, outputDir) {
  const log = console.log;
  const sceneIdPadded = String(scene.id).padStart(2, "0");

  // v4: last-frame chaining + xfade transitions + hybrid text
  //   _v1 = FFmpeg drawtext full overlay (ugly)
  //   _v2 = Vietnamese diacritics in Imagen (wrong diacritics)
  //   _v3 = ASCII hardcoded + hard concat (jerky transitions, off-script)
  //   _v4 = on-script prompts + chained sub-shots + xfade + episode subtitle
  const VERSION = "v4";
  const finalClipPath = `${outputDir}/scene_${sceneIdPadded}_${VERSION}.mp4`;
  const concatPath = `${outputDir}/scene_${sceneIdPadded}_${VERSION}_concat.mp4`;

  const subShots = getSubShotsForTitleScene(scene);
  const includedCount = subShots.filter((s) => !s.excludeFromConcat).length;
  log(`[Title] Scene ${scene.id}: ${subShots.length} sub-shots total, ${includedCount} in final cut (${VERSION})`);

  const SUB_CLIP_DURATION = 8;
  const XFADE_DURATION = 0.5;

  // Two arrays:
  //   allGeneratedClips: every generated sub-shot (index-aligned with subShots)
  //     — used for chainFromPrevious lookups even if the previous is excluded
  //   subClipPaths: only clips that pass excludeFromConcat filter → fed to xfade
  const allGeneratedClips = [];
  const subClipPaths = [];

  for (let i = 0; i < subShots.length; i++) {
    const sub = subShots[i];
    const idx = String(i + 1).padStart(2, "0");
    const suffix = `_${VERSION}`;
    const imagePath = `${outputDir}/scene_${sceneIdPadded}_sub${idx}${suffix}.png`;
    const clipPath = `${outputDir}/scene_${sceneIdPadded}_sub${idx}${suffix}.mp4`;

    // Starting frame: chained last-frame OR fresh Imagen
    // Chain always references the previous clip in the ORIGINAL array, even
    // if that previous clip is excludeFromConcat — visual continuity still
    // needs its last frame as the starting image for chaining.
    if (sub.chainFromPrevious && i > 0) {
      log(`[Title]   Sub ${sub.id}: chaining from previous clip's last frame`);
      extractLastFrame(allGeneratedClips[i - 1], imagePath, log);
    } else {
      await generateSubShotImage(sub, imagePath, log);
    }

    await generateSubShotClip(sub, imagePath, clipPath, log);
    allGeneratedClips.push(clipPath);

    if (sub.excludeFromConcat) {
      log(`[Title]   Sub ${sub.id}: excludeFromConcat=true (kept on disk, not in final cut)`);
      continue;
    }
    subClipPaths.push(clipPath);
  }

  if (subClipPaths.length === 0) {
    throw new Error(`Title scene ${scene.id}: no clips passed excludeFromConcat filter`);
  }

  // Step 3: Concat with xfade crossfades (only included clips)
  concatSubShotsWithXfade(subClipPaths, concatPath, XFADE_DURATION, log);

  // Step 4: Option C hybrid — episode subtitle overlay
  //   textOverlays[0] = "🌳 RỪNG XÌ TIN" (skipped — already on the wooden sign)
  //   textOverlays[1] = "TẬP N: EPISODE TITLE" (FFmpeg drawtext)
  const episodeSubtitle = scene.textOverlays?.[1] || "";

  // Subtitle timing — show ~3.5s before the scene ends. Works for any
  // number of included sub-shots:
  //   2 sub-shots (15.5s) → subtitle at 12.0s (3.5s visible)
  //   3 sub-shots (23.0s) → subtitle at 19.5s (3.5s visible)
  // This keeps the wooden sign fully readable before the subtitle joins it.
  const totalIncludedDuration =
    subClipPaths.length * SUB_CLIP_DURATION - (subClipPaths.length - 1) * XFADE_DURATION;
  const overlayStart = Math.max(1, totalIncludedDuration - 3.5);
  overlayEpisodeSubtitle(concatPath, finalClipPath, episodeSubtitle, overlayStart, log);

  // Return the first INCLUDED sub-shot's image (may not be sub01)
  const firstIncludedIdx = subShots.findIndex((s) => !s.excludeFromConcat);
  const firstIdxPadded = String(firstIncludedIdx + 1).padStart(2, "0");
  const firstSubImage = `${outputDir}/scene_${sceneIdPadded}_sub${firstIdxPadded}_${VERSION}.png`;

  return {
    imagePath: firstSubImage,
    clipPath: finalClipPath,
    dialogue: [],
  };
}
