/**
 * TRENDING REPOST — Quét video viral từ TikTok + Facebook → reup lên Sưu Tầm Hàng Dị
 *
 * Usage:
 *   node src/shopee/trending_repost.mjs                    # Auto (TikTok + FB)
 *   node src/shopee/trending_repost.mjs --source tiktok    # Chỉ TikTok
 *   node src/shopee/trending_repost.mjs --source facebook  # Chỉ Facebook
 *   node src/shopee/trending_repost.mjs --max 5            # Tối đa 5 video
 *   node src/shopee/trending_repost.mjs --dry-run          # Chỉ tìm, không post
 *
 * Flow:
 *  1. TikTok: Chrome CDP → search trending keywords → extract video URLs
 *  2. Facebook: Chrome CDP → FB Watch/Reels → extract video URLs
 *  3. yt-dlp → download (hỗ trợ cả 2 platform)
 *  4. AI caption (Claude Haiku) — ngắn gọn, gây tò mò
 *  5. PostFast → schedule tại khung giờ vàng
 */

import "../env.js";
import { spawnSync, spawn } from "child_process";
import {
  writeFileSync, readFileSync, mkdirSync,
  existsSync, statSync, unlinkSync,
} from "fs";
import { join } from "path";
import { genCaptionAI } from "./caption.mjs";
import {
  POSTFAST_KEY, TRENDING_CONFIG, BASE_DIR, FFMPEG, FONT,
} from "./config.mjs";

// ── Config ───────────────────────────────────────────────────────────────
const CFG = TRENDING_CONFIG;
const CHROME = process.env.CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const YTDLP = "yt-dlp";
const OUT_DIR = join(BASE_DIR, "trending-repost");
const STATE_FILE = join(OUT_DIR, "state.json");
const LOG_FILE = join(OUT_DIR, "repost.log");

// Cross-check: fb_repost processed IDs (tránh trùng)
const FB_REPOST_PROCESSED = join(BASE_DIR, "fb-repost", "processed.json");

mkdirSync(OUT_DIR, { recursive: true });

const PF_HEADERS = {
  "pf-api-key": POSTFAST_KEY,
  "Content-Type": "application/json; charset=utf-8",
};

// ── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const SOURCE = args.includes("--source")
  ? args[args.indexOf("--source") + 1]
  : "both";
const MAX_VIDEOS = args.includes("--max")
  ? parseInt(args[args.indexOf("--max") + 1])
  : CFG.maxPerRun;
const DRY_RUN = args.includes("--dry-run");
const BASE_DELAY = args.includes("--delay")
  ? parseInt(args[args.indexOf("--delay") + 1]) || 0
  : 0;

// ── Helpers ──────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try {
    const prev = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    writeFileSync(LOG_FILE, (prev + line + "\n").slice(-80_000));
  } catch {}
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function run(cmd, timeout = 90_000) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", timeout });
}

// ── State ────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch {
    return {
      processed_ids: [],   // "tiktok:xxx" hoặc "fb:xxx"
      daily_posts: {},     // { "2026-04-05": 3 }
      last_check: null,
    };
  }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function getTodayKey() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
}
function getTodayCount(state) {
  return state.daily_posts[getTodayKey()] || 0;
}
function incrementToday(state) {
  const key = getTodayKey();
  state.daily_posts[key] = (state.daily_posts[key] || 0) + 1;
  // Prune old entries > 7 days
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  for (const k of Object.keys(state.daily_posts)) {
    if (k < cutoff) delete state.daily_posts[k];
  }
}

function loadCrossProcessedIds() {
  try {
    const data = JSON.parse(readFileSync(FB_REPOST_PROCESSED, "utf8"));
    return (data.processed_ids || []).map(id => `fb:${id}`);
  } catch { return []; }
}

// ── Chrome CDP Helper ────────────────────────────────────────────────────
// Chrome profile cho TikTok (có cookies)
const CHROME_TIKTOK_PROFILE = join(BASE_DIR, "chrome_tiktok");

