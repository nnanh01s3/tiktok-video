#!/usr/bin/env node
/**
 * Series/compilation repurposer.
 *
 * Splits a long video into content-based segments (2-4 min narrative arcs),
 * then runs each segment through the normal repurpose pipeline (translate →
 * TTS → letterbox compose), producing one postable clip per segment.
 *
 * Usage:
 *   node src/douyin/repurpose-series.mjs --url "https://www.douyin.com/video/<id>"
 *   node src/douyin/repurpose-series.mjs --resume <modal_id>
 *   node src/douyin/repurpose-series.mjs --resume <id> --min 120 --max 240
 *
 * Output: D:/tiktok/douyin/<modal_id>/seg_NN/composed.mp4  (one per segment)
 *
 * Each segment is independent: a failed segment doesn't stop the others.
 */
import "../env.js";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createState } from "./state.mjs";
import { createLogger } from "./utils/log.mjs";
import { serializeSRT } from "./utils/srt.mjs";
import { download } from "./download.mjs";
import { extractSubs } from "./extract-subs.mjs";
import { splitSegments } from "./split-segments.mjs";
import { translateSRT } from "./translate.mjs";
import { generateVoiceover } from "./tts.mjs";
import { compose } from "./compose.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const state = createState(DOUYIN_CONFIG.stateFile);

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { url: null, resume: null, min: 120, max: 240, skipPublish: true };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--url") out.url = a[++i];
    else if (a[i] === "--resume") out.resume = a[++i];
    else if (a[i] === "--min") out.min = parseInt(a[++i]);
    else if (a[i] === "--max") out.max = parseInt(a[++i]);
  }
  return out;
}

function extractModalId(url) {
  const m = url.match(/[/?&]modal_id=(\d+)/) || url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

/** Rebase cues so the first cue's start becomes ~0; clamp negatives to 0. */
function rebaseCues(cues, offsetMs) {
  return cues.map((c, i) => ({
    index: i + 1,
    start_ms: Math.max(0, c.start_ms - offsetMs),
    end_ms: Math.max(0, c.end_ms - offsetMs),
    text: c.text,
  }));
}

async function processSegment(modal_id, dir, seg, original_mp4, original_title_cn) {
  const segDir = join(dir, `seg_${String(seg.index).padStart(2, "0")}`);
  mkdirSync(segDir, { recursive: true });

  const segCnSrt = join(segDir, "subs_cn.srt");
  const segVnSrt = join(segDir, "subs_vn.srt");
  const voiceover = join(segDir, "voiceover.m4a");
  const composed = join(segDir, "composed.mp4");

  const startSec = seg.start_ms / 1000;
  const durSec = (seg.end_ms - seg.start_ms) / 1000;

  log.info("series", `▶ seg ${seg.index} [${startSec.toFixed(0)}s +${durSec.toFixed(0)}s] "${seg.title}"`);

  // 1. Rebase + write segment CN SRT (segment-local time starting ~0)
  const rebased = rebaseCues(seg.cues, seg.start_ms);
  writeFileSync(segCnSrt, serializeSRT(rebased));

  // 2. Translate
  if (!existsSync(segVnSrt)) {
    await translateSRT(segCnSrt, segVnSrt);
  }

  // 3. TTS
  const wantTTS = DOUYIN_CONFIG.tts?.enabled;
  if (wantTTS && !existsSync(voiceover)) {
    await generateVoiceover(segVnSrt, segDir);
  }

  // 4. Compose with trim (cut [startSec, +durSec) from original) + letterbox
  if (!existsSync(composed)) {
    await compose({
      mp4_path: original_mp4,
      vn_srt_path: segVnSrt,
      output_path: composed,
      voiceover_path: wantTTS && existsSync(voiceover) ? voiceover : null,
      trimStartSec: startSec,
      trimDurSec: durSec,
    });
  }

  log.info("series", `✅ seg ${seg.index} → ${composed}`);
  return { index: seg.index, title: seg.title, path: composed, durSec: Math.round(durSec) };
}

async function main() {
  const opts = parseArgs();
  const modal_id = opts.resume || (opts.url && extractModalId(opts.url));
  if (!modal_id) { console.error("need --url or --resume <modal_id>"); process.exit(1); }

  const dir = join(DOUYIN_CONFIG.baseDir, modal_id);
  mkdirSync(dir, { recursive: true });
  const original_mp4 = join(dir, "original.mp4");
  const subs_cn = join(dir, "subs_cn.srt");

  log.info("series", `pipeline ▶ ${modal_id}`);

  // 1. Download (if needed)
  if (!existsSync(original_mp4) || statSync(original_mp4).size < 100_000) {
    await download(modal_id);
  }

  // 2. Full ASR transcript (if needed)
  if (!existsSync(subs_cn)) {
    await extractSubs(original_mp4, dir);
  }

  // 3. Segment by content
  const segments = await splitSegments(subs_cn, { minSec: opts.min, maxSec: opts.max });
  const cur = state.get(modal_id) || {};
  state.upsert(modal_id, {
    status: "segmented",
    title_cn: cur.title_cn || "",
    segment_count: segments.length,
  });

  // 4. Process each segment independently
  const results = [];
  for (const seg of segments) {
    try {
      const r = await processSegment(modal_id, dir, seg, original_mp4, cur.title_cn || "");
      results.push(r);
    } catch (e) {
      log.error("series", `❌ seg ${seg.index} failed: ${e.message}`);
      results.push({ index: seg.index, title: seg.title, error: e.message });
    }
  }

  const ok = results.filter(r => r.path);
  state.upsert(modal_id, {
    status: ok.length === segments.length ? "series_done" : "series_partial",
    segments_done: ok.length,
  });

  log.info("series", `done: ${ok.length}/${segments.length} segments composed`);
  console.log("\n=== Segments ===");
  for (const r of results) {
    if (r.path) console.log(`  ✅ #${r.index} (${r.durSec}s) ${r.title}\n     ${r.path}`);
    else console.log(`  ❌ #${r.index} ${r.title} — ${r.error}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
