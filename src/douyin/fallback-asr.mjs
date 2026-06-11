/**
 * Gemini multimodal ASR fallback for Chinese videos.
 * Uploads video file → Gemini 2.5 Pro → SRT-formatted Chinese transcription.
 *
 * Why Pro over Flash: Flash tends to "lazy transcribe" — quits after the
 * first 30-60 seconds of repetitive narrative content. Pro follows
 * instructions more strictly and covers the full duration.
 *
 * Coverage check: after each attempt, validates that the LAST cue ends
 * within 30s of the video's true duration. If not, retries with stricter
 * prompt that explicitly demands full-coverage transcription.
 */
import "../env.js";
import { GoogleGenAI } from "@google/genai";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSRT } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Try Pro first (more thorough), fall back to Flash if Pro consistently fails.
const ASR_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"];

function buildPrompt({ durationSec, attempt }) {
  const stricter = attempt > 1
    ? `\n\n⚠ CRITICAL: previous attempt only transcribed the first part of the audio and missed most of the content. You MUST transcribe ALL speech from start to end. Do NOT stop early. The audio continues until ${durationSec}s — your LAST cue's end-time MUST be within 10s of that.`
    : "";

  return `You are transcribing a Chinese-language audio track into SRT subtitle format.

The audio duration is **${durationSec} seconds**. You MUST transcribe speech across the ENTIRE duration — from 0s until ${durationSec}s — not just the beginning.

Output requirements:
- Standard SRT: cue number, timestamp range "HH:MM:SS,mmm --> HH:MM:SS,mmm", text on next line, blank line between cues.
- Each cue ≤ 14 Chinese characters. Break longer sentences across consecutive cues.
- Timestamps must reflect WHEN each segment is actually spoken (do not bunch at the start).
- Cover the FULL ${durationSec}s — the last cue's end timestamp should be close to ${durationSec}s.
- Expect approximately ${Math.max(15, Math.round(durationSec / 4))} cues for this duration (one cue every ~4 seconds on average).
- Output ONLY the raw SRT content. No markdown fences. No commentary. No "here is the transcription".
- If the audio genuinely has no speech, output the literal string "NO_SPEECH" (nothing else).${stricter}`;
}

