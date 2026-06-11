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
  //
  // Edge TTS rate-limits rapid sequential requests — symptoms: alternating
  // cues return 0 bytes (cue 4,6,7,9 fail while 5,8 succeed). Mitigation:
  // small inter-cue delay + per-cue retry with backoff.
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const cueFiles = [];
  for (const cue of cues) {
    const mp3path = join(ttsDir, `cue_${String(cue.index).padStart(3, "0")}.mp3`);
    let rendered = false;
    for (let attempt = 1; attempt <= 3 && !rendered; attempt++) {
      try {
        await renderCueMp3(cue.text, mp3path, cfg);
        rendered = true;
      } catch (e) {
        if (attempt < 3) {
          log.warn("tts", `cue ${cue.index} attempt ${attempt} failed (${e.message.slice(0, 60)}) — retrying in ${attempt}s`);
          await sleep(attempt * 1000);
        } else {
          log.warn("tts", `cue ${cue.index} failed after 3 attempts — skipping`);
        }
      }
    }
    if (rendered) {
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
    }
    // Gentle pacing between requests to stay under Edge TTS rate limit
    await sleep(300);
  }

  if (!cueFiles.length) throw new Error("tts: all cues failed");
  log.info("tts", `rendered ${cueFiles.length}/${cues.length} cues`);

  // Step 2: build ffmpeg filter_complex.
  // Strategy: use a silent base track (anullsrc) sized to the LAST cue's end_ms
  // as input 0, then mix all cues delayed by adelay on top. With anullsrc as
  // input 0 and amix duration=first, the output is EXACTLY the silent track
  // length — guarantees all delayed cues are captured even those at minute 4+.
  //
  // Why this matters: without the silent base, amix's "duration=longest" looks
  // at INPUT durations not the delayed-output duration, and may close the mix
  // before late-delayed cues finish playing back. Adding the silent base of
  // explicit length forces the output timeline to be at least that long.
  //
  // atempo: speed up TTS clip (max 1.4×) when natural duration > SRT slot,
  // so the next cue's spoken line doesn't get clipped by a long-winded earlier cue.

  // Calculate baseline duration = last cue's end_ms + 2s headroom (or natural
  // overrun on final cue).
  const lastCue = cueFiles[cueFiles.length - 1];
  const baselineSec = Math.ceil(lastCue.end_ms / 1000) + Math.ceil(lastCue.natural_sec) + 2;

  // CHUNKED HIERARCHICAL MIXING.
  // A single amix of 300+ inputs exceeds the Windows 32k command-line limit
  // (the spawn fails before ffmpeg starts, with empty stderr). Instead:
  //   1. Mix cues in chunks of ≤40 over a full-length silent base each —
  //      absolute adelay values, so every chunk file has identical duration.
  //   2. Mix the chunk files (a handful of inputs) into the final track.
  const CHUNK_SIZE = 40;
  const chunks = [];
  for (let i = 0; i < cueFiles.length; i += CHUNK_SIZE) {
    chunks.push(cueFiles.slice(i, i + CHUNK_SIZE));
  }

  log.info("tts", `mixing ${cueFiles.length} cues in ${chunks.length} chunk(s) → ${voiceoverPath} (baseline ${baselineSec}s)`);

  function mixChunk(chunkCues, outPath, withNormalize = false) {
    const inputs = ["-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100:d=${baselineSec}`];
    const filterParts = [];
    chunkCues.forEach((c, i) => {
      inputs.push("-i", c.mp3);
      const inputIdx = i + 1; // shift past anullsrc
      let chain = `[${inputIdx}:a]adelay=${c.start_ms}|${c.start_ms}`;
      if (c.natural_sec > c.slot_sec && c.slot_sec > 0.5) {
        const ratio = Math.min(1.4, c.natural_sec / c.slot_sec);
        chain += `,atempo=${ratio.toFixed(3)}`;
      }
      chain += `[a${i}]`;
      filterParts.push(chain);
    });
    const mixIn = `[0:a]` + chunkCues.map((_, i) => `[a${i}]`).join("");
    let filter = `${filterParts.join(";")};${mixIn}amix=inputs=${chunkCues.length + 1}:duration=first:normalize=0[mixed]`;
    let outputLabel = "[mixed]";
    if (withNormalize) {
      filter += `;[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
      outputLabel = "[out]";
    }
    const r = spawnSync("ffmpeg", [
      "-y", ...inputs,
      "-filter_complex", filter,
      "-map", outputLabel,
      "-c:a", "aac", "-b:a", "128k",
      outPath,
    ], { encoding: "utf8", timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });
    if (r.status !== 0) {
      throw new Error(`ffmpeg chunk mix failed (${chunkCues.length} cues): ${(r.stderr || r.error?.message || "empty stderr — likely cmdline too long").slice(-800)}`);
    }
  }

  if (chunks.length === 1) {
    // Single chunk: mix directly to final output (with loudnorm if enabled)
    mixChunk(chunks[0], voiceoverPath, cfg.normalize);
  } else {
    // Mix each chunk to an intermediate, then merge intermediates
    const chunkPaths = [];
    chunks.forEach((chunk, ci) => {
      const p = join(ttsDir, `chunk_${String(ci).padStart(2, "0")}.m4a`);
      log.info("tts", `  chunk ${ci + 1}/${chunks.length} (${chunk.length} cues)`);
      mixChunk(chunk, p, false);
      chunkPaths.push(p);
    });

    // Final merge: chunks all share the same baseline length → amix duration=first
    const inputs = [];
    chunkPaths.forEach(p => inputs.push("-i", p));
    const mixIn = chunkPaths.map((_, i) => `[${i}:a]`).join("");
    let filter = `${mixIn}amix=inputs=${chunkPaths.length}:duration=first:normalize=0[mixed]`;
    let outputLabel = "[mixed]";
    if (cfg.normalize) {
      filter += `;[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
      outputLabel = "[out]";
    }
    const r = spawnSync("ffmpeg", [
      "-y", ...inputs,
      "-filter_complex", filter,
      "-map", outputLabel,
      "-c:a", "aac", "-b:a", "128k",
      voiceoverPath,
    ], { encoding: "utf8", timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });
    if (r.status !== 0) {
      throw new Error(`ffmpeg final merge failed: ${(r.stderr || "").slice(-800)}`);
    }
  }

  if (!existsSync(voiceoverPath) || statSync(voiceoverPath).size < 10_000) {
    throw new Error(`voiceover produced suspiciously small file: ${voiceoverPath}`);
  }

  // Cleanup per-cue mp3s + chunk intermediates (keep voiceover.m4a)
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
