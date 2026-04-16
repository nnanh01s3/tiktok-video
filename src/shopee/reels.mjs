/**
 * Reels Pipeline — per-page Reels worker.
 *
 * Flow:
 *   1. Load config for the page's niche (reels-config.mjs)
 *   2. Pick source for today (rotation by day-of-year)
 *   3. Scrape latest video from source:
 *        - TikTok: yt-dlp with --flat-playlist for URL list
 *        - Facebook: CDP scraper (same pattern as fb_repost.mjs)
 *   4. Skip if already processed (per-page processed.json)
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
const PROCESSED_FILE = join(OUT_DIR, "processed.json");
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

function loadProcessed() {
  try { return JSON.parse(readFileSync(PROCESSED_FILE, "utf8")); }
  catch { return { processed_ids: [], last_check: null }; }
}

function saveProcessed(data) {
  writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function run(cmd, timeout = 60000) {
  return spawnSync(cmd, { encoding: "utf8", timeout, shell: true });
}

// ── Step 1: Scrape latest video IDs from source ──────────────────────────
/**
 * For TikTok profile URLs, use yt-dlp's --flat-playlist to get video URLs
 * without downloading. Fast, no auth required.
 */
async function scrapeTikTok(profileUrl) {
  log(`🔍 Scrape TikTok: ${profileUrl}`);
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
  for (const line of result.stdout.trim().split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.id && j.url) {
        videos.push({
          id: String(j.id),
          url: j.url,
          title: j.title || "",
          duration: j.duration || 0,
        });
      }
    } catch {}
  }
  log(`   Found ${videos.length} videos`);
  return videos;
}

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
  const result = run(
    `"${YTDLP}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
    `--merge-output-format mp4 --max-filesize 200m --no-warnings ` +
    `-o "${outPath}" "${video.url}"`,
    180000
  );
  if (existsSync(outPath) && statSync(outPath).size > 100000) {
    log(`   ✅ ${Math.round(statSync(outPath).size / 1024 / 1024 * 10) / 10}MB`);
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
  return postId;
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

const state = loadProcessed();
log(`📋 Đã xử lý: ${state.processed_ids.length} videos`);

// Scrape + fallback through all sources if primary has no new videos
const newVideos = [];
const triedSources = [];
for (let step = 0; step < SOURCES.length; step++) {
  if (newVideos.length >= MAX) break;
  const idx = (sourceIdx + step) % SOURCES.length;
  const src = SOURCES[idx];
  triedSources.push(idx);

  const videos = src.platform === "tiktok"
    ? await scrapeTikTok(src.url)
    : await scrapeFacebook(src.url);

  for (const v of videos) {
    if (!state.processed_ids.includes(v.id)) {
      v._sourceIdx = idx;
      v._sourceName = src.name;
      newVideos.push(v);
      if (newVideos.length >= MAX) break;
    }
  }
  if (newVideos.length > 0) log(`   ➕ [${idx}] +${videos.filter(v => !state.processed_ids.includes(v.id)).length} new`);
}

if (newVideos.length === 0) {
  log(`✅ Không có video mới từ ${triedSources.length} sources thử được.`);
  state.last_check = new Date().toISOString();
  saveProcessed(state);
  process.exit(0);
}

const toProcess = newVideos.slice(0, MAX);
log(`📌 Xử lý ${toProcess.length} video(s)\n`);

let success = 0;
for (let i = 0; i < toProcess.length; i++) {
  const video = toProcess[i];
  log(`\n[${i + 1}/${toProcess.length}] ${video._sourceName} — ${video.id}`);
  try {
    const raw = downloadVideo(video);
    if (!raw) {
      log("   ⏭️ Skip (download failed)");
      state.processed_ids.push(video.id);
      continue;
    }

    const processed = join(OUT_DIR, `${video.id}_reel.mp4`);
    const ok = processVideo(raw, processed);
    if (!ok) {
      log("   ⏭️ Skip (FFmpeg failed)");
      state.processed_ids.push(video.id);
      try { unlinkSync(raw); } catch {}
      continue;
    }

    const caption = makeCaption(video.title, PAGE_ARG);
    log(`   📝 "${caption.slice(0, 80)}..."`);

    await uploadAndPost(processed, caption, DELAY + i * 2);
    state.processed_ids.push(video.id);
    // Keep last 500 ids to prevent unbounded growth
    state.processed_ids = state.processed_ids.slice(-500);
    saveProcessed(state);
    success++;

    // Cleanup
    try { unlinkSync(raw); } catch {}
    try { unlinkSync(processed); } catch {}
    if (i < toProcess.length - 1) await sleep(3000);
  } catch (e) {
    log(`   ❌ Error: ${e.message?.slice(0, 150)}`);
    state.processed_ids.push(video.id);
  }
}

state.last_check = new Date().toISOString();
saveProcessed(state);
log("\n" + "=".repeat(60));
log(`✅ Xong! Posted ${success}/${toProcess.length} Reels`);