async function withChrome(url, fn, { headless = true, timeout = 30000, profile = null } = {}) {
  const CDP_PORT = 9300 + Math.floor(Math.random() * 100);
  const profileDir = profile || join(OUT_DIR, `chrome_tmp_${Date.now()}`);
  mkdirSync(profileDir, { recursive: true });
  const useTemp = !profile; // chỉ cleanup nếu profile tạm

  const chromeArgs = [
    headless ? "--headless=new" : "--window-position=9999,9999",
    "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,900",
    "--disable-blink-features=AutomationControlled",
    `"${url}"`,
  ];

  const chromeProc = spawn(`"${CHROME}"`, chromeArgs, {
    shell: true, detached: true, stdio: "ignore",
  });
  chromeProc.unref();

  await sleep(5000);

  try {
    const tabsRes = await fetch(`http://localhost:${CDP_PORT}/json`, {
      signal: AbortSignal.timeout(10000),
    });
    const tabs = await tabsRes.json();
    const tab = tabs.find(t => t.type === "page") || tabs[0];
    if (!tab?.webSocketDebuggerUrl) throw new Error("No CDP tab");

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
      setTimeout(() => { ws.off("message", handler); rej(new Error("CDP timeout")); }, timeout);
    });

    await cdp("Page.enable");
    await cdp("Network.enable");
    await sleep(4000);

    const result = await fn(cdp, ws);
    ws.close();
    return result;
  } finally {
    try { chromeProc.kill(); } catch {}
    run(`taskkill /F /PID ${chromeProc.pid} 2>nul`, 5000);
    await sleep(1000);
    if (useTemp) {
      try { run(`rmdir /s /q "${profileDir}" 2>nul`, 5000); } catch {}
    }
  }
}

// ── Discovery: TikTok (For You / Trending / Discover) ────────────────────
// Scrape video trending thực tế từ For You feed hoặc Discover page
// KHÔNG search theo keyword — lấy video viral tổng hợp tất cả thể loại xã hội
async function discoverTikTok(processedIds) {
  // Dùng Explore page — grid layout với nhiều video trending
  // (For You page chỉ render 1 video/lần, không scrape được)
  const source = { url: "https://www.tiktok.com/explore", name: "Explore/Trending" };

  log(`🔍 [TikTok] Scraping ${source.name} page...`);

  try {
    const result = await withChrome("about:blank", async (cdp) => {
      await cdp("Page.navigate", { url: source.url });
      await sleep(8000);

      // Scroll nhiều lần để load thêm video
      for (let i = 0; i < 5; i++) {
        await cdp("Runtime.evaluate", {
          expression: "window.scrollTo(0, document.body.scrollHeight)",
        });
        await sleep(2000);
      }

      // Extract video links + metadata từ feed
      const evalResult = await cdp("Runtime.evaluate", {
        expression: `
          JSON.stringify(
            [...document.querySelectorAll('a[href*="/video/"]')]
              .reduce((acc, a) => {
                const m = a.href.match(/\\/video\\/(\\d+)/);
                if (m && !acc.seen.has(m[1])) {
                  acc.seen.add(m[1]);
                  // Tìm container để lấy description + views
                  let desc = "", views = "";
                  let el = a.closest('[class*="item"], [class*="card"], [class*="DivItem"]')
                    || a.parentElement?.parentElement?.parentElement;
                  if (el) {
                    const text = el.innerText || "";
                    // Lấy dòng đầu làm description
                    desc = text.split("\\n").find(l => l.length > 10 && !l.match(/^\\d/))?.slice(0, 200) || "";
                    // Tìm view count (123.4K, 1.2M, etc)
                    const viewMatch = text.match(/(\\d[\\d.]*[KMB]?)\\s*(?:views|lượt xem)?/i);
                    views = viewMatch?.[0] || "";
                  }
                  acc.items.push({
                    id: m[1],
                    url: a.href.split("?")[0],
                    desc,
                    views,
                  });
                }
                return acc;
              }, { seen: new Set(), items: [] })
              .items.slice(0, 30)
          )
        `,
        returnByValue: true,
      });

      return evalResult?.result?.value;
    }, { headless: false, timeout: 30000, profile: CHROME_TIKTOK_PROFILE });

    if (!result) return [];

    const items = JSON.parse(result);
    log(`   Tìm thấy ${items.length} video từ ${source.name}`);

    // Parse view count để sort
    function parseViews(v) {
      if (!v) return 0;
      const m = v.match(/([\d.]+)\s*(M|K|B)?/i);
      if (!m) return parseInt(v.replace(/\D/g, "")) || 0;
      const num = parseFloat(m[1]);
      if (m[2]?.toUpperCase() === "M") return num * 1_000_000;
      if (m[2]?.toUpperCase() === "K") return num * 1_000;
      if (m[2]?.toUpperCase() === "B") return num * 1_000_000_000;
      return num;
    }

    const videos = items
      .map(v => ({
        id: v.id,
        fullId: `tiktok:${v.id}`,
        url: v.url,
        title: v.desc || "Trending video",
        views: v.views,
        viewCount: parseViews(v.views),
        platform: "tiktok",
      }))
      .filter(v => !processedIds.includes(v.fullId))
      .sort((a, b) => b.viewCount - a.viewCount);

    log(`   ${videos.length} video mới (top: ${videos[0]?.views || "N/A"} views)`);
    return videos;
  } catch (e) {
    log(`   ⚠️ TikTok scrape failed: ${e.message?.slice(0, 80)}`);
    return [];
  }
}

