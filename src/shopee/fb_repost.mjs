/**
 * FB REPOST — Scrape video từ các FB page nguồn → repost lên Sưu Tầm Hàng Dị
 *
 * Usage:
 *   node src/shopee/fb_repost.mjs                # Auto chọn page (xoay vòng)
 *   node src/shopee/fb_repost.mjs --source 0     # Chọn page theo index
 *   node src/shopee/fb_repost.mjs --max 5        # Tối đa 5 video
 *   node src/shopee/fb_repost.mjs --list          # Liệt kê source pages
 *
 * Flow:
 *  1. Chrome headless CDP → scrape video IDs từ FB page
 *  2. yt-dlp → download video
 *  3. Claude Haiku → viết caption giải trí (không quảng cáo)
 *  4. social-poster → upload + schedule lên FB (PostFast or PostForMe)
 */

import "../env.js";
import { spawnSync, spawn } from "child_process";
import {
  writeFileSync, readFileSync, mkdirSync,
  existsSync, statSync, unlinkSync,
} from "fs";
import { join } from "path";
import { BASE_DIR } from "./config.mjs";

// ── Source Pages ──────────────────────────────────────────────────────────
const SOURCE_PAGES = [
  "https://www.facebook.com/dathangtrungquoc01",
  "https://www.facebook.com/profile.php?id=61552371315310",
  "https://www.facebook.com/profile.php?id=61576726414275",
  "https://www.facebook.com/suutamdohay",
  "https://www.facebook.com/dosinhton01",
];

// Page đích
const FB_PAGE_ID = "f195f36e-ebec-4589-a05c-ac5ddfd15b24"; // Sưu Tầm Hàng Dị

// Nếu source page nằm trong list này → cũng post TikTok
const ALSO_POST_TIKTOK = [
  "https://www.facebook.com/profile.php?id=61552371315310",
];

// ── Paths (Windows local) ─────────────────────────────────────────────────
const YTDLP = "yt-dlp";
const CHROME = process.env.CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT_DIR = join(BASE_DIR, "fb-repost");
const PROCESSED_FILE = join(OUT_DIR, "processed.json");
const LOG_FILE = join(OUT_DIR, "repost.log");
const MAX_VIDEOS_DEFAULT = 3;

mkdirSync(OUT_DIR, { recursive: true });

// PostFast headers removed — fb_repost now uses social-poster.js (PostForMe)

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes("--list")) {
  console.log("Source pages:");
  SOURCE_PAGES.forEach((p, i) => console.log(`  ${i}: ${p}`));
  process.exit(0);
}

const sourceIdx = args.includes("--source")
  ? parseInt(args[args.indexOf("--source") + 1])
  : Math.floor(Date.now() / (4 * 60 * 60 * 1000)) % SOURCE_PAGES.length;

const MAX_VIDEOS = args.includes("--max")
  ? parseInt(args[args.indexOf("--max") + 1])
  : MAX_VIDEOS_DEFAULT;

const BASE_DELAY = args.includes("--delay")
  ? parseInt(args[args.indexOf("--delay") + 1]) || 0
  : 0;

const SOURCE_PAGE = SOURCE_PAGES[sourceIdx] || SOURCE_PAGES[0];

// ── Helpers ───────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}] ${msg}`;
  console.log(line);
  try {
    const prev = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    writeFileSync(LOG_FILE, (prev + line + "\n").slice(-50000));
  } catch {}
}

function loadProcessed() {
  try { return JSON.parse(readFileSync(PROCESSED_FILE, "utf8")); }
  catch { return { processed_ids: [], last_check: null }; }
}

function saveProcessed(data) {
  writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function run(cmd, timeout = 60000) {
  return spawnSync(cmd, { encoding: "utf8", timeout, shell: true });
}

// ── CDP Helper (Chrome headless) ──────────────────────────────────────────
async function withChrome(url, fn) {
  const CDP_PORT = 9230 + Math.floor(Math.random() * 100);
  const profileDir = join(OUT_DIR, `chrome_tmp_${Date.now()}`);
  mkdirSync(profileDir, { recursive: true });

  // Start Chrome in background
  const chromeProc = spawn(
    `"${CHROME}"`,
    [
      "--headless=new", "--disable-gpu",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--window-size=1280,900",
      url,
    ],
    { shell: true, detached: true, stdio: "ignore" }
  );
  chromeProc.unref();

  await sleep(5000); // chờ Chrome khởi động

  try {
    // Fetch CDP tab info
    const tabsRes = await fetch(`http://localhost:${CDP_PORT}/json`, {
      signal: AbortSignal.timeout(10000),
    });
    const tabs = await tabsRes.json();
    const tab = tabs.find(t => t.type === "page") || tabs[0];
    if (!tab?.webSocketDebuggerUrl) throw new Error("No CDP tab found");

    const { default: WS } = await import("ws");
    const ws = new WS(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });

    const cdp = (method, params = {}) => new Promise((res, rej) => {
      const id = Math.floor(Math.random() * 1e8);
      const handler = d => {
        const m = JSON.parse(d.toString());
        if (m.id === id) { ws.off("message", handler); res(m.result); }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { ws.off("message", handler); rej(new Error("CDP timeout: " + method)); }, 15000);
    });

    await cdp("Page.enable");
    await cdp("Network.enable");
    await sleep(6000); // chờ page load

    const result = await fn(cdp, ws);
    ws.close();
    return result;
  } finally {
    // Kill Chrome process
    try { chromeProc.kill(); } catch {}
    run(`taskkill /F /PID ${chromeProc.pid} 2>nul`, 5000);
    // Cleanup temp profile
    await sleep(1000);
    try { run(`rmdir /s /q "${profileDir}" 2>nul`, 5000); } catch {}
  }
}

