/**
 * Compose final video.
 *
 * Two video layout modes (toggle via DOUYIN_CONFIG.output.letterbox):
 *
 *   Letterbox (default for non-9:16 sources):
 *     crop watermark zones → scale-decrease to fit canvas → pad with black bars
 *     top+bottom → burn-in VN subtitle in the bottom black bar.
 *     Preserves source aspect ratio; subtitle has its own clean space.
 *
 *   Crop-fill (legacy):
 *     crop watermark → scale-increase → crop to canvas → subtitle on video.
 *     Fills frame fully but loses side content for landscape sources.
 *
 * Audio:
 *   - If voiceover_path provided: replace original audio with VN voice-over.
 *   - Else: copy original audio (CN narration).
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { parseSRT } from "./utils/srt.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

function probeWH(mp4_path) {
  const r = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    mp4_path,
  ], { encoding: "utf8", timeout: 30_000 });
  const [w, h] = (r.stdout || "").trim().split("x").map(Number);
  if (!w || !h) throw new Error(`ffprobe failed for ${mp4_path}: ${r.stderr}`);
  return { width: w, height: h };
}

function msToAssTs(ms) {
  // ASS uses h:mm:ss.cc (centiseconds, not milliseconds)
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
}

/**
 * Build a self-contained .ass subtitle file from our VN SRT.
 *
 * Why this exists: ffmpeg's `subtitles=file.srt:force_style=...` filter ignores
 * many style properties when the source is SRT — and worse, it scales FontSize
 * and MarginV by the implicit PlayRes ratio (defaults to 384×288 for SRT), so
 * sub ends up at the wrong position/size. Writing a proper ASS file with our
 * own ScriptInfo (PlayResX=output.width, PlayResY=output.height) and explicit
 * Style line gives pixel-accurate control.
 */
function writeAssFromSrt({ srt_path, ass_path, marginV }) {
  const s = DOUYIN_CONFIG.subtitle;
  const o = DOUYIN_CONFIG.output;
  const cues = parseSRT(readFileSync(srt_path, "utf8"));

  const header =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${o.width}
PlayResY: ${o.height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.fontName},${s.fontSize},${s.primaryColour},${s.primaryColour},${s.outlineColour},${s.backColour},0,0,0,0,100,100,0,0,1,${s.outline},${s.shadow},${s.alignment},40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues.map(c => {
    // Escape ASS-reserved chars in dialogue text
    const text = (c.text || "")
      .replace(/\r?\n/g, "\\N")
      .replace(/\{/g, "(")
      .replace(/\}/g, ")");
    return `Dialogue: 0,${msToAssTs(c.start_ms)},${msToAssTs(c.end_ms)},Default,,0,0,0,,${text}`;
  });

  writeFileSync(ass_path, header + events.join("\n") + "\n");
  return ass_path;
}

/**
 * Compute final video filter chain based on layout mode and source aspect.
 *
 * Returns { vf, marginV }.
 *   vf is the comma-separated filter chain (without subtitles= — caller appends).
 *   marginV is the subtitle MarginV value (computed so sub sits inside the
 *     bottom black bar in letterbox mode, or near bottom of video in crop mode).
 */
function buildVideoFilter(sourceW, sourceH) {
  const o = DOUYIN_CONFIG.output;
  const cropKeepRatio = 1 - o.cropTopPct - o.cropBottomPct;
  // After watermark crop: width unchanged, height = sourceH * cropKeepRatio
  const croppedH = sourceH * cropKeepRatio;
  const croppedW = sourceW;

  if (!o.letterbox) {
    // Legacy crop-fill (subtitle floats over video)
    return {
      vf: [
        `crop=iw:ih*${cropKeepRatio}:0:ih*${o.cropTopPct}`,
        `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase`,
        `crop=${o.width}:${o.height}`,
      ].join(","),
      marginV: DOUYIN_CONFIG.subtitle.marginV,
    };
  }

  // Letterbox: scale-decrease to fit canvas while preserving aspect,
  // then pad with the background color.
  // Compute scaled dimensions for marginV planning.
  const scaleW = o.width;
  const scaleH = Math.round(croppedH * (o.width / croppedW));
  // If scaled height > canvas height, decrease will use height ratio instead.
  let finalScaledW, finalScaledH;
  if (scaleH <= o.height) {
    // Width-bound (landscape/square source): bars top+bottom
    finalScaledW = scaleW;
    finalScaledH = scaleH;
  } else {
    // Height-bound (portrait source): tiny bars left+right (rare for Douyin)
    finalScaledH = o.height;
    finalScaledW = Math.round(croppedW * (o.height / croppedH));
  }

  // Bottom black-bar height (in output pixels) when letterboxing
  const bottomBarPx = Math.floor((o.height - finalScaledH) / 2);
  // Position subtitle inside the bottom bar (vertical center of bar).
  // libass MarginV measures from canvas bottom to bottom of text box.
  // For sub center = bar center: MarginV = bottomBarPx/2 - fontHeight/2.
  // Without a bar (portrait), default to the configured marginV.
  const minMarginVOnVideo = DOUYIN_CONFIG.subtitle.marginV;
  const marginV = bottomBarPx > 80
    ? Math.max(40, Math.round(bottomBarPx / 2 - DOUYIN_CONFIG.subtitle.fontSize))
    : minMarginVOnVideo;

  const vf = [
    `crop=iw:ih*${cropKeepRatio}:0:ih*${o.cropTopPct}`,
    `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease`,
    `pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=${o.backgroundColor || "black"}`,
  ].join(",");

  log.info("compose", `letterbox: source ${sourceW}x${sourceH} → fit ${finalScaledW}x${finalScaledH}, bottom bar=${bottomBarPx}px, marginV=${marginV}`);

  return { vf, marginV };
}

