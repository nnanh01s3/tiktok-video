/**
 * Compose final video: crop Douyin watermarks → scale 1080×1920 → libass burn-in VN subtitle.
 * Keeps original Chinese audio (-c:a copy).
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

function buildForceStyle() {
  const s = DOUYIN_CONFIG.subtitle;
  return [
    `Fontname=${s.fontName}`,
    `FontSize=${s.fontSize}`,
    `PrimaryColour=${s.primaryColour}`,
    `OutlineColour=${s.outlineColour}`,
    `BackColour=${s.backColour}`,
    `Outline=${s.outline}`,
    `Shadow=${s.shadow}`,
    `MarginV=${s.marginV}`,
    `Alignment=${s.alignment}`,
  ].join(",");
}

function escapeSubtitlePath(p) {
  // libass on Windows requires forward slashes + drive-letter escape:
  // 'D:/path/x.srt' → 'D\\:/path/x.srt'
  return resolve(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\\\:");
}

export async function compose({ mp4_path, vn_srt_path, output_path }) {
  if (!existsSync(mp4_path)) throw new Error(`mp4 not found: ${mp4_path}`);
  if (!existsSync(vn_srt_path)) throw new Error(`SRT not found: ${vn_srt_path}`);

  const { output } = DOUYIN_CONFIG;
  const cropKeepRatio = 1 - output.cropTopPct - output.cropBottomPct;

  const vf = [
    `crop=iw:ih*${cropKeepRatio}:0:ih*${output.cropTopPct}`,
    `scale=${output.width}:${output.height}:force_original_aspect_ratio=increase`,
    `crop=${output.width}:${output.height}`,
    `subtitles='${escapeSubtitlePath(vn_srt_path)}':force_style='${buildForceStyle()}'`,
  ].join(",");

  log.info("compose", `ffmpeg → ${output_path}`);
  const r = spawnSync("ffmpeg", [
    "-y",
    "-i", mp4_path,
    "-vf", vf,
    "-c:v", "libx264",
    "-crf", String(output.crf),
    "-preset", output.preset,
    "-r", String(output.fps),
    "-c:a", "copy",
    "-pix_fmt", "yuv420p",
    output_path,
  ], { encoding: "utf8", timeout: 600_000 });
  if (r.status !== 0) {
    throw new Error(`ffmpeg compose failed: ${r.stderr.slice(-1500)}`);
  }
  if (!existsSync(output_path) || statSync(output_path).size < 100_000) {
    throw new Error(`compose produced file <100KB: ${output_path}`);
  }
  return output_path;
}

// CLI smoke
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const id = process.argv[2];
  if (!id) { console.error("usage: compose.mjs <modal_id>"); process.exit(1); }
  const dir = join(DOUYIN_CONFIG.baseDir, id);
  compose({
    mp4_path: join(dir, "original.mp4"),
    vn_srt_path: join(dir, "subs_vn.srt"),
    output_path: join(dir, "composed.mp4"),
  }).then(p => console.log(p));
}
