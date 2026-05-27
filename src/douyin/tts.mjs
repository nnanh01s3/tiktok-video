/**
 * Vietnamese voice-over generation for Douyin storytelling videos.
 *
 * Strategy: render each VN SRT cue to mp3 via MS Edge TTS, then mux them
 * into a single audio track using ffmpeg's adelay+amix filter graph. Each
 * cue's audio starts at cue.start_ms in the final mix.
 *
 * Returns: { voiceover_path: string, cue_count: number }
 *
 * Why MS Edge TTS: free, offline, has natural-sounding Vietnamese voices
 * (vi-VN-NamMinhNeural is a calm mid-age male — perfect for cultivation
 * narration). For better emotion control, swap to Gemini or ElevenLabs later.
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseSRT } from "./utils/srt.mjs";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

/**
 * Render a single text snippet to mp3 via MS Edge TTS.
 * Returns the path to the written file.
 */
async function renderCueMp3(text, outPath, { voice, rate, pitch }) {
  const { MsEdgeTTS } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, "audio-24khz-48kbitrate-mono-mp3");

  const { audioStream } = tts.toStream(text, {
    rate: rate || "+0%",
    pitch: pitch || "+0Hz",
    volume: "+0%",
  });

  const chunks = [];
  await new Promise((resolve, reject) => {
    audioStream.on("data", (chunk) => {
      if (chunk instanceof Buffer) chunks.push(chunk);
    });
    audioStream.on("end", resolve);
    audioStream.on("error", reject);
  });

  if (!chunks.length) throw new Error(`Edge TTS produced 0 bytes for: "${text.slice(0, 40)}..."`);

  const buf = Buffer.concat(chunks);
  writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Probe audio duration in seconds via ffprobe.
 */
function probeDurationSec(audioPath) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", audioPath,
  ], { encoding: "utf8", timeout: 15_000 });
  return parseFloat(r.stdout.trim()) || 0;
}

export async function generateVoiceover(vn_srt_path, outDir, opts = {}) {
  const cfg = { ...DOUYIN_CONFIG.tts, ...opts };
  const cues = parseSRT(readFileSync(vn_srt_path, "utf8"));
  if (!cues.length) throw new Error("tts: no cues in VN SRT");

  const ttsDir = join(outDir, "tts");
  mkdirSync(ttsDir, { recursive: true });
  const voiceoverPath = join(outDir, "voiceover.m4a");

  log.info("tts", `rendering ${cues.length} cues with ${cfg.voice}`);

  // Step 1: render each cue to its own mp3 file. Track natural duration so
  // we can compute atempo when a cue overruns its allotted SRT window.
  const cueFiles = [];
  for (const cue of cues) {
    const mp3path = join(ttsDir, `cue_${String(cue.index).padStart(3, "0")}.mp3`);
    try {
      await renderCueMp3(cue.text, mp3path, cfg);
      const naturalSec = probeDurationSec(mp3path);
      const slotSec = (cue.end_ms - cue.start_ms) / 1000;
      cueFiles.push({
        index: cue.index,
        text: cue.text,
        mp3: mp3path,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        natural_sec: naturalSec,
        slot_sec: slotSec,
      });
    } catch (e) {
      log.warn("tts", `cue ${cue.index} failed: ${e.message} — skipping`);
    }
  }

  if (!cueFiles.length) throw new Error("tts: all cues failed");
  log.info("tts", `rendered ${cueFiles.length}/${cues.length} cues`);

  // Step 2: build ffmpeg filter_complex.
  // For each cue: [N:a]adelay=START|START,atempo=RATIO[aN]
  //   - adelay places audio at start_ms in both stereo channels (we use mono input but stereo output)
  //   - atempo speeds up if natural duration > slot, slows down if much shorter (clamped)
  // Then: [a0][a1]...amix=inputs=K:duration=longest:normalize=0[out]
  //
  // Note: atempo accepts [0.5, 100.0]. For ratios outside that, chain multiple
  // atempo filters. We clamp aggressive: max 1.4x faster, no slowdown if natural < slot
  // (silence will fill the gap naturally via adelay).

  const inputs = [];
  const filterParts = [];
  cueFiles.forEach((c, i) => {
    inputs.push("-i", c.mp3);
    let chain = `[${i}:a]adelay=${c.start_ms}|${c.start_ms}`;
    // atempo only if needed: TTS overruns the slot
    if (c.natural_sec > c.slot_sec && c.slot_sec > 0.5) {
      const ratio = Math.min(1.4, c.natural_sec / c.slot_sec);
      chain += `,atempo=${ratio.toFixed(3)}`;
    }
    chain += `[a${i}]`;
    filterParts.push(chain);
  });

  const mixIn = cueFiles.map((_, i) => `[a${i}]`).join("");
  // duration=longest ensures the mix tracks the full timeline
  // normalize=0 means we don't auto-attenuate when many cues mix (cues rarely overlap)
  let filter = `${filterParts.join(";")};${mixIn}amix=inputs=${cueFiles.length}:duration=longest:normalize=0[mixed]`;

  // Optional loudnorm pass for consistent volume across cues
  let outputLabel = "[mixed]";
  if (cfg.normalize) {
    filter += `;[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
    outputLabel = "[out]";
  }

  log.info("tts", `mixing ${cueFiles.length} cues → ${voiceoverPath}`);
  const r = spawnSync("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", filter,
    "-map", outputLabel,
    "-c:a", "aac",
    "-b:a", "128k",
    voiceoverPath,
  ], { encoding: "utf8", timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });

  if (r.status !== 0) {
    throw new Error(`ffmpeg amix failed: ${(r.stderr || "").slice(-1500)}`);
  }
  if (!existsSync(voiceoverPath) || statSync(voiceoverPath).size < 10_000) {
    throw new Error(`voiceover produced suspiciously small file: ${voiceoverPath}`);
  }

  // Cleanup per-cue mp3s (keep voiceover.m4a)
  try { rmSync(ttsDir, { recursive: true, force: true }); } catch {}

  return { voiceover_path: voiceoverPath, cue_count: cueFiles.length };
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const id = process.argv[2];
  if (!id) { console.error("usage: tts.mjs <modal_id>"); process.exit(1); }
  const dir = join(DOUYIN_CONFIG.baseDir, id);
  const srt = join(dir, "subs_vn.srt");
  if (!existsSync(srt)) { console.error(`no ${srt}`); process.exit(1); }
  generateVoiceover(srt, dir).then(r => console.log(JSON.stringify(r, null, 2)));
}
