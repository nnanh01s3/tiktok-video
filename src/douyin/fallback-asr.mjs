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
import { parseSRT } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ASR_MODEL = "gemini-2.5-pro";

function buildPrompt({ durationSec, attempt }) {
  const stricter = attempt > 1
    ? `\n\n⚠ CRITICAL: previous attempt only transcribed the first part of the video and missed most of the content. You MUST transcribe ALL speech from start to end. Do NOT stop early. The video continues until ${durationSec}s — your LAST cue's end-time MUST be within 10s of that.`
    : "";

  return `You are transcribing a Chinese-language video into SRT subtitle format.

The video duration is **${durationSec} seconds**. You MUST transcribe speech across the ENTIRE duration — from 0s until ${durationSec}s — not just the beginning.

Output requirements:
- Standard SRT: cue number, timestamp range "HH:MM:SS,mmm --> HH:MM:SS,mmm", text on next line, blank line between cues.
- Each cue ≤ 14 Chinese characters. Break longer sentences across consecutive cues.
- Timestamps must reflect WHEN each segment is actually spoken (do not bunch at the start).
- Cover the FULL ${durationSec}s — the last cue's end timestamp should be close to ${durationSec}s.
- Expect approximately ${Math.max(15, Math.round(durationSec / 4))} cues for this duration (one cue every ~4 seconds on average).
- Output ONLY the raw SRT content. No markdown fences. No commentary. No "here is the transcription".
- If the video genuinely has no speech, output the literal string "NO_SPEECH" (nothing else).${stricter}`;
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

async function callGemini(mp4_path, prompt) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenAI({ apiKey });

  const uploaded = await ai.files.upload({
    file: mp4_path,
    config: { mimeType: "video/mp4" },
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
    model: ASR_MODEL,
    contents: [
      { fileData: { fileUri: info.uri, mimeType: "video/mp4" } },
      { text: prompt },
    ],
    config: { maxOutputTokens: 16384 },
  });
  const text = res.text || res.candidates?.[0]?.content?.parts?.[0]?.text || "";

  try { await ai.files.delete({ name: info.name }); } catch {}

  return stripCodeFence(text);
}

export async function asrFallback(mp4_path) {
  const durationSec = Math.round(probeDurationSec(mp4_path));
  const coverageThresholdSec = durationSec * 0.85; // last cue must end past this point
  log.info("fallback-asr", `video duration: ${durationSec}s, requiring coverage >= ${coverageThresholdSec.toFixed(0)}s`);

  let lastErr;
  let bestCues = null;
  let bestCoverage = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info("fallback-asr", `Gemini ${ASR_MODEL} attempt ${attempt}/3`);
      const srtText = await callGemini(mp4_path, buildPrompt({ durationSec, attempt }));
      if (srtText.trim() === "NO_SPEECH") {
        throw new Error("Gemini reports no speech in video");
      }
      const cues = parseSRT(srtText);
      if (!cues.length) throw new Error("Gemini returned 0 cues");

      const lastEndSec = cues[cues.length - 1].end_ms / 1000;
      const coverage = lastEndSec / durationSec;
      log.info("fallback-asr", `attempt ${attempt}: ${cues.length} cues, coverage ${(coverage * 100).toFixed(0)}% (last cue ends ${lastEndSec.toFixed(1)}s / ${durationSec}s)`);

      // Track best result so far
      if (lastEndSec > bestCoverage) {
        bestCoverage = lastEndSec;
        bestCues = cues;
      }

      if (lastEndSec >= coverageThresholdSec) {
        log.info("fallback-asr", `✅ coverage acceptable, returning ${cues.length} cues`);
        return cues;
      }

      log.warn("fallback-asr", `coverage ${(coverage * 100).toFixed(0)}% < 85% — retrying with stricter prompt`);
    } catch (e) {
      lastErr = e;
      log.warn("fallback-asr", `attempt ${attempt} failed: ${e.message}`);
    }
    if (attempt < 3) await sleep(2000 * Math.pow(2, attempt - 1));
  }

  // All 3 attempts done. Return best partial result if we have one, else throw.
  if (bestCues) {
    log.warn("fallback-asr", `⚠ all attempts under coverage threshold — returning best partial (${bestCues.length} cues, ends ${bestCoverage.toFixed(1)}s)`);
    return bestCues;
  }
  throw new Error(`asrFallback failed after 3 attempts: ${lastErr?.message || "unknown"}`);
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const mp4 = process.argv[2];
  if (!mp4) { console.error("usage: fallback-asr.mjs <mp4_path>"); process.exit(1); }
  asrFallback(mp4).then(r => console.log(JSON.stringify(r.slice(0, 5), null, 2)));
}