// ── Step 1: Scrape video IDs ──────────────────────────────────────────────
//
// Takes `sourcePageUrl` as parameter so the main flow can call it with
// different sources in fallback order (instead of relying on the const
// SOURCE_PAGE). This enables trying multiple sources when the first one
// has no new videos — e.g. afternoon daily hits the same source as morning
// daily because rotation is 4-hourly.
async function getNewVideos(processedIds, sourcePageUrl) {
  log(`🔍 Scrape: ${sourcePageUrl}`);
  const videos = [];

  try {
    const result = await withChrome(sourcePageUrl, async (cdp) => {
      await sleep(5000);

      // Scroll để load thêm bài
      for (let i = 0; i < 5; i++) {
        await cdp("Runtime.evaluate", {
          expression: "window.scrollTo(0, document.body.scrollHeight)",
        });
        await sleep(1500);
      }
      await sleep(1000);

      // Lấy video links từ page
      const evalResult = await cdp("Runtime.evaluate", {
        expression: `
          (() => {
            const links = [...document.querySelectorAll('a[href*="/videos/"], a[href*="watch"], a[href*="reel"]')];
            const videoData = [];
            const seen = new Set();

            links.forEach(a => {
              const href = a.href;
              const match = href.match(/videos\\/([0-9]+)/) ||
                            href.match(/[?&]v=([0-9]+)/) ||
                            href.match(/reel\\/([0-9]+)/);
              if (match && !seen.has(match[1])) {
                seen.add(match[1]);
                const container = a.closest('[role="article"]') || a.parentElement?.parentElement;
                const text = container?.innerText?.slice(0, 200) || a.innerText || "";
                videoData.push({
                  id: match[1],
                  url: href,
                  text: text.trim()
                });
              }
            });
            return JSON.stringify(videoData.slice(0, 30));
          })()
        `,
      });

      return evalResult?.result?.value;
    });

    if (result) {
      const parsed = JSON.parse(result);
      log(`   Tìm thấy ${parsed.length} video trên trang`);

      for (const v of parsed) {
        if (!processedIds.includes(v.id)) {
          videos.push({
            id: v.id,
            url: `https://www.facebook.com/watch/?v=${v.id}`,
            title: v.text.split("\n")[0] || "",
            description: v.text,
          });
        }
      }
    }
  } catch (e) {
    log(`⚠️ Scrape error: ${e.message}`);
  }

  log(`   ${videos.length} video mới chưa xử lý`);
  return videos;
}

