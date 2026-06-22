/**
 * YouTube reup pipeline — take a (already-Vietnamese) long compilation, remove
 * the source channel's watermark, cut into content-based segments, add OUR
 * channel logo + a consistent numbered cover, output TikTok-ready clips.
 *
 * No translation/voiceover: the source already has VN audio + burned-in subs.
 * This is pure video editing: delogo → trim → (logo overlay) → cover.
 *
 * Config: DOUYIN_CONFIG.ytreup (delogo box, logo, aspect, cover style).
 *
 * Functions:
 *   cutSegment({ src, startSec, durSec, partNum, outPath })  → clip mp4
 *   makeCover({ src, atSec, partNum, outPath })              → cover jpg
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

function cfg() {
  return DOUYIN_CONFIG.ytreup;
}

/** Build the video filter chain: delogo (remove source watermark) → aspect → our logo. */
function buildFilter({ partLabel } = {}) {
  const c = cfg();
  const parts = [];

  // 1. Remove source channel watermark
  if (c.delogo) {
    const d = c.delogo;
    parts.push(`delogo=x=${d.x}:y=${d.y}:w=${d.w}:h=${d.h}`);
  }

  // 2. Aspect: "keep" (16:9 as-is) or "vertical" (letterbox to 1080x1920)
  if (c.aspect === "vertical") {
    parts.push(`scale=1080:1920:force_original_aspect_ratio=decrease`);
    parts.push(`pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black`);
  } else {
    // keep 16:9 but standardize to 1280x720
    parts.push(`scale=1280:720:force_original_aspect_ratio=decrease`);
    parts.push(`pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black`);
  }

  return parts.join(",");
}

/**
 * Cut one segment: trim + delogo + optional our-logo overlay, keep VN audio.
 */
export function cutSegment({ src, startSec, durSec, outPath }) {
  const c = cfg();
  const srcAbs = resolve(src);
  const outAbs = resolve(outPath);

  const vf = buildFilter();

  // Our logo overlay (PNG with alpha). Uses a second input + overlay filter.
  const useLogo = c.logoPath && existsSync(resolve(c.logoPath));
  let filterComplex, mapV;
  if (useLogo) {
    // scale logo to logoWidthPx, overlay at (logoX, logoY)
    filterComplex =
      `[0:v]${vf}[base];` +
      `[1:v]scale=${c.logoWidthPx}:-1[lg];` +
      `[base][lg]overlay=${c.logoX}:${c.logoY}[v]`;
    mapV = "[v]";
  } else {
    filterComplex = `[0:v]${vf}[v]`;
    mapV = "[v]";
  }

  const args = ["-y", "-ss", String(startSec), "-i", srcAbs];
  if (useLogo) args.push("-i", resolve(c.logoPath));
  args.push("-t", String(durSec));
  args.push("-filter_complex", filterComplex);
  args.push("-map", mapV, "-map", "0:a:0?");
  args.push("-c:v", "libx264", "-crf", String(c.crf), "-preset", c.preset, "-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-b:a", "160k");
  args.push(outAbs);

  log.info("ytreup", `cut [${startSec.toFixed(0)}s +${durSec.toFixed(0)}s] → ${outPath}${useLogo ? " (+logo)" : ""}`);
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`cutSegment failed: ${(r.stderr || "").slice(-1200)}`);
  if (!existsSync(outAbs) || statSync(outAbs).size < 10_000) throw new Error(`cut produced tiny file: ${outPath}`);
  return outPath;
}

/**
 * Make a consistent cover thumbnail: a frame from the segment + dark gradient
 * + big "PHẦN N" (or label) text + optional our logo. Same template every part
 * so the series is recognizable.
 */
export function makeCover({ src, atSec, partLabel, outPath }) {
  const c = cfg();
  const cv = c.cover;
  const srcAbs = resolve(src);
  const outAbs = resolve(outPath);
  const useLogo = c.logoPath && existsSync(resolve(c.logoPath));

  // Escape text for drawtext
  const label = String(partLabel).replace(/:/g, "\\:").replace(/'/g, "");

  // Base frame → scale to cover size → darken bottom band → draw label.
  // BorderStyle: text with box for readability.
  const W = cv.width, H = cv.height;
  const fontFile = cv.fontFile ? `:fontfile='${cv.fontFile.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : "";
  const c2 = cfg();
  const drawParts = [];
  // Remove source watermark on the cover too
  if (c2.delogo) {
    const d = c2.delogo;
    drawParts.push(`delogo=x=${d.x}:y=${d.y}:w=${d.w}:h=${d.h}`);
  }
  drawParts.push(
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
    // Opaque-enough bottom band to fully hide the source's burned-in subtitle
    // (which sits ~bottom-center) and give the label a clean backdrop.
    `drawbox=x=0:y=${H - cv.bandH}:w=${W}:h=${cv.bandH}:color=black@0.82:t=fill`,
    // big episode/part label, vertically centered in the band
    `drawtext=text='${label}'${fontFile}:fontcolor=${cv.textColor}:fontsize=${cv.fontSize}:` +
      `borderw=${cv.borderW}:bordercolor=black:x=(w-text_w)/2:y=${cv.textY}`,
  );

  let filterComplex, mapV;
  if (useLogo) {
    filterComplex =
      `[0:v]${drawParts.join(",")}[base];` +
      `[1:v]scale=${c.logoWidthPx}:-1[lg];` +
      `[base][lg]overlay=${c.logoX}:${c.logoY}[v]`;
    mapV = "[v]";
  } else {
    filterComplex = `[0:v]${drawParts.join(",")}[v]`;
    mapV = "[v]";
  }

  const args = ["-y", "-ss", String(atSec), "-i", srcAbs];
  if (useLogo) args.push("-i", resolve(c.logoPath));
  args.push("-frames:v", "1", "-filter_complex", filterComplex, "-map", mapV, "-update", "1", outAbs);

  log.info("ytreup", `cover "${partLabel}" → ${outPath}`);
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`makeCover failed: ${(r.stderr || "").slice(-1200)}`);
  return outPath;
}