/**
 * @param {object} o
 * @param {string} o.mp4_path        source video
 * @param {string} o.vn_srt_path     VN subtitle (timed relative to the OUTPUT,
 *                                   i.e. starting at 0 — caller rebases for trims)
 * @param {string} o.output_path
 * @param {string|null} [o.voiceover_path]
 * @param {number|null} [o.trimStartSec]  if set, take only [trimStartSec, +trimDurSec)
 * @param {number|null} [o.trimDurSec]
 */
export async function compose({ mp4_path, vn_srt_path, output_path, voiceover_path = null, trimStartSec = null, trimDurSec = null }) {
  if (!existsSync(mp4_path)) throw new Error(`mp4 not found: ${mp4_path}`);
  if (!existsSync(vn_srt_path)) throw new Error(`SRT not found: ${vn_srt_path}`);
  if (voiceover_path && !existsSync(voiceover_path)) {
    throw new Error(`voiceover not found: ${voiceover_path}`);
  }

  const { output } = DOUYIN_CONFIG;

  const srtAbs = resolve(vn_srt_path);
  const mp4Abs = resolve(mp4_path);
  const outAbs = resolve(output_path);
  const cwd = dirname(srtAbs);

  // Probe source dimensions to compute letterbox + marginV
  const { width: sourceW, height: sourceH } = probeWH(mp4Abs);
  const { vf: videoFilter, marginV } = buildVideoFilter(sourceW, sourceH);

  // Convert SRT → ASS with proper PlayRes + Style. Using ffmpeg's
  // subtitles=file.srt:force_style ignored most of our overrides because
  // libass scaled them against the implicit PlayRes 384×288 and our
  // computed marginV exceeded the canvas height. Writing our own ASS
  // gives pixel-accurate control.
  const assPath = join(cwd, "subs_vn.ass");
  writeAssFromSrt({ srt_path: srtAbs, ass_path: assPath, marginV });
  const assName = basename(assPath);

  const vf = `${videoFilter},ass=${assName}`;

  // Build ffmpeg args based on whether we have a separate voiceover track
  if (voiceover_path) {
    log.info("compose", `audio: VN voiceover replaces original`);
  } else {
    log.info("compose", `audio: keep original CN`);
  }

  const args = ["-y"];
  // Trim: -ss before -i = fast seek to nearest keyframe ≤ start, then re-encode
  // (libx264 below) makes the cut frame-accurate. -t limits the duration.
  // The VN SRT/voiceover must already be rebased to segment-local time by the caller.
  const doTrim = trimStartSec != null && trimDurSec != null;
  if (doTrim) args.push("-ss", String(trimStartSec));
  args.push("-i", mp4Abs);
  if (voiceover_path) args.push("-i", resolve(voiceover_path));
  if (doTrim) args.push("-t", String(trimDurSec));
  args.push("-vf", vf);
  args.push("-c:v", "libx264", "-crf", String(output.crf), "-preset", output.preset);
  args.push("-r", String(output.fps));
  if (voiceover_path) {
    // Video from original (input 0), audio from voiceover (input 1)
    args.push("-map", "0:v:0", "-map", "1:a:0",
              "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else {
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-c:a", "copy");
  }
  args.push("-pix_fmt", "yuv420p");
  args.push(outAbs);

  log.info("compose", `ffmpeg → ${output_path}`);
  const r = spawnSync("ffmpeg", args, {
    encoding: "utf8", timeout: 1200_000, cwd, maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`ffmpeg compose failed: ${(r.stderr || "").slice(-1500)}`);
  }
  if (!existsSync(output_path) || statSync(output_path).size < 10_000) {
    throw new Error(`compose produced suspiciously small file (<10KB): ${output_path}`);
  }
  return output_path;
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const id = process.argv[2];
  if (!id) { console.error("usage: compose.mjs <modal_id>"); process.exit(1); }
  const dir = join(DOUYIN_CONFIG.baseDir, id);
  const voiceover = join(dir, "voiceover.m4a");
  compose({
    mp4_path: join(dir, "original.mp4"),
    vn_srt_path: join(dir, "subs_vn.srt"),
    output_path: join(dir, "composed.mp4"),
    voiceover_path: existsSync(voiceover) ? voiceover : null,
  }).then(p => console.log(p));
}
