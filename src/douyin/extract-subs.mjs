/**
 * Extract Chinese subtitles from Douyin video via:
 *   1. ffmpeg sample frames (bottom-cropped) at sampleIntervalMs
 *   2. PaddleOCR via ocr-paddle.mjs
 *   3. Dedup consecutive identical frames into SRT cues
 *   4. If cue count or avg confidence below threshold → fall back to Gemini ASR
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOCR } from "./ocr-paddle.mjs";
import { isSameText } from "./utils/jaccard.mjs";
import { serializeSRT } from "./utils/srt.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

/**
 * Pure function (exported for testing).
 * Merges consecutive OCR results with similar text into SRT cues.
 */
export function dedupOCRResults(ocrResults, { intervalMs, jaccardThreshold, minConfidence }) {
  const cues = [];
  let current = null;

  const sorted = [...ocrResults].sort((a, b) => a.frame_idx - b.frame_idx);

  for (const r of sorted) {
    const text = (r.text || "").trim();
    if (text.length < 2) { current = null; continue; }
    if (r.confidence < minConfidence) { current = null; continue; }

    if (current && isSameText(current.text, text, jaccardThreshold)) {
      current.end_frame = r.frame_idx;
      current.confidences.push(r.confidence);
    } else {
      if (current) cues.push(current);
      current = {
        text,
        start_frame: r.frame_idx,
        end_frame: r.frame_idx,
        confidences: [r.confidence],
      };
    }
  }
  if (current) cues.push(current);

  return cues.map((c, i) => ({
    index: i + 1,
    start_ms: c.start_frame * intervalMs,
    end_ms: (c.end_frame + 1) * intervalMs,
    text: c.text,
    confidence: c.confidences.reduce((a, b) => a + b, 0) / c.confidences.length,
  }));
}

async function sampleFrames(mp4_path, frames_dir) {
  mkdirSync(frames_dir, { recursive: true });
  const { ocr } = DOUYIN_CONFIG;
  const fps = 1 / (ocr.sampleIntervalMs / 1000);
  const cropFilter =
    `crop=iw:ih*${ocr.cropBottomRatio}:0:ih*${ocr.cropOffsetRatio}`;
  const r = spawnSync("ffmpeg", [
    "-y",
    "-i", mp4_path,
    "-vf", `fps=${fps},${cropFilter}`,
    "-q:v", "3",
    join(frames_dir, "%05d.jpg"),
  ], { encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`ffmpeg sample frames failed: ${r.stderr}`);
  return readdirSync(frames_dir)
    .filter(f => f.endsWith(".jpg"))
    .sort()
    .map(f => join(frames_dir, f));
}

export async function extractSubs(mp4_path, outDir) {
  const srt_path = join(outDir, "subs_cn.srt");
  const meta_path = join(outDir, "subs_meta.json");
  const frames_dir = join(outDir, "frames");

  let cues = [];
  let avgConf = 0;
  let ocrThrew = false;
  let ocrError = null;
  const ocrEnabled = DOUYIN_CONFIG.ocr.enabled !== false;

  if (ocrEnabled) {
    const frames = await sampleFrames(mp4_path, frames_dir);
    log.info("extract-subs", `sampled ${frames.length} frames`);

    try {
      const ocrResults = await runOCR(frames);
      cues = dedupOCRResults(ocrResults, {
        intervalMs: DOUYIN_CONFIG.ocr.sampleIntervalMs,
        jaccardThreshold: 0.85,
        minConfidence: DOUYIN_CONFIG.ocr.minConfidence,
      });
      avgConf = cues.length
        ? cues.reduce((a, c) => a + c.confidence, 0) / cues.length
        : 0;
      log.info("extract-subs", `OCR → ${cues.length} cues, avg_conf=${avgConf.toFixed(2)}`);
    } catch (e) {
      ocrThrew = true;
      ocrError = e.message;
      log.warn("extract-subs", `OCR crashed: ${e.message.slice(0, 200)} — will fallback to Gemini ASR`);
    }
  } else {
    log.info("extract-subs", "OCR disabled in config — going straight to Gemini ASR");
  }

  let source = "ocr";
  let finalCues = cues;

  const needFallback = !ocrEnabled || ocrThrew ||
    cues.length < DOUYIN_CONFIG.ocr.minCues ||
    avgConf < DOUYIN_CONFIG.ocr.minConfidence;

  if (needFallback) {
    log.warn("extract-subs", `→ Gemini ASR fallback (reason: ${ocrThrew ? "ocr crash" : "below threshold"})`);
    const { asrFallback } = await import("./fallback-asr.mjs");
    const asrCues = await asrFallback(mp4_path);
    finalCues = asrCues;
    source = "asr";
  }

  writeFileSync(srt_path, serializeSRT(finalCues));
  writeFileSync(meta_path, JSON.stringify({
    source,
    cue_count: finalCues.length,
    avg_confidence: avgConf,
    generated_at: new Date().toISOString(),
  }, null, 2));

  try { rmSync(frames_dir, { recursive: true, force: true }); } catch {}

  return { srt_path, source, cue_count: finalCues.length, avg_confidence: avgConf };
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const id = process.argv[2];
  if (!id) { console.error("usage: extract-subs.mjs <modal_id>"); process.exit(1); }
  const dir = join(DOUYIN_CONFIG.baseDir, id);
  const mp4 = join(dir, "original.mp4");
  if (!existsSync(mp4)) { console.error("no original.mp4 — run download.mjs first"); process.exit(1); }
  extractSubs(mp4, dir).then(r => console.log(JSON.stringify(r, null, 2)));
}
