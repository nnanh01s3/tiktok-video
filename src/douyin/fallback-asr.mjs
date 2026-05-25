/**
 * Gemini multimodal ASR fallback for Chinese videos.
 * Uploads video file → Gemini 2.5 Flash → SRT-formatted Chinese transcription.
 */
import "../env.js";
import { GoogleGenAI } from "@google/genai";
import { parseSRT } from "./utils/srt.mjs";
import { createLogger } from "./utils/log.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ASR_PROMPT = `Transcribe this Chinese video into SRT subtitle format with precise timestamps.

Requirements:
- Use standard SRT format: cue number, timestamp range (HH:MM:SS,mmm --> HH:MM:SS,mmm), text, blank line.
- Each cue must be under 12 Chinese characters for natural reading rhythm. Break longer sentences across multiple cues.
- Timestamps must align with when each segment is spoken (do not bunch all at start).
- Output ONLY the raw SRT content. No markdown code fences. No commentary. No explanation.
- If the video has no speech, output an empty response.`;

function stripCodeFence(s) {
  return s.replace(/^```(?:srt)?\s*\n/i, "").replace(/\n```\s*$/i, "").trim();
}

async function callGemini(mp4_path) {
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
    model: "gemini-2.5-flash",
    contents: [
      { fileData: { fileUri: info.uri, mimeType: "video/mp4" } },
      { text: ASR_PROMPT },
    ],
  });
  const text = res.text || res.candidates?.[0]?.content?.parts?.[0]?.text || "";

  try { await ai.files.delete({ name: info.name }); } catch {}

  return stripCodeFence(text);
}

export async function asrFallback(mp4_path) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info("fallback-asr", `Gemini attempt ${attempt}/3`);
      const srtText = await callGemini(mp4_path);
      const cues = parseSRT(srtText);
      if (!cues.length) throw new Error("Gemini returned 0 cues");
      log.info("fallback-asr", `ASR → ${cues.length} cues`);
      return cues;
    } catch (e) {
      lastErr = e;
      log.warn("fallback-asr", `attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await sleep(2000 * Math.pow(2, attempt - 1));
    }
  }
  throw new Error(`asrFallback failed after 3 attempts: ${lastErr.message}`);
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const mp4 = process.argv[2];
  if (!mp4) { console.error("usage: fallback-asr.mjs <mp4_path>"); process.exit(1); }
  asrFallback(mp4).then(r => console.log(JSON.stringify(r.slice(0, 5), null, 2)));
}