// ── Step 2: Download video via yt-dlp ─────────────────────────────────────
async function downloadVideo(video) {
  log(`📥 Download: ${video.url}`);
  const outPath = join(OUT_DIR, `${video.id}.mp4`);

  if (existsSync(outPath) && statSync(outPath).size > 100000) {
    log("   Cached ✅");
    return outPath;
  }

  const result = run(
    `"${YTDLP}" ` +
    `-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
    `--merge-output-format mp4 ` +
    `--max-filesize 200m ` +
    `--no-warnings ` +
    `-o "${outPath}" ` +
    `"${video.url}"`,
    120000
  );

  if (existsSync(outPath) && statSync(outPath).size > 100000) {
    log(`   ✅ ${Math.round(statSync(outPath).size / 1024 / 1024 * 10) / 10}MB`);
    return outPath;
  }

  log(`   ❌ Failed: ${(result.stdout || result.stderr || "").slice(-150)}`);
  return null;
}

// ── Step 3: Caption ───────────────────────────────────────────────────────
function makeCaption(title, desc) {
  const hooks = [
    "Cái này có thật không vậy?!",
    "Thứ này ở đâu ra?!",
    "Dừng lại xem cái này đã!",
    "Hiếm có khó tìm luôn nha!",
    "Ai biết cái này là gì không?!",
    "Xem xong mà ngỡ ngàng!",
    "Lần đầu thấy thứ này luôn!",
    "Có ai từng dùng cái này chưa?!",
  ];
  const hook = hooks[Math.floor(Math.random() * hooks.length)];
  const content = (title || desc || "").slice(0, 80);
  return `${hook}\n\n"${content}"\n\nBạn nghĩ sao? Comment bên dưới nhé!\n\n#suutamhangdi #hangdi #kyla #docla #viral #fyp #trending`;
}

// ── Step 4: Upload & Post via social-poster ──────────────────────────────
import { createPoster } from "../social-poster.js";
import { PAGES } from "./config.mjs";
const fbRepostPoster = createPoster(PAGES.shopee); // fb_repost posts to "Sưu Tầm Hàng Dị"

async function uploadAndPost(videoPath, caption, delayMinutes = 1) {
  const mediaRef = await fbRepostPoster.upload(videoPath);
  log(`   ✅ Uploaded: ${mediaRef.slice(0, 60)}`);

  const scheduledAt = new Date(Date.now() + delayMinutes * 60_000)
    .toISOString().replace(/\.\d{3}Z$/, ".000Z");

  const result = await fbRepostPoster.scheduleFacebook({ mediaRef, caption, scheduledAt });
  const postId = result.postId || result.postIds?.[0];
  log(`   ✅ FB Scheduled: ${scheduledAt} | PostID: ${postId}`);

  return postId;
}

// ── Main ──────────────────────────────────────────────────────────────────
log("=".repeat(60));
log(`🚀 FB REPOST → SƯU TẦM HÀNG DỊ`);
log(`📌 Primary source: [${sourceIdx}] ${SOURCE_PAGE}`);
log("=".repeat(60));

const state = loadProcessed();
log(`📋 Đã xử lý: ${state.processed_ids.length} videos`);

// Fallback source loop: try the rotation-picked source first, then fall
// through to subsequent sources (circularly) until we have enough new videos
// or we've tried them all.
//
// Why: rotation is 4-hourly (`Date.now() / 4h % 5`) so morning + afternoon
// runs within the same window hit the SAME source. If morning already
// reposted everything new from that source, afternoon gets 0. Falling
// through keeps content flowing while preserving rotation's goal of
// distributing load across 5 sources over time.
const newVideos = [];
const triedSources = [];
for (let step = 0; step < SOURCE_PAGES.length; step++) {
  if (newVideos.length >= MAX_VIDEOS) break;

  const idx = (sourceIdx + step) % SOURCE_PAGES.length;
  const sourcePage = SOURCE_PAGES[idx];
  triedSources.push(idx);

  const found = await getNewVideos(state.processed_ids, sourcePage);
  if (found.length > 0) {
    log(`   ➕ [${idx}] +${found.length} new videos`);
    // Attach source index to each video so downstream can log correctly
    for (const v of found) v._sourceIdx = idx;
    newVideos.push(...found);
  }
}

if (newVideos.length === 0) {
  log(`✅ Không có video mới từ ${triedSources.length} sources thử được.`);
  state.last_check = new Date().toISOString();
  saveProcessed(state);
  process.exit(0);
}

const toProcess = newVideos.slice(0, MAX_VIDEOS);
log(`📌 Xử lý ${toProcess.length} video mới (từ ${triedSources.length} sources thử được)...`);

let success = 0;
for (let i = 0; i < toProcess.length; i++) {
  const video = toProcess[i];
  log(`\n[${i + 1}/${toProcess.length}] Video ID: ${video.id}`);

  try {
    const videoPath = await downloadVideo(video);
    if (!videoPath) {
      log("   ⏭️ Skip (download failed)");
      state.processed_ids.push(video.id);
      continue;
    }

    const caption = makeCaption(video.title, video.description);
    log(`   📝 Caption: "${caption.slice(0, 60)}..."`);

    // Check if THIS video's source is in the "also post TikTok" allowlist.
    // (Previously used the global SOURCE_PAGE const; with fallback sources
    // across multiple pages, we need the per-video source URL.)
    const videoSourceUrl = SOURCE_PAGES[video._sourceIdx ?? sourceIdx];
    const isSpecialPage = ALSO_POST_TIKTOK.some(
      p => videoSourceUrl.includes(p.split("?")[0]) || videoSourceUrl === p
    );
    await uploadAndPost(videoPath, caption, BASE_DELAY + 1 + i * 5, false);

    state.processed_ids.push(video.id);
    saveProcessed(state);
    success++;

    // Cleanup downloaded file
    try { unlinkSync(videoPath); } catch {}

    if (i < toProcess.length - 1) await sleep(5000);
  } catch (e) {
    log(`   ❌ Error: ${e.message}`);
    state.processed_ids.push(video.id);
  }
}

state.last_check = new Date().toISOString();
saveProcessed(state);
log("\n" + "=".repeat(60));
log(`✅ Xong! Posted ${success}/${toProcess.length} videos`);