// ── Discovery: Facebook Watch/Reels (viral tổng hợp) ─────────────────────
// Scrape Facebook Watch (popular videos) hoặc Reels — lấy viral tổng hợp
async function discoverFacebook(processedIds) {
  const sources = [
    "https://www.facebook.com/watch/",
    "https://www.facebook.com/reel/",
    "https://www.facebook.com/watch/popular",
  ];
  const sourceUrl = sources[Math.floor(Math.random() * sources.length)];

  log(`🔍 [Facebook] Scraping: ${sourceUrl}`);

  try {
    const result = await withChrome(sourceUrl, async (cdp) => {
      await sleep(6000);
      for (let i = 0; i < 4; i++) {
        await cdp("Runtime.evaluate", {
          expression: "window.scrollTo(0, document.body.scrollHeight)",
        });
        await sleep(2000);
      }

      const evalResult = await cdp("Runtime.evaluate", {
        expression: `
          (() => {
            const items = [];
            const seen = new Set();

            document.querySelectorAll('a[href*="/reel/"], a[href*="/videos/"], a[href*="watch"]').forEach(a => {
              const href = a.href;
              const match = href.match(/\\/reel\\/(\\d+)/)
                || href.match(/\\/videos\\/(\\d+)/)
                || href.match(/[?&]v=(\\d+)/);
              if (!match || seen.has(match[1])) return;
              seen.add(match[1]);

              const container = a.closest('[role="article"]')
                || a.parentElement?.parentElement?.parentElement;
              const text = container?.innerText?.slice(0, 300) || "";

              // Tìm view count text (dạng "1,2M lượt xem")
              const viewMatch = text.match(/(\\d[\\d,.]*[KMB]?)\\s*(?:lượt xem|views)/i);

              items.push({
                id: match[1],
                url: "https://www.facebook.com/watch/?v=" + match[1],
                desc: text.split("\\n")[0]?.trim()?.slice(0, 200) || "",
                views: viewMatch?.[1] || "",
              });
            });

            return JSON.stringify(items.slice(0, 20));
          })()
        `,
        returnByValue: true,
      });

      return evalResult?.result?.value;
    }, { headless: true, timeout: 20000 });

    if (!result) return [];

    const parsed = JSON.parse(result);
    log(`   Tìm thấy ${parsed.length} video`);

    const videos = [];
    for (const v of parsed) {
      const fullId = `fb:${v.id}`;
      if (processedIds.includes(fullId)) continue;
      videos.push({
        id: v.id,
        fullId: fullId,
        url: v.url,
        title: v.desc || keyword,
        views: v.views,
        platform: "facebook",
      });
    }

    log(`   ${videos.length} video mới`);
    return videos;
  } catch (e) {
    log(`   ⚠️ Facebook scrape failed: ${e.message?.slice(0, 80)}`);
    return [];
  }
}

