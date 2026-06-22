#!/usr/bin/env node
/**
 * Recap (thuyết minh / 解说) repurposer — replicates the VN anime-recap channel
 * format: continuous Vietnamese narration + caption box + ducked original BGM,
 * 16:9 output.
 *
 * Flow:
 *   download → full ASR transcript → write VN recap script (continuous) →
 *   TTS sequentially (no overlap) → caption SRT from voiceover timing →
 *   composeRecap (16:9 + caption box + ducked BGM + narration)
 *
 * Usage:
 *   node src/douyin/repurpose-recap.mjs --url "https://www.douyin.com/video/<id>"
 *   node src/douyin/repurpose-recap.mjs --resume <modal_id>
 */
import "../env.js";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createState } from "./state.mjs";
import { createLogger } from "./utils/log.mjs";
import { serializeSRT } from "./utils/srt.mjs";
import { download } from "./download.mjs";
import { extractSubs } from "./extract-subs.mjs";
import { generateRecap } from "./recap.mjs";
import { generateRecapVoiceover } from "./tts.mjs";
import { composeRecap } from "./compose.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const state = createState(DOUYIN_CONFIG.stateFile);

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { url: null, resume: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--url") out.url = a[++i];
    else if (a[i] === "--resume") out.resume = a[++i];
  }
  return out;
}

function extractModalId(url) {
  const m = url.match(/[/?&]modal_id=(\d+)/) || url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function probeDurationSec(mp4) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", mp4,
  ], { encoding: "utf8", timeout: 30_000 });
  return parseFloat(r.stdout.trim()) || 0;
}

async function main() {
  const opts = parseArgs();
  const modal_id = opts.resume || (opts.url && extractModalId(opts.url));
  if (!modal_id) { console.error("need --url or --resume <modal_id>"); process.exit(1); }

  const dir = join(DOUYIN_CONFIG.baseDir, modal_id);
  mkdirSync(dir, { recursive: true });
  const original_mp4 = join(dir, "original.mp4");
  const subs_cn = join(dir, "subs_cn.srt");
  const caption_srt = join(dir, "caption_vn.srt");
  const voiceover = join(dir, "voiceover.m4a");
  const composed = join(dir, "composed_recap.mp4");

  log.info("recap-pipe", `▶ ${modal_id}`);

  // 1. Download
  if (!existsSync(original_mp4) || statSync(original_mp4).size < 100_000) {
    await download(modal_id);
  }
  const durationSec = Math.round(probeDurationSec(original_mp4));

  // 2. Full transcript (Whisper primary)
  if (!existsSync(subs_cn)) {
    await extractSubs(original_mp4, dir);
  }

  // 3. Generate continuous VN recap script
  const { sentences } = await generateRecap(subs_cn, durationSec);

  // 4. TTS sequentially → voiceover + caption timings
  const { captions, total_sec } = await generateRecapVoiceover(sentences, dir);

  // 5. Write caption SRT from voiceover timing
  const captionCues = captions.map((c, i) => ({
    index: i + 1, start_ms: c.start_ms, end_ms: c.end_ms, text: c.text,
  }));
  writeFileSync(caption_srt, serializeSRT(captionCues));

  // 6. Compose recap-style. If the narration is much shorter than the video
  // (action-heavy episode → short recap), trim output to the narration length
  // so there's no silent tail. If they're close, keep the full video.
  const trimToNarration = total_sec < durationSec * 0.85 ? total_sec + 1.5 : null;
  if (trimToNarration) {
    log.info("recap-pipe", `narration ${total_sec.toFixed(0)}s << video ${durationSec}s → trimming output to narration`);
  }
  await composeRecap({
    mp4_path: original_mp4,
    caption_srt_path: caption_srt,
    voiceover_path: voiceover,
    output_path: composed,
    maxDurSec: trimToNarration,
  });

  state.upsert(modal_id, { status: "recap_done", recap_sentences: sentences.length });
  log.info("recap-pipe", `✅ ${modal_id} → ${composed}`);
  console.log(`\n✅ Recap video: ${composed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
