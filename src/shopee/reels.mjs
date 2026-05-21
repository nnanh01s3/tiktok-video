/**
 * Reels Pipeline — per-page Reels worker.
 *
 * Flow:
 *   1. Load config for the page's niche (reels-config.mjs)
 *   2. Pick source for today (rotation by day-of-year)
 *   3. Scrape latest video from source:
 *        - TikTok: yt-dlp with --flat-playlist for URL list
 *        - Facebook: CDP scraper (same pattern as fb_repost.mjs)
 *   4. Skip if already in SQLite posted_reels (global, cross-page blocklist)
 *      + classifier reject (Gemini Flash — title vs PAGES[page].topic)
 *   5. Download via yt-dlp
 *   6. FFmpeg: crop 9:16 (center), trim to ≤60s, remove TikTok watermark
 *      by cropping ~8% off the right side (where TT watermark sits)
 *   7. Upload → PostForMe scheduleFacebook (Reels auto-detected by FB for
 *      9:16 vertical videos ≤90s)
 *
 * Usage:
 *   node src/shopee/reels.mjs --page <niche> --delay <minutes>
 *
 * Flags:
 *   --page <niche>    shopee | gia_dung | tech | sac_dep | thoi_trang | me_be | the_thao | bach_hoa
 *   --delay <min>     Schedule delay from now (default 1)
 *   --max <n>         Max new videos per run (default 1, config says MAX_PER_RUN=1)
 *   --source-idx <i>  Force specific source index (skip rotation)
 */
import "../env.js";
import {
  writeFileSync, readFileSync, mkdirSync, existsSync, statSync, unlinkSync,
} from "fs";
import { spawn, spawnSync, execSync } from "child_process";
import { join } from "path";
import { createPoster } from "../social-poster.js";
import { PAGES, BASE_DIR, FFMPEG } from "./config.mjs";
import { REELS_SOURCES, pickSource } from "./reels-config.mjs";
import { isVideoPosted, recordPostedVideo, getRecentSourceNames } from "../db.js";
import { classifyRelevance } from "./reels-classifier.mjs";
import { genReelsCaption } from "./reels-caption.mjs";

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const PAGE_ARG = arg("--page");
const DELAY = parseInt(arg("--delay", "1"), 10);
const MAX = parseInt(arg("--max", "1"), 10);
const FORCED_SOURCE_IDX = arg("--source-idx") !== null ? parseInt(arg("--source-idx"), 10) : null;

if (!PAGE_ARG || !PAGES[PAGE_ARG]) {
  console.error("Usage: node src/shopee/reels.mjs --page <niche>");
  console.error("Valid pages:", Object.keys(PAGES).filter((k) => REELS_SOURCES[k]).join(", "));
  process.exit(1);
}

const PAGE = PAGES[PAGE_ARG];
const SOURCES = REELS_SOURCES[PAGE_ARG] || [];
if (SOURCES.length === 0) {
  console.error(`No Reels sources configured for niche: ${PAGE_ARG}`);
  process.exit(1);
}

