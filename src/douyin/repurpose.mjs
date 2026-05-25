#!/usr/bin/env node
/**
 * Douyin Repurpose Pipeline Orchestrator
 */
import "../env.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createState } from "./state.mjs";
import { createLogger } from "./utils/log.mjs";
import { discover } from "./discover.mjs";
import { download } from "./download.mjs";
import { extractSubs } from "./extract-subs.mjs";
import { translateSRT } from "./translate.mjs";
import { compose } from "./compose.mjs";
import { publish } from "./publish.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const state = createState(DOUYIN_CONFIG.stateFile);

const HELP = `Douyin Repurpose Pipeline

Source (one of):
  --keyword <text>         scan Douyin search results
  --creator <url>          scan creator profile
  --url <video_url>        single video (extract modal_id)
  --resume <modal_id>      rerun pipeline for existing modal_id
  --retry-failed           rerun all videos in state.json with *_failed status

Options:
  --max <n>                max videos per run (default ${DOUYIN_CONFIG.maxPerRun})
  --dry-run                discover only, no download
  --dry-run-publish        full pipeline, log caption, no post
  --skip-publish           full pipeline, no publish call
  --force-step <name>      rerun specific step despite existing artifact
                           (download|extract-subs|translate|compose|publish)
`;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    keyword: null, creator: null, url: null,
    max: DOUYIN_CONFIG.maxPerRun,
    dryRun: false, dryRunPublish: false, skipPublish: false,
    resume: null, forceStep: null, retryFailed: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--keyword") out.keyword = args[++i];
    else if (a === "--creator") out.creator = args[++i];
    else if (a === "--url") out.url = args[++i];
    else if (a === "--max") out.max = parseInt(args[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--dry-run-publish") out.dryRunPublish = true;
    else if (a === "--skip-publish") out.skipPublish = true;
    else if (a === "--resume") out.resume = args[++i];
    else if (a === "--force-step") out.forceStep = args[++i];
    else if (a === "--retry-failed") out.retryFailed = true;
    else if (a === "--help" || a === "-h") { console.log(HELP); process.exit(0); }
    else console.warn(`unknown arg: ${a}`);
  }
  return out;
}

function extractModalIdFromUrl(url) {
  const m = url.match(/[/?&]modal_id=(\d+)/) || url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function artifactPaths(modal_id) {
  const dir = join(DOUYIN_CONFIG.baseDir, modal_id);
  return {
    dir,
    original_mp4: join(dir, "original.mp4"),
    info_json:    join(dir, "original.info.json"),
    subs_cn:      join(dir, "subs_cn.srt"),
    subs_vn:      join(dir, "subs_vn.srt"),
    composed:     join(dir, "composed.mp4"),
  };
}

async function runPipelineFor(modal_id, { skipPublish, dryRunPublish, forceStep }, meta = {}) {
  const a = artifactPaths(modal_id);
  log.info("orchestrator", `pipeline ▶ ${modal_id} (${meta.title_cn || ""})`);

  try {
    const needDownload = forceStep === "download" ||
      !existsSync(a.original_mp4) ||
      statSync(a.original_mp4).size < 100_000;
    if (needDownload) {
      const dl = await download(modal_id);
      state.upsert(modal_id, {
        status: "downloaded",
        title_cn: meta.title_cn || dl.original_title,
        duration_sec: dl.duration_sec,
      });
    }

    if (forceStep === "extract-subs" || !existsSync(a.subs_cn)) {
      const r = await extractSubs(a.original_mp4, a.dir);
      state.upsert(modal_id, {
        status: "subs_extracted",
        subs_source: r.source,
        cue_count: r.cue_count,
        avg_confidence: r.avg_confidence,
      });
    }

    if (forceStep === "translate" || !existsSync(a.subs_vn)) {
      const r = await translateSRT(a.subs_cn, a.subs_vn);
      state.upsert(modal_id, {
        status: "translated",
        char_ratio: r.char_ratio,
      });
    }

    if (forceStep === "compose" || !existsSync(a.composed)) {
      await compose({ mp4_path: a.original_mp4, vn_srt_path: a.subs_vn, output_path: a.composed });
      state.upsert(modal_id, { status: "composed" });
    }

    if (!skipPublish) {
      const cur = state.get(modal_id);
      const results = await publish({
        composed_mp4: a.composed,
        modal_id,
        original_title_cn: cur?.title_cn || modal_id,
        vn_srt_path: a.subs_vn,
        dryRun: dryRunPublish,
      });
      const posted = results.filter(r => r.status === "ok").map(r => r.channel);
      const failed = results.filter(r => r.status === "fail").map(r => r.channel);
      state.upsert(modal_id, {
        status: failed.length === 0 ? "published" : "publish_failed",
        channels_posted: posted,
        channels_failed: failed,
      });
    } else {
      log.info("orchestrator", `skip-publish — stop at composed`);
    }

    log.info("orchestrator", `✅ ${modal_id} done`);
  } catch (e) {
    const failureStep =
      !existsSync(a.original_mp4) ? "download_failed" :
      !existsSync(a.subs_cn) ? "subs_failed" :
      !existsSync(a.subs_vn) ? "translate_failed" :
      !existsSync(a.composed) ? "compose_failed" :
      "publish_failed";
    state.upsert(modal_id, { status: failureStep, last_error: e.message });
    log.error("orchestrator", `❌ ${modal_id} ${failureStep}: ${e.message}`);
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.retryFailed) {
    const failed = state.list({ status: /_failed$/ });
    log.info("orchestrator", `retry-failed — ${failed.length} videos`);
    for (const v of failed) {
      await runPipelineFor(v.modal_id, opts, { title_cn: v.title_cn });
    }
    return;
  }

  if (opts.resume) {
    await runPipelineFor(opts.resume, opts);
    return;
  }

  if (opts.url) {
    const id = extractModalIdFromUrl(opts.url);
    if (!id) { console.error("could not extract modal_id from url"); process.exit(1); }
    await runPipelineFor(id, opts);
    return;
  }

  if (!opts.keyword && !opts.creator) {
    if (!DOUYIN_CONFIG.keywords.length) {
      console.error("no keyword/creator provided and config has none");
      process.exit(1);
    }
    opts.keyword = DOUYIN_CONFIG.keywords[0];
  }

  const candidates = await discover({
    keyword: opts.keyword,
    creator: opts.creator,
    maxResults: opts.max,
  });

  if (opts.dryRun) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }

  for (const c of candidates) {
    const existing = state.get(c.modal_id);
    if (existing && !/_failed$/.test(existing.status) && existing.status !== "discovered") {
      log.info("orchestrator", `skip ${c.modal_id} (status=${existing.status})`);
      continue;
    }
    state.upsert(c.modal_id, { status: "discovered", title_cn: c.title, view_count: c.view_count });
    await runPipelineFor(c.modal_id, opts, { title_cn: c.title });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