// ── Download video (yt-dlp) ──────────────────────────────────────────────
async function downloadVideo(video) {
  const outPath = join(OUT_DIR, `${video.platform}_${video.id}.mp4`);
  if (existsSync(outPath) && statSync(outPath).size > 100_000) {
    log("   Cached ✅");
    return outPath;
  }

  log(`📥 Download [${video.platform}]: ${video.url}`);

  // yt-dlp hỗ trợ Facebook tốt, TikTok có thể cần fallback
  const cmd = `"${YTDLP}" ` +
    `-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
    `--merge-output-format mp4 ` +
    `--max-filesize 200m ` +
    `--no-warnings ` +
    `-o "${outPath}" ` +
    `"${video.url}"`;

  const result = run(cmd, 120_000);

  if (existsSync(outPath) && statSync(outPath).size > 100_000) {
    const sizeMB = (statSync(outPath).size / 1024 / 1024).toFixed(1);
    log(`   ✅ ${sizeMB}MB`);
    return outPath;
  }

  // TikTok fallback: dùng Chrome CDP để lấy video source URL
  if (video.platform === "tiktok") {
    log("   🔄 yt-dlp failed, thử Chrome CDP download...");
    return await downloadTikTokViaCDP(video, outPath);
  }

  log(`   ❌ Download failed`);
  return null;
}

async function downloadTikTokViaCDP(video, outPath) {
  try {
    const videoSrc = await withChrome(video.url, async (cdp) => {
      await sleep(5000);
      const evalResult = await cdp("Runtime.evaluate", {
        expression: `
          (() => {
            const v = document.querySelector('video');
            return v?.src || v?.querySelector('source')?.src || "";
          })()
        `,
        returnByValue: true,
      });
      return evalResult?.result?.value;
    }, { headless: false, timeout: 20000 });

    if (!videoSrc) return null;

    // Download video source trực tiếp
    const res = await fetch(videoSrc, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buffer);

    if (statSync(outPath).size > 100_000) {
      log(`   ✅ CDP download: ${(statSync(outPath).size / 1024 / 1024).toFixed(1)}MB`);
      return outPath;
    }
  } catch (e) {
    log(`   ❌ CDP download failed: ${e.message?.slice(0, 60)}`);
  }
  return null;
}

// ── FFmpeg: watermark ────────────────────────────────────────────────────
function processVideo(rawPath, video) {
  const outPath = join(OUT_DIR, `${video.platform}_${video.id}_out.mp4`);
  if (existsSync(outPath) && statSync(outPath).size > 50_000) return outPath;

  log(`🎬 FFmpeg: crop 9:16 + watermark`);

  const fontEsc = FONT.replace(/\\/g, "/").replace(/:/g, "\\:");
  const badge = `drawtext=fontfile='${fontEsc}':fontcolor=white:fontsize=46:x=20:y=h-65:text='SUU TAM HANG DI':shadowcolor=black:shadowx=2:shadowy=2:box=1:boxcolor=red@0.85:boxborderw=10`;

  const cmd = `"${FFMPEG}" -y -i "${rawPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${badge}" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -t 180 "${outPath}"`;

  run(cmd, 120_000);

  if (existsSync(outPath) && statSync(outPath).size > 50_000) {
    log(`   ✅ ${(statSync(outPath).size / 1024 / 1024).toFixed(1)}MB`);
    return outPath;
  }

  // Fallback ultrafast
  const cmd2 = `"${FFMPEG}" -y -i "${rawPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${badge}" -c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p -c:a aac -b:a 128k -t 180 "${outPath}"`;
  run(cmd2, 90_000);

  if (existsSync(outPath) && statSync(outPath).size > 50_000) {
    log(`   ✅ ${(statSync(outPath).size / 1024 / 1024).toFixed(1)}MB`);
    return outPath;
  }

  log(`   ❌ FFmpeg failed`);
  return null;
}

// ── Caption (AI) ─────────────────────────────────────────────────────────
async function generateCaption(video) {
  const caption = await genCaptionAI(
    video.title,
    video.platform === "tiktok" ? "TikTok" : "Facebook",
    "Sưu Tầm Hàng Dị",
    "đồ lạ hay ho",
    "facebook",
  );
  return caption || `${video.title?.slice(0, 60) || "Xem xong mà ngỡ ngàng!"}\n\n#suutamhangdi #docla #viral #trending`;
}