function stripCodeFence(s) {
  return s.replace(/^```(?:srt)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim();
}

function probeDurationSec(mp4_path) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", mp4_path,
  ], { encoding: "utf8", timeout: 30000 });
  const d = parseFloat(r.stdout.trim());
  if (Number.isNaN(d) || d <= 0) throw new Error(`Could not probe duration: ${r.stderr}`);
  return d;
}

/**
 * Extract mono AAC audio from the video for upload.
 *
 * Why audio-only instead of the full video:
 * 1. Upload size: 832s video ≈ 50MB; same audio at 64kbps mono ≈ 6.6MB.
 *    Large video uploads crash the Gemini SDK with an unhandled socket
 *    'write EOF' event that kills the whole node process.
 * 2. Token cost: Gemini charges ~263 tokens/s for video (frames included)
 *    vs ~32 tokens/s for audio — 8x cheaper for pure transcription.
 */
function extractAudio(mp4_path) {
  const audioPath = join(dirname(mp4_path), "asr_audio.m4a");
  const r = spawnSync("ffmpeg", [
    "-y", "-i", mp4_path,
    "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k",
    audioPath,
  ], { encoding: "utf8", timeout: 300_000, maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`audio extract failed: ${(r.stderr || "").slice(-500)}`);
  return audioPath;
}

async function callGemini(audio_path, prompt, model) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenAI({ apiKey });

  const uploaded = await ai.files.upload({
    file: audio_path,
    config: { mimeType: "audio/mp4" },
  });

  let info = uploaded;
  for (let i = 0; i < 30; i++) {
    info = await ai.files.get({ name: uploaded.name });
    if (info.state === "ACTIVE") break;
    if (info.state === "FAILED") throw new Error(`Gemini upload failed: ${info.error?.message}`);
    await sleep(2000);
  }
  if (info.state !== "ACTIVE") throw new Error("Gemini upload timeout");

  const res = await ai.models.generateContent({
    model,
    contents: [
      { fileData: { fileUri: info.uri, mimeType: "audio/mp4" } },
      { text: prompt },
    ],
    config: { maxOutputTokens: 16384 },
  });
  const text = res.text || res.candidates?.[0]?.content?.parts?.[0]?.text || "";

  try { await ai.files.delete({ name: info.name }); } catch {}

  return { raw: text, stripped: stripCodeFence(text) };
}

function dumpDebug(mp4_path, model, attempt, raw) {
  try {
    const dir = dirname(mp4_path);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `asr_debug_${model.replace(/[^a-z0-9]/gi, "_")}_attempt${attempt}.txt`);
    writeFileSync(path, raw || "(empty response)");
    log.warn("fallback-asr", `dumped raw response → ${path}`);
  } catch (e) {
    log.warn("fallback-asr", `failed to dump debug: ${e.message}`);
  }
}

export async function asrFallback(mp4_path) {
  const durationSec = Math.round(probeDurationSec(mp4_path));
  const coverageThresholdSec = durationSec * 0.85;
  log.info("fallback-asr", `video duration: ${durationSec}s, requiring coverage >= ${coverageThresholdSec.toFixed(0)}s`);

  // Extract audio once, reuse across all model attempts
  const audioPath = extractAudio(mp4_path);
  log.info("fallback-asr", `extracted audio for upload: ${audioPath}`);

  let lastErr;
  let bestCues = null;
  let bestCoverage = 0;

  // Try each model in order; for each, up to 2 attempts (with prompt escalation).
  // Total max calls = MODELS.length * 2 = 4. Stop early on success.
  for (const model of ASR_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        log.info("fallback-asr", `${model} attempt ${attempt}/2`);
        const { raw, stripped } = await callGemini(
          audioPath, buildPrompt({ durationSec, attempt }), model
        );

        if (stripped.trim() === "NO_SPEECH") {
          dumpDebug(mp4_path, model, attempt, raw);
          throw new Error(`${model} reports no speech in video`);
        }

        const cues = parseSRT(stripped);
        if (!cues.length) {
          dumpDebug(mp4_path, model, attempt, raw);
          throw new Error(`${model} returned 0 parseable cues (raw len=${raw.length}, stripped len=${stripped.length})`);
        }

        const lastEndSec = cues[cues.length - 1].end_ms / 1000;
        const coverage = lastEndSec / durationSec;
        log.info("fallback-asr",
          `${model} attempt ${attempt}: ${cues.length} cues, coverage ${(coverage * 100).toFixed(0)}% (last cue ends ${lastEndSec.toFixed(1)}s / ${durationSec}s)`
        );

        if (lastEndSec > bestCoverage) {
          bestCoverage = lastEndSec;
          bestCues = cues;
        }

        if (lastEndSec >= coverageThresholdSec) {
          log.info("fallback-asr", `✅ coverage acceptable, returning ${cues.length} cues from ${model}`);
          return cues;
        }

        log.warn("fallback-asr", `coverage ${(coverage * 100).toFixed(0)}% < 85% — escalating prompt`);
      } catch (e) {
        lastErr = e;
        log.warn("fallback-asr", `${model} attempt ${attempt} failed: ${e.message}`);
      }
      await sleep(1500);
    }
  }

  // All models + attempts done. Return best partial if any.
  if (bestCues) {
    log.warn("fallback-asr",
      `⚠ no model hit coverage threshold — returning best partial (${bestCues.length} cues, ends ${bestCoverage.toFixed(1)}s)`
    );
    return bestCues;
  }
  throw new Error(`asrFallback exhausted all models (${ASR_MODELS.join(", ")}): ${lastErr?.message || "unknown"}`);
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const mp4 = process.argv[2];
  if (!mp4) { console.error("usage: fallback-asr.mjs <mp4_path>"); process.exit(1); }
  asrFallback(mp4).then(r => console.log(JSON.stringify(r.slice(0, 5), null, 2)));
}
