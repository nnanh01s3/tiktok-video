#!/usr/bin/env node
/**
 * Dub-style repurposer — VN voiceover SYNCED to the video's dialogue timing.
 *
 * Unlike recap mode (free-flowing narration), here each VN line is spoken at
 * the exact moment the character speaks the corresponding Chinese line (from
 * the Whisper transcript). Translation is CONCISE so each line fits its spoken
 * window; clips are sped up (≤1.7×) where needed to avoid overlapping the next
 * line. Original audio is ducked to 15% underneath (BGM/SFX preserved).
 *
 * Flow:
 *   download → Whisper transcript (accurate dialogue timing) →
 *   translate(concise) → synced voiceover (TTS at dialogue timestamps) →
 *   composeRecap (16:9 + caption box + ducked BGM + synced voiceover, full length)
 *
 * Usage:
 *   node src/douyin/repurpose-dub.mjs --url "https://www.douyin.com/video/<id>"
 *   node src/douyin/repurpose-dub.mjs --resume <modal_id>
 */
import "../env.js";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createState } from "./state.mjs";
import { createLogger } from "./utils/log.mjs";
import { download } from "./download.mjs";
import { extractSubs } from "./extract-subs.mjs";
import { translateSRT } from "./translate.mjs";
import { generateVoiceover } from "./tts.mjs";
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

async function main() {
  const opts = parseArgs();
  const modal_id = opts.resume || (opts.url && extractModalId(opts.url));
  if (!modal_id) { console.error("need --url or --resume <modal_id>"); process.exit(1); }

  const dir = join(DOUYIN_CONFIG.baseDir, modal_id);
  mkdirSync(dir, { recursive: true });
  const original_mp4 = join(dir, "original.mp4");
  const subs_cn = join(dir, "subs_cn.srt");
  const subs_vn = join(dir, "subs_vn_dub.srt");
  const voiceover = join(dir, "voiceover.m4a");
  const composed = join(dir, "composed_dub.mp4");

  log.info("dub-pipe", `▶ ${modal_id}`);

  // 1. Download
  if (!existsSync(original_mp4) || statSync(original_mp4).size < 100_000) {
    await download(modal_id);
  }

  // 2. Whisper transcript (accurate dialogue timing — essential for sync)
  if (!existsSync(subs_cn)) {
    await extractSubs(original_mp4, dir);
  }

  // 3. Translate CONCISELY (each line must fit its spoken window)
  await translateSRT(subs_cn, subs_vn, { concise: true });

  // 4. Synced voiceover: TTS placed at each dialogue timestamp, atempo-fit
  await generateVoiceover(subs_vn, dir);

  // 5. Compose: 16:9 + caption box (= the dubbed line, synced) + ducked BGM
  //    + synced voiceover. Full video length (no trim — dub tracks the whole video).
  await composeRecap({
    mp4_path: original_mp4,
    caption_srt_path: subs_vn,
    voiceover_path: voiceover,
    output_path: composed,
    maxDurSec: null,
  });

  state.upsert(modal_id, { status: "dub_done" });
  log.info("dub-pipe", `✅ ${modal_id} → ${composed}`);
  console.log(`\n✅ Dub video (synced): ${composed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