// ── Paths ─────────────────────────────────────────────────────────────────
const YTDLP = "yt-dlp";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT_DIR = join(BASE_DIR, "reels", PAGE_ARG);
const LOG_FILE = join(OUT_DIR, "reels.log");
mkdirSync(OUT_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}] ${msg}`;
  console.log(line);
  try {
    const prev = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    writeFileSync(LOG_FILE, (prev + line + "\n").slice(-50_000));
  } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function run(cmd, timeout = 60000) {
  return spawnSync(cmd, { encoding: "utf8", timeout, shell: true });
}

// ── Step 1: Scrape latest video IDs from source ──────────────────────────
/**
 * Generic yt-dlp scraper for TikTok + YouTube profile URLs.
 * yt-dlp's --flat-playlist returns video metadata without downloading,
 * identical schema across both platforms. Fast, no auth required.
 *
 * URL patterns:
 *   TikTok:  https://www.tiktok.com/@handle
 *   YouTube: https://www.youtube.com/@handle/shorts   (Shorts only, 9:16 ready)
 *            https://www.youtube.com/@handle/videos   (regular videos — will need crop)
 */
async function scrapeYtdlp(profileUrl, platformLabel = "TikTok") {
  log(`🔍 Scrape ${platformLabel}: ${profileUrl}`);
  // --playlist-end 5 = only check 5 most recent videos (fast)
  const result = run(
    `"${YTDLP}" --flat-playlist --playlist-end 5 --no-warnings -j "${profileUrl}"`,
    60000
  );
  if (!result.stdout) {
    log(`   ❌ ${result.stderr?.slice(-200)}`);
    return [];
  }
  const videos = [];
  let skippedShort = 0;
  for (const line of result.stdout.trim().split("\n")) {
    try {
      const j = JSON.parse(line);
      if (!j.id || !j.url) continue;
      // Skip videos shorter than 10s — FB Reels can't play them after
      // FFmpeg re-encode (output <1MB → "lỗi khi phát video này")
      if (j.duration && j.duration < 10) { skippedShort++; continue; }
      videos.push({
        id: String(j.id),
        url: j.url,
        title: j.title || "",
        duration: j.duration || 0,
      });
    } catch {}
  }
  if (skippedShort) log(`   Skipped ${skippedShort} videos < 10s`);
  log(`   Found ${videos.length} videos`);
  return videos;
}

// Backward-compat alias — existing callers still work
const scrapeTikTok = (url) => scrapeYtdlp(url, "TikTok");

/**
 * For Facebook pages, reuse CDP scraper pattern from fb_repost.mjs.
 * Launches Chrome, scrolls, extracts video links via DOM selector.
 */
async function scrapeFacebook(pageUrl) {
  log(`🔍 Scrape Facebook: ${pageUrl}`);
  const CDP_PORT = 9400 + Math.floor(Math.random() * 100);
  const profileDir = join(OUT_DIR, `chrome_tmp_${Date.now()}`);
  mkdirSync(profileDir, { recursive: true });

  const chromeProc = spawn(
    `"${CHROME}"`,
    [
      "--disable-gpu", "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--window-size=800,600",
      "--window-position=9999,9999",
      pageUrl,
    ],
    { shell: true, detached: true, stdio: "ignore" }
  );
  chromeProc.unref();

  try {
    // Wait + connect
    let ws, cdp;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      try {
        const r = await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(2000) });
        const tabs = await r.json();
        const tab = tabs.find((t) => t.type === "page") || tabs[0];
        if (!tab?.webSocketDebuggerUrl) continue;
        const { default: WS } = await import("ws");
        ws = new WS(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
        cdp = (method, params = {}) => new Promise((res, rej) => {
          const id = Math.floor(Math.random() * 1e8);
          const h = (d) => { const m = JSON.parse(d.toString()); if (m.id === id) { ws.off("message", h); res(m.result); } };
          ws.on("message", h);
          ws.send(JSON.stringify({ id, method, params }));
          setTimeout(() => { ws.off("message", h); rej(new Error("CDP timeout")); }, 15000);
        });
        break;
      } catch {}
    }
    if (!cdp) { log("   ❌ Chrome startup failed"); return []; }

    await sleep(5000);
    // Scroll to load more content
    for (let i = 0; i < 3; i++) {
      await cdp("Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
      await sleep(1500);
    }
    await sleep(1000);

    const evalResult = await cdp("Runtime.evaluate", {
      expression: `
        (() => {
          const links = [...document.querySelectorAll('a[href*="/videos/"], a[href*="/reel/"], a[href*="watch"]')];
          const seen = new Set();
          const videos = [];
          for (const a of links) {
            const m = a.href.match(/videos\\/([0-9]+)/) || a.href.match(/reel\\/([0-9]+)/) || a.href.match(/[?&]v=([0-9]+)/);
            if (m && !seen.has(m[1])) {
              seen.add(m[1]);
              const container = a.closest('[role="article"]') || a.parentElement?.parentElement;
              const text = container?.innerText?.slice(0, 200) || a.innerText || "";
              videos.push({ id: m[1], url: \`https://www.facebook.com/watch/?v=\${m[1]}\`, title: text.trim().split("\\n")[0] || "" });
            }
          }
          return JSON.stringify(videos.slice(0, 5));
        })()
      `,
    });
    ws.close();
    const videos = JSON.parse(evalResult?.result?.value || "[]");
    log(`   Found ${videos.length} videos`);
    return videos;
  } finally {
    try { chromeProc.kill(); } catch {}
    run(`taskkill /F /PID ${chromeProc.pid} 2>nul`, 5000);
    await sleep(500);
    try { run(`rmdir /s /q "${profileDir}" 2>nul`, 5000); } catch {}
  }
}

// ── Step 2: Download via yt-dlp ──────────────────────────────────────────
function downloadVideo(video) {
  log(`📥 Download: ${video.url}`);
  const outPath = join(OUT_DIR, `${video.id}.mp4`);
  if (existsSync(outPath) && statSync(outPath).size > 100000) {
    log("   Cached ✅");
    return outPath;
  }
  // yt-dlp own timeouts: --socket-timeout aborts stalled reads (Windows
  // spawnSync timeout doesn't reliably kill child via cmd /c shell wrapper).
  // --retries / --fragment-retries cap re-attempts so total ≤ ~90s.
  const result = run(
    `"${YTDLP}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
    `--merge-output-format mp4 --max-filesize 200m --no-warnings ` +
    `--socket-timeout 30 --retries 2 --fragment-retries 2 ` +
    `-o "${outPath}" "${video.url}"`,
    180000
  );
  if (existsSync(outPath) && statSync(outPath).size > 100000) {
    const sizeMB = statSync(outPath).size / 1024 / 1024;
    // Videos < 2.0MB have too-low bitrate for FB Reels to play stably:
    // at 60s duration, 2MB ≈ 273 kbps (FB minimum for vertical 9:16 playback).
    // Below this, player shows "Rất tiếc, đã xảy ra lỗi khi phát video này".
    // Empirical: 0.6MB and 0.8MB videos confirmed failing 2026-04-19.
    if (sizeMB < 2.0) {
      log(`   ⏭️ Too small (${sizeMB.toFixed(1)}MB) — bitrate too low, FB would fail playback`);
      try { unlinkSync(outPath); } catch {}
      return null;
    }
    log(`   ✅ ${Math.round(sizeMB * 10) / 10}MB`);
    return outPath;
  }
  log(`   ❌ ${(result.stdout || result.stderr || "").slice(-200)}`);
  return null;
}

// ── Step 3: FFmpeg process — 9:16 + watermark removal + trim ─────────────
/**
 * Transform downloaded video for Reels posting:
 *   - Crop to 9:16 vertical (if source is different ratio)
 *   - Crop ~5% off each edge to remove TikTok watermark + username overlay
 *     (TT watermark at top-left or bottom-right, usernames at bottom)
 *   - Trim to ≤60s (Reels sweet spot for algorithm)
 *   - Re-encode at 1080x1920 for FB Reels
 */
function processVideo(inputPath, outputPath) {
  log(`🎬 FFmpeg: 9:16 + crop watermark + trim`);
  // Strategy: "crop" filter removes top/bottom bars from potentially 16:9
  // sources, then "scale + crop" to hit 1080x1920 while cropping edges
  // where TikTok watermarks typically sit (top-left TT logo, bottom-right user@).
  //
  // Simple approach: scale to 1080 wide keeping aspect, then center-crop
  // to 1080x1920. Edge crop of ~8% each side removes most watermarks.
  const filter = [
    // Scale so shorter side = 1080 (or larger), preserve aspect
    "scale=1080:1920:force_original_aspect_ratio=increase",
    // Crop center to exactly 1080x1920 (removes letterbox + edges)
    "crop=1080:1920:(iw-1080)/2:(ih-1920)/2",
    // Additional crop to remove potential watermarks at edges (5% each edge)
    "crop=iw*0.92:ih*0.96:iw*0.04:ih*0.02",
    // Re-scale back to 1080x1920 after edge crop
    "scale=1080:1920",
    "fps=30",
  ].join(",");

  const cmd =
    `"${FFMPEG}" -y -i "${inputPath}" -t 60 -vf "${filter}" ` +
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p ` +
    `-c:a aac -b:a 128k -ar 44100 ` +
    `-movflags +faststart "${outputPath}"`;

  try {
    execSync(cmd, { timeout: 180000, stdio: "pipe" });
    if (existsSync(outputPath) && statSync(outputPath).size > 100000) {
      const sizeMB = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
      log(`   ✅ Processed: ${sizeMB}MB`);
      return outputPath;
    }
  } catch (e) {
    log(`   ❌ FFmpeg failed: ${e.message?.slice(0, 150)}`);
  }
  return null;
}

// ── Step 4: Caption ──────────────────────────────────────────────────────
function makeCaption(sourceTitle, nicheName) {
  // Short, engagement-focused caption. No affiliate links — pure Reels
  // for audience building per user strategy ("build audience first").
  const hooks = [
    "Xem xong là ghiền luôn!",
    "Ai cũng nên biết mẹo này!",
    "Bật mí ngay!",
    "Quá đỉnh!",
    "Không xem là tiếc lắm!",
    "Hóng từng ngày!",
    "Lần đầu thấy luôn!",
    "Đỉnh của đỉnh!",
  ];
  const hook = hooks[Math.floor(Math.random() * hooks.length)];
  const content = (sourceTitle || "").slice(0, 100);
  const nicheTags = {
    shopee: "#docla #hangdi #viral",
    gia_dung: "#giadungthongminh #mevatvat #viral",
    tech: "#reviewcongnghe #tech #viral",
    sac_dep: "#skincare #mypham #beauty #viral",
    thoi_trang: "#outfit #thoitrang #fashion #viral",
    me_be: "#mevabe #nuoicon #viral",
    the_thao: "#fitness #workout #thethao #viral",
    bach_hoa: "#meovat #lifehack #viral",
  };
  const tags = nicheTags[nicheName] || "#viral #fyp";
  return `${hook}\n\n${content}\n\n${tags} #reels #fyp #trending`;
}

// ── Step 5: Upload + schedule ─────────────────────────────────────────────
const poster = createPoster(PAGE);

async function uploadAndPost(videoPath, caption, delayMin) {
  const mediaRef = await poster.upload(videoPath);
  log(`   ✅ Uploaded: ${mediaRef.slice(0, 60)}`);
  const scheduledAt = new Date(Date.now() + delayMin * 60_000)
    .toISOString().replace(/\.\d{3}Z$/, ".000Z");
  // scheduleFacebook handles video posting. PostForMe auto-detects Reels
  // for 9:16 vertical videos ≤90s. No explicit "reel" flag needed.
  const result = await poster.scheduleFacebook({ mediaRef, caption, scheduledAt });
  const postId = result.postId || result.postIds?.[0];
  log(`   ✅ FB Scheduled: ${scheduledAt} | PostID: ${postId}`);
  return { postId, scheduledAt };
}

// ── Main ──────────────────────────────────────────────────────────────────
log("=".repeat(60));
log(`🎬 REELS REPOST → ${PAGE.name} [${PAGE_ARG}]`);

// Pick source (rotation by day-of-year, or forced via --source-idx)
const sourceIdx = FORCED_SOURCE_IDX !== null
  ? FORCED_SOURCE_IDX % SOURCES.length
  : Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000) % SOURCES.length;
const source = SOURCES[sourceIdx];
log(`📌 Source [${sourceIdx}]: ${source.name} (${source.platform}) — ${source.url}`);
log("=".repeat(60));

log(`📋 Dedup: SQLite posted_reels (global, cross-page)`);

// Topic description for this page — required for classifier.
// PAGES is already imported at the top of the file from ./config.mjs.
const topic = PAGES[PAGE_ARG]?.topic;
if (!topic) {
  log(`❌ No 'topic' defined for page '${PAGE_ARG}' in config.mjs PAGES — refusing to run`);
  process.exit(1);
}

// Scrape ALL sources for this niche (no early-stop cap). The inner candidate
// loop classifier + size filters can reject many videos, so we need broad
// coverage to guarantee each page has at least 1 on-topic candidate when
// possible. Each source returns ≤5 videos (--playlist-end 5) so worst case
// is ~50 candidates per page — still cheap (classifier calls are sequential,
// early-break on first MAX success).
const newVideos = [];
const triedSources = [];
for (let step = 0; step < SOURCES.length; step++) {
  const idx = (sourceIdx + step) % SOURCES.length;
  const src = SOURCES[idx];
  triedSources.push(idx);

  const videos = src.platform === "facebook"
    ? await scrapeFacebook(src.url)
    : await scrapeYtdlp(src.url, src.platform === "youtube" ? "YouTube" : "TikTok");

  let addedFromSource = 0;
  for (const v of videos) {
    if (!isVideoPosted(v.id)) {
      v._sourceIdx = idx;
      v._sourceName = src.name;
      newVideos.push(v);
      addedFromSource++;
    }
  }
  if (addedFromSource > 0) log(`   ➕ [${idx}] +${addedFromSource} new`);
}

if (newVideos.length === 0) {
  log(`✅ Không có video mới từ ${triedSources.length} sources thử được.`);
  process.exit(0);
}

// ── Soft rotation: deprioritize sources used in last 5 posts ──
// Does NOT reject candidates — just reorders so less-recent sources are
// evaluated by the classifier first. If fresh sources have on-topic
// content, they'll win. If only recent sources have on-topic content,
// they still get their chance after fresh ones are exhausted.
// Sort is stable (V8 since 2019) so within each group (fresh vs recent)
// the scrape order is preserved — this keeps primary-source-first
// semantics as a secondary tiebreaker.
const recentSources = getRecentSourceNames(PAGE_ARG, 5);
if (recentSources.size > 0) {
  log(`   🔄 Recent sources (last 5): ${[...recentSources].join(", ")}`);
  newVideos.sort((a, b) => {
    const aRecent = recentSources.has(a._sourceName);
    const bRecent = recentSources.has(b._sourceName);
    if (aRecent === bRecent) return 0;
    return aRecent ? 1 : -1; // fresh (false) → 0, recent (true) → 1 → back
  });
  const freshCount = newVideos.filter((v) => !recentSources.has(v._sourceName)).length;
  log(`   🔄 Reorder: ${freshCount} fresh-source candidates first, ${newVideos.length - freshCount} recent-source last`);
}

// Try all candidates, stop when we've posted MAX successfully
const toProcess = newVideos;
log(`📌 ${toProcess.length} candidates, target ${MAX} post(s)\n`);

let success = 0;
for (let i = 0; i < toProcess.length; i++) {
  if (success >= MAX) break;
  const video = toProcess[i];
  log(`\n[${success + 1}/${MAX}] ${video._sourceName} — ${video.id}`);

  // ── Topic classifier gate (pre-download, skip off-topic) ──
  let verdict;
  try {
    verdict = await classifyRelevance(
      {
        id: video.id,
        title: video.title,
        duration: video.duration,
        source_name: video._sourceName,
      },
      topic
    );
  } catch (e) {
    // classifyRelevance itself swallows errors, but belt-and-suspenders
    log(`   ⚠ Classifier threw: ${e.message?.slice(0, 100)} — allow post`);
    verdict = { match: true, score: 0.5, reason: "classifier exception" };
  }

  if (!verdict.match) {
    log(`   ⏭️ Off-topic (score=${verdict.score.toFixed(2)}): ${verdict.reason}`);
    // Do NOT record — other pages might accept this video
    continue;
  }
  log(`   ✅ Topic match (score=${verdict.score.toFixed(2)})`);

  try {
    const raw = downloadVideo(video);
    if (!raw) {
      log("   ⏭️ Skip (download failed)");
      // No record — transient failure, retry next run
      continue;
    }

    const processed = join(OUT_DIR, `${video.id}_reel.mp4`);
    const ok = processVideo(raw, processed);
    if (!ok) {
      log("   ⏭️ Skip (FFmpeg failed)");
      try { unlinkSync(raw); } catch {}
      continue;
    }

    // Post-FFmpeg size check: FFmpeg can both balloon (low-res raw →
    // high-quality encode) AND shrink (static content compresses hard)
    // the output. We must re-check output size even if raw passed the
    // initial filter. <2MB post-FFmpeg = low bitrate = FB player fails.
    const processedMB = statSync(processed).size / 1024 / 1024;
    if (processedMB < 2.0) {
      log(`   ⏭️ Post-FFmpeg too small (${processedMB.toFixed(1)}MB) — bitrate too low for FB`);
      try { unlinkSync(raw); } catch {}
      try { unlinkSync(processed); } catch {}
      continue;
    }

    // AI caption (Gemini Flash) → fallback to legacy hardcoded hooks if API fails.
    // Provides per-post variety (vs old 8-hook rotation that became repetitive).
    const aiCaption = await genReelsCaption(
      { title: video.title, source_name: video._sourceName },
      PAGE_ARG,
      PAGE.name,
      topic
    );
    const caption = aiCaption || makeCaption(video.title, PAGE_ARG);
    log(`   📝 ${aiCaption ? "[AI]" : "[fallback]"} "${caption.slice(0, 80)}..."`);

    // Use DELAY as-is. Orchestrator (evening-batch.sh) already staggers
    // cross-page; the legacy `+ i * 2` here drifted the schedule by 2min for
    // every skipped candidate, pushing posts past the target slot. MAX_PER_RUN=1
    // means we only post once per run, so per-iteration stagger is meaningless.
    const { postId, scheduledAt } = await uploadAndPost(processed, caption, DELAY);

    // ── Record ONLY on successful upload ──
    const sizeMB = Math.round((statSync(processed).size / 1024 / 1024) * 10) / 10;
    recordPostedVideo({
      video_id: video.id,
      source_url: video.url,
      source_name: video._sourceName,
      page_name: PAGE_ARG,
      niche: PAGE_ARG,
      posted_at: new Date().toISOString(),
      scheduled_at: scheduledAt,
      pfm_post_id: postId,
      topic_score: verdict.score,
      video_title: video.title,
      video_duration: video.duration,
      file_size_mb: sizeMB,
    });
    success++;

    // Cleanup
    try { unlinkSync(raw); } catch {}
    try { unlinkSync(processed); } catch {}
    if (i < toProcess.length - 1) await sleep(3000);
  } catch (e) {
    log(`   ❌ Error: ${e.message?.slice(0, 150)}`);
    // No record — transient failures should retry next run
  }
}

log("\n" + "=".repeat(60));
log(`✅ Xong! Posted ${success}/${toProcess.length} Reels`);