// ── Schedule: tính khung giờ vàng ────────────────────────────────────────
function getNextGoldenSlot(slotIndex) {
  // Lấy giờ hiện tại theo Vietnam timezone
  const vnNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  const currentHour = vnNow.getHours();
  const currentMin = vnNow.getMinutes();

  const goldenHours = CFG.goldenHours; // [7, 11, 17, 20]

  // Tìm khung giờ vàng tiếp theo
  let targetHour = null;
  for (const h of goldenHours) {
    if (currentHour < h || (currentHour === h && currentMin < 30)) {
      targetHour = h;
      break;
    }
  }

  // Nếu qua hết các khung giờ hôm nay → lấy khung đầu tiên ngày mai
  if (targetHour === null) {
    targetHour = goldenHours[0];
    vnNow.setDate(vnNow.getDate() + 1);
  }

  // Set giờ + offset cho mỗi video (cách nhau 30 phút)
  vnNow.setHours(targetHour, slotIndex * 30, 0, 0);

  // Chuyển về UTC cho PostFast
  // Vietnam = UTC+7
  const utcTime = new Date(vnNow.getTime() - 7 * 60 * 60 * 1000);

  // Nếu thời gian đã qua → cộng thêm delay
  const now = new Date();
  if (utcTime <= now) {
    return new Date(now.getTime() + (BASE_DELAY + 5 + slotIndex * 30) * 60_000)
      .toISOString().replace(/\.\d{3}Z$/, ".000Z");
  }

  return utcTime.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

// ── Upload + Post via PostFast ───────────────────────────────────────────
async function uploadAndPost(videoPath, caption, scheduledAt) {
  // Upload
  let r = await fetch("https://api.postfa.st/file/get-signed-upload-urls", {
    method: "POST", headers: PF_HEADERS,
    body: JSON.stringify({ contentType: "video/mp4", count: 1 }),
    signal: AbortSignal.timeout(30_000),
  });
  const [{ key: videoKey, signedUrl }] = await r.json();

  const data = readFileSync(videoPath);
  r = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: data,
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
  log(`   ✅ Uploaded: ${videoKey}`);

  const results = {};

  // Post to Facebook
  if (CFG.fbPageId) {
    r = await fetch("https://api.postfa.st/social-posts", {
      method: "POST", headers: PF_HEADERS,
      body: JSON.stringify({
        posts: [{
          content: caption, scheduledAt,
          socialMediaId: CFG.fbPageId,
          mediaItems: [{ key: videoKey, type: "VIDEO", sortOrder: 0 }],
        }],
        controls: { facebookContentType: "REEL" },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(`FB post failed: ${JSON.stringify(res)}`);
    results.fbPostId = res.postIds?.[0];
    log(`   ✅ FB Scheduled: ${scheduledAt} | ID: ${results.fbPostId}`);
  }

  // Post to TikTok via PostFast (nếu có tiktokId trong PostFast)
  if (CFG.tiktokId) {
    try {
      const ttSchedule = new Date(new Date(scheduledAt).getTime() + 5 * 60_000)
        .toISOString().replace(/\.\d{3}Z$/, ".000Z");
      r = await fetch("https://api.postfa.st/social-posts", {
        method: "POST", headers: PF_HEADERS,
        body: JSON.stringify({
          posts: [{
            content: caption, scheduledAt: ttSchedule,
            socialMediaId: CFG.tiktokId,
            mediaItems: [{ key: videoKey, type: "VIDEO", sortOrder: 0 }],
          }],
          controls: { tiktokPrivacy: "PUBLIC", tiktokAllowComments: true, tiktokAllowDuet: true, tiktokAllowStitch: true },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const ttRes = await r.json();
      if (r.ok) {
        results.ttPostId = ttRes.postIds?.[0];
        log(`   ✅ TikTok Scheduled: ${ttSchedule} | ID: ${results.ttPostId}`);
      }
    } catch (e) {
      log(`   ⚠️ TikTok post failed: ${e.message?.slice(0, 60)}`);
    }
  }

  // Post to TikTok Direct — bypass PostFast account limit (@suutam0405)
  if (CFG.tiktokDirect) {
    try {
      const { TikTokDirectPoster } = await import("../tiktok-direct.mjs");
      const poster = new TikTokDirectPoster({
        cdpPort: CFG.tiktokDirect.cdpPort,
        chromeProfile: CFG.tiktokDirect.chromeProfile,
        log,
      });
      const ttResult = await poster.post(videoPath, caption);
      if (ttResult.success) {
        results.ttDirectPostUrl = ttResult.postUrl;
        log(`   ✅ TikTok Direct (@${CFG.tiktokDirect.account}): posted`);
      } else {
        log(`   ⚠️ TikTok Direct failed: ${ttResult.error}`);
      }
      await poster.close();
    } catch (e) {
      log(`   ⚠️ TikTok Direct error: ${e.message?.slice(0, 80)}`);
    }
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════════
log("=".repeat(60));
log(`🔥 TRENDING REPOST → Sưu Tầm Hàng Dị`);
log(`📌 Source: ${SOURCE} | Max: ${MAX_VIDEOS} | DryRun: ${DRY_RUN}`);
log("=".repeat(60));

const state = loadState();
const todayCount = getTodayCount(state);

if (todayCount >= CFG.maxPerDay) {
  log(`✅ Đủ quota hôm nay (${todayCount}/${CFG.maxPerDay}), nghỉ!`);
  saveState(state);
  process.exit(0);
}

// Tổng hợp processed IDs (bao gồm cross-check fb_repost)
const allProcessedIds = [
  ...state.processed_ids,
  ...loadCrossProcessedIds(),
];

// ── Step 1: Discover ─────────────────────────────────────────────────────
let allVideos = [];

if (SOURCE === "both" || SOURCE === "tiktok") {
  const ttVideos = await discoverTikTok(allProcessedIds);
  allVideos.push(...ttVideos);
}

if (SOURCE === "both" || SOURCE === "facebook") {
  const fbVideos = await discoverFacebook(allProcessedIds);
  allVideos.push(...fbVideos);
}

if (allVideos.length === 0) {
  log("⚠️ Không tìm thấy video trending mới.");
  state.last_check = new Date().toISOString();
  saveState(state);
  process.exit(0);
}

// Sort by views cao nhất trước (đã sort trong mỗi channel, merge lại)
allVideos.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
const remaining = CFG.maxPerDay - todayCount;
const toProcess = allVideos.slice(0, Math.min(MAX_VIDEOS, remaining));
log(`\n📌 Xử lý ${toProcess.length} video (${allVideos.length} tìm thấy)\n`);

// ── Step 2-5: Download → Caption → Post ──────────────────────────────────
let success = 0;

for (let i = 0; i < toProcess.length; i++) {
  const video = toProcess[i];
  log(`\n─── [${i + 1}/${toProcess.length}] ${video.platform.toUpperCase()} ───`);
  log(`   🎬 ${video.title?.slice(0, 60) || video.url}`);
  if (video.views) log(`   👁️ ${video.views} views`);

  // Mark as processed sớm (tránh retry khi crash)
  state.processed_ids = [...state.processed_ids, video.fullId].slice(-1000);
  saveState(state);

  try {
    // Download
    const rawPath = await downloadVideo(video);
    if (!rawPath) { log("   ⏭️ Skip"); continue; }

    // FFmpeg process
    const processed = processVideo(rawPath, video);
    if (!processed) { log("   ⏭️ Skip (FFmpeg failed)"); continue; }

    // Caption
    const caption = await generateCaption(video);
    log(`   📝 "${caption.slice(0, 70)}..."`);

    if (DRY_RUN) {
      log("   🏷️ [DRY RUN] Không post");
      success++;
      continue;
    }

    // Schedule at golden hour
    const scheduledAt = getNextGoldenSlot(todayCount + success);
    const result = await uploadAndPost(processed, caption, scheduledAt);

    incrementToday(state);
    saveState(state);
    success++;

    // Cleanup
    try { unlinkSync(rawPath); } catch {}
    try { unlinkSync(processed); } catch {}

    if (i < toProcess.length - 1) await sleep(5000);
  } catch (e) {
    log(`   ❌ Error: ${e.message?.slice(0, 100)}`);
  }
}

// Kill any remaining Chrome
try { run("taskkill /F /IM chrome.exe 2>nul", 5000); } catch {}

state.last_check = new Date().toISOString();
saveState(state);

log("\n" + "=".repeat(60));
log(`✅ Posted ${success}/${toProcess.length} trending videos`);
log(`📊 Hôm nay: ${getTodayCount(state)}/${CFG.maxPerDay}`);
