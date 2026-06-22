/**
 * faster-whisper adapter — primary subtitle source with accurate timestamps.
 *
 * Extracts mono 16kHz audio, runs scripts/whisper_transcribe.py, returns
 * SRT-style cues whose timing is forced-aligned to the audio (unlike Gemini
 * ASR's estimated timestamps). Used by extract-subs.mjs as the primary path;
 * Gemini remains the fallback when Whisper is unavailable or errors.
 *
 * Returns: Array<{ index, start_ms, end_ms, text }>
 */
import "../env.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

// Whisper segments can run long; cap subtitle line length for readability by
// soft-splitting on punctuation. Keeps each on-screen line digestible.
const MAX_CHARS = 42;

function extractAudio16k(mp4_path) {
  const wav = join(dirname(mp4_path), "whisper_audio.wav");
  const r = spawnSync("ffmpeg", [
    "-y", "-i", mp4_path,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    wav,
  ], { encoding: "utf8", timeout: 300_000, maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`whisper audio extract failed: ${(r.stderr || "").slice(-400)}`);
  return wav;
}

function softSplit(seg) {
  // Split an over-long segment at Chinese/Latin punctuation into sub-cues,
  // distributing the segment's time window proportionally by char count.
  const text = seg.text;
  if (text.length <= MAX_CHARS) return [seg];
  const parts = text.split(/(?<=[，。！？、,.!?])/).filter(p => p.trim());
  if (parts.length < 2) return [seg];
  const total = text.length;
  const span = seg.end - seg.start;
  const out = [];
  let acc = 0;
  for (const p of parts) {
    const s = seg.start + (acc / total) * span;
    acc += p.length;
    const e = seg.start + (acc / total) * span;
    out.push({ start: s, end: e, text: p.trim() });
  }
  return out;
}

export async function whisperTranscribe(mp4_path, { lang = "zh", model = "large-v3" } = {}) {
  const wav = extractAudio16k(mp4_path);
  log.info("whisper", `transcribing (${model}, ${lang}) — this is CPU-bound, be patient`);

  const json = await new Promise((resolve, reject) => {
    const proc = spawn("python", ["scripts/whisper_transcribe.py", wav, "--lang", lang, "--model", model], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", d => { out += d.toString("utf8"); });
    proc.stderr.on("data", d => { err += d.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`whisper exit ${code}: ${err.slice(-400)}`));
      // The JSON is the last non-empty stdout line (warnings go to stderr)
      const line = out.trim().split("\n").filter(Boolean).pop() || "";
      try { resolve(JSON.parse(line)); }
      catch (e) { reject(new Error(`whisper bad JSON: ${line.slice(0, 200)}`)); }
    });
  });

  if (json.error) throw new Error(`whisper: ${json.error}`);
  const segs = json.segments || [];
  if (!segs.length) throw new Error("whisper returned 0 segments");

  // Soft-split long segments, then convert to cues
  const cues = [];
  for (const seg of segs) {
    for (const part of softSplit(seg)) {
      cues.push({
        index: cues.length + 1,
        start_ms: Math.round(part.start * 1000),
        end_ms: Math.round(part.end * 1000),
        text: part.text,
      });
    }
  }

  const lastEnd = cues[cues.length - 1].end_ms / 1000;
  log.info("whisper", `→ ${cues.length} cues, last ends ${lastEnd.toFixed(1)}s`);
  return cues;
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const mp4 = process.argv[2];
  if (!mp4 || !existsSync(mp4)) { console.error("usage: whisper-asr.mjs <mp4_path>"); process.exit(1); }
  whisperTranscribe(mp4).then(c => console.log(JSON.stringify(c.slice(0, 10), null, 2)));
}
