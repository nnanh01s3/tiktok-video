/**
 * SHOPEE REUP — Unified script for all Facebook/TikTok pages.
 *
 * Usage:
 *   node src/shopee/reup.mjs --page shopee     # Main page (TikTok + FB)
 *   node src/shopee/reup.mjs --page gia_dung   # Đồ Gia Dụng (FB only)
 *   node src/shopee/reup.mjs --page tech        # Công Nghệ (FB only)
 *   node src/shopee/reup.mjs --list             # List available pages
 *
 * Flow:
 *  1. Shopee Affiliate API → products with video + commission
 *  2. Download MP4 from Shopee CDN
 *  3. FFmpeg: crop 9:16, watermark, hook text
 *  4. AI caption (Claude Haiku) + affiliate link
 *  5. Post via PostFast (TikTok + Facebook)
 */

import "../env.js";
import { spawnSync } from "child_process";
import {
  writeFileSync, readFileSync, mkdirSync,
  existsSync, statSync, unlinkSync, readdirSync,
} from "fs";
import { join } from "path";
import { genCaptionAI, genCaptionFallback } from "./caption.mjs";
import { ShopeeAffiliate, closeCdpBrowser } from "./affiliate.mjs";
import { shortenUrl } from "./shorten_url.mjs";
import { PAGES, FFMPEG, FONT, BASE_DIR, MAX_PER_DAY, MAX_PER_RUN } from "./config.mjs";

// ── Parse CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes("--list")) {
  console.log("Available pages:");
  for (const [key, cfg] of Object.entries(PAGES)) {
    const platforms = [cfg.fbId && "FB", cfg.ttId && "TT"].filter(Boolean).join("+");
    console.log(`  --page ${key.padEnd(12)} ${cfg.name} (${platforms})`);
  }
  process.exit(0);
}

const pageArg = args[args.indexOf("--page") + 1];
if (!pageArg || !PAGES[pageArg]) {
  console.error(`Usage: node src/shopee/reup.mjs --page <${Object.keys(PAGES).join("|")}>`);
  console.error("       node src/shopee/reup.mjs --list");
  process.exit(1);
}

const PAGE = PAGES[pageArg];
const BASE_DELAY = args.includes("--delay")
  ? parseInt(args[args.indexOf("--delay") + 1]) || 0
  : 0; // phút delay trước khi schedule video đầu tiên
const POST_INTERVAL = 5; // phút giữa các video cùng page
const OUTPUT_DIR = join(BASE_DIR, pageArg);
const STATE_FILE = join(OUTPUT_DIR, "state.json");
const LOG_FILE = join(OUTPUT_DIR, "reup.log");
const CAPTION_HISTORY_FILE = join(OUTPUT_DIR, "caption_history.json");

mkdirSync(OUTPUT_DIR, { recursive: true });

// PostFast removed — reup now uses social-poster.js (PostForMe)

// ── Helpers ────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}] ${msg}`;
  console.log(line);
  try {
    const prev = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    writeFileSync(LOG_FILE, (prev + line + "\n").slice(-100_000));
  } catch {}
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function run(cmd, timeout = 90_000) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", timeout });
}
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { processed_ids: [], used_shopee_ids: [], posts_today: [], last_reset: null }; }
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function resetIfNewDay(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.last_reset !== today) { state.posts_today = []; state.last_reset = today; }
  if (!Array.isArray(state.used_shopee_ids)) state.used_shopee_ids = [];
  return state;
}
function loadCaptionHistory() {
  try { return JSON.parse(readFileSync(CAPTION_HISTORY_FILE, "utf8")); } catch { return []; }
}
function saveCaptionHistory(arr) {
  writeFileSync(CAPTION_HISTORY_FILE, JSON.stringify(arr.slice(-50), null, 2));
}

// ── Step 1: Discover products ──────────────────────────────────────────────
const shopeeAff = new ShopeeAffiliate();

async function discoverProducts(usedIds) {
  if (!shopeeAff.isReady()) {
    log("ℹ️  Chưa có Shopee Affiliate cookies");
    return [];
  }

  try {
    const opts = {
      categoriesPerRun: 4,
      productsPerCat: 4,
      minCommission: 0,
      videoOnly: true,
      log,
    };

    // Filter by category — PAGE.categories has { catids, matchIds }
    // catids: filter products from cache by product catid
    // matchIds: filter API queries (when API works)
    if (PAGE.categories) {
      opts.categoryIds = PAGE.categories.matchIds || PAGE.categories;
      opts.catidFilter = PAGE.categories.catids || null;
    }

    const products = await shopeeAff.discoverProducts(usedIds, opts);
    if (products.length > 0) {
      log(`   💰 ${products.length} sản phẩm có video + commission`);
      return products;
    }

    // Fallback 1: same category without videoOnly filter
    opts.videoOnly = false;
    const all = await shopeeAff.discoverProducts(usedIds, opts);
    const withVideo = all.filter(p => p.hasVideo);
    if (withVideo.length > 0) {
      log(`   ✅ Tìm thêm ${withVideo.length} SP có video (no videoOnly filter)`);
      return withVideo;
    }

    // Fallback 2: no category filter (random products) — better than 0
    if (PAGE.categories) {
      log("   ⚠️ Không có SP cho category này, thử random...");
      const randomProducts = await shopeeAff.discoverProducts(usedIds, {
        categoriesPerRun: 4, productsPerCat: 4,
        minCommission: 0, videoOnly: true, log,
      });
      if (randomProducts.length > 0) {
        log(`   ✅ Fallback: ${randomProducts.length} SP random có video`);
        return randomProducts;
      }
    }

    log("   ⚠️ Không có SP nào có video");
  } catch (e) {
    log(`   ❌ Affiliate API lỗi: ${e.message?.slice(0, 80)}`);
  }
  return [];
}

// ── Step 2: Download video ─────────────────────────────────────────────────
async function downloadVideo(product) {
  const outPath = join(OUTPUT_DIR, `${product.itemId}_raw.mp4`);
  if (existsSync(outPath) && statSync(outPath).size > 50_000) return outPath;

  if (!product.videoUrl) {
    log(`   ❌ Không có video URL cho "${product.name?.slice(0, 40)}"`);
    return null;
  }

  log(`📥 Download: "${product.name?.slice(0, 45)}" | ${product.videoDuration}s`);

  try {
    const res = await fetch(product.videoUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://shopee.vn/",
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) { log(`   ❌ HTTP ${res.status}`); return null; }

    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buffer);

    if (statSync(outPath).size > 50_000) {
      log(`   ✅ ${(statSync(outPath).size / 1024 / 1024).toFixed(1)}MB`);
      return outPath;
    }

    try { unlinkSync(outPath); } catch {}
    return null;
  } catch (e) {
    log(`   ❌ Download lỗi: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

// ── Step 3: FFmpeg processing ──────────────────────────────────────────────
function makeHookText(product) {
  const name = (product.name || "").replace(/[【】\[\]()（）]/g, "").trim().slice(0, 35);
  const price = product.price ? `${product.price.toLocaleString("vi")}d` : "";
  if (price && name) return `${name} - ${price}`;
  return name || "San pham hot Shopee!";
}

async function processVideo(rawPath, product) {
  const outPath = join(OUTPUT_DIR, `${product.itemId}_out.mp4`);
  if (existsSync(outPath) && statSync(outPath).size > 50_000) return outPath;

  log(`🎬 FFmpeg: crop 9:16 + watermark`);

  // Detect dimensions
  const probe = run(`"${FFMPEG}" -i "${rawPath}" 2>&1`, 10_000);
  const dim = (probe.stderr || probe.stdout || "").match(/(\d{3,4})x(\d{3,4})/);
  const w = dim ? parseInt(dim[1]) : product.videoWidth || 720;
  const h = dim ? parseInt(dim[2]) : product.videoHeight || 720;
  const isPortrait = h > w;
  const isSquare = Math.abs(w - h) < 50;

  // Hook text (product name + price)
  const hookRaw = makeHookText(product);
  const hook = hookRaw.replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/[[\]"]/g, "").replace(/%/g, "%%");

  const fontEsc = FONT.replace(/\\/g, "/").replace(/:/g, "\\:");
  const filters = [
    `drawtext=fontfile='${fontEsc}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=80:text='${hook}':shadowcolor=black@0.9:shadowx=3:shadowy=3:box=1:boxcolor=black@0.6:boxborderw=16`,
  ];
  // Page watermark badge (optional — some pages don't have hook config)
  if (PAGE.hook) {
    const { text: badgeText, color: badgeColor, fontSize: badgeFontSize } = PAGE.hook;
    filters.push(
      `drawtext=fontfile='${fontEsc}':fontcolor=white:fontsize=${badgeFontSize}:x=20:y=h-65:text='${badgeText}':shadowcolor=black:shadowx=2:shadowy=2:box=1:boxcolor=${badgeColor}:boxborderw=10`
    );
  }
  const textFilter = filters.join(",");

  let cmd;
  if (isPortrait) {
    cmd = `"${FFMPEG}" -y -i "${rawPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${textFilter}" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k "${outPath}"`;
  } else if (isSquare) {
    cmd = `"${FFMPEG}" -y -i "${rawPath}" -filter_complex "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[b]scale=1080:1080[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${textFilter}[v]" -map "[v]" -map "0:a?" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k "${outPath}"`;
  } else {
    cmd = `"${FFMPEG}" -y -i "${rawPath}" -filter_complex "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg];[b]scale=1080:608[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${textFilter}[v]" -map "[v]" -map "0:a?" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k "${outPath}"`;
  }

  run(cmd, 90_000);

  // Fallback: ultrafast if first attempt fails
  if (!existsSync(outPath) || statSync(outPath).size < 50_000) {
    run(`"${FFMPEG}" -y -i "${rawPath}" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${textFilter}" -c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p -c:a aac -b:a 128k "${outPath}"`, 60_000);
  }

  if (existsSync(outPath) && statSync(outPath).size > 50_000) {
    log(`   ✅ ${(statSync(outPath).size / 1024 / 1024).toFixed(1)}MB`);
    return outPath;
  }
  log(`   ❌ FFmpeg thất bại`);
  return null;
}

// ── Step 4: Upload + Post via social-poster (PostFast or PostForMe) ───────
import { createPoster } from "../social-poster.js";
const poster = createPoster(PAGE);

async function appendAffLink(caption, product) {
  if (!product?.affiliateLink) return caption;
  const shortLink = await shortenUrl(product.affiliateLink);
  return `${caption}\n\n🛒 Mua ngay: ${shortLink}`;
}

async function postVideo(videoPath, caption, product, slotIdx) {
  const mediaRef = await poster.upload(videoPath);
  log(`   ✅ Uploaded: ${mediaRef.slice(0, 60)}`);

  const captionWithLink = await appendAffLink(caption, product);
  const delay = BASE_DELAY + slotIdx * POST_INTERVAL;
  const scheduledAt = new Date(Date.now() + delay * 60_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const results = {};

  log(`   🕐 Schedule sau ${delay} phút`);

  // Post to Facebook Reel
  if (poster.getFacebookId()) {
    try {
      const fbResult = await poster.scheduleFacebook({ mediaRef, caption: captionWithLink, scheduledAt });
      results.fbPostId = fbResult.postId || fbResult.postIds?.[0];
      log(`   ✅ Facebook scheduled | ID: ${results.fbPostId}`);
    } catch (e) { log(`   ⚠️ Facebook failed: ${e.message?.slice(0, 80)}`); }
  }

  // Post to TikTok (if configured)
  if (poster.getTikTokId()) {
    try {
      const ttSchedule = new Date(new Date(scheduledAt).getTime() + 5 * 60_000).toISOString();
      const ttResult = await poster.scheduleTikTok({ mediaRef, caption: captionWithLink, scheduledAt: ttSchedule });
      results.ttPostId = ttResult?.postId || ttResult?.postIds?.[0];
      log(`   ✅ TikTok scheduled | ID: ${results.ttPostId}`);
    } catch (e) { log(`   ⚠️ TikTok failed: ${e.message?.slice(0, 80)}`); }
  }

  // Affiliate comment (PostFast only, 60 min after post)
  if (PAGE.postComments && product?.affiliateLink && results.fbPostId) {
    const shortLink = await shortenUrl(product.affiliateLink);
    const comment = `MUA NGAY TẠI ĐÂY👇👇👇\n${shortLink}\n${shortLink}`;
    const commentDelay = 60 * 60_000;
    const timer = setTimeout(async () => {
      try {
        await poster.postComment(results.fbPostId, comment);
        log(`   💬 Comment posted: ${results.fbPostId}`);
      } catch {}
    }, commentDelay);
    timer.unref();
    log(`   🕐 Comment sẽ gửi sau 60 phút`);
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════════════
log("=".repeat(60));
log(`🚀 SHOPEE REUP — ${PAGE.name} [${pageArg}]`);
log("=".repeat(60));

let state = resetIfNewDay(loadState());
const doneToday = state.posts_today.length;
log(`📊 Hôm nay: ${doneToday}/${MAX_PER_DAY}`);

if (doneToday >= MAX_PER_DAY) {
  log("✅ Đủ quota, nghỉ!");
  saveState(state);
  process.exit(0);
}

const slot = Math.min(MAX_PER_RUN, MAX_PER_DAY - doneToday);
const products = await discoverProducts(state.used_shopee_ids || []);

if (!products.length) {
  log("⚠️ Không tìm thấy sản phẩm có video.");
  state.last_check = new Date().toISOString();
  saveState(state);
  process.exit(0);
}

const toProcess = products.slice(0, slot);
log(`📌 Xử lý ${toProcess.length} sản phẩm\n`);

// Check if page has a valid posting account configured
if (!poster.getFacebookId() && !poster.getTikTokId()) {
  log(`⚠️ Page "${PAGE.name}" has no posting accounts configured yet. Skipping.`);
  log(`   Set pfmId in config.mjs after creating FB page + connecting PostForMe.`);
  process.exit(0);
}

let captionHistory = loadCaptionHistory();
let success = 0;

for (let i = 0; i < toProcess.length; i++) {
  const p = toProcess[i];

  log(`\n─── [${i + 1}/${toProcess.length}] ───`);
  log(`   📦 ${p.name?.slice(0, 60)}`);
  log(`   💰 ${p.commissionRate}% | ${p.price?.toLocaleString("vi")}đ | Bán: ${p.sold}`);

  state.processed_ids = [...state.processed_ids, p.itemId].slice(-500);
  state.used_shopee_ids = [...state.used_shopee_ids, p.itemId].slice(-500);
  saveState(state);

  try {
    const raw = await downloadVideo(p);
    if (!raw) continue;

    const processed = await processVideo(raw, p);
    if (!processed) continue;

    const { platform, niche, pageName } = PAGE.caption;
    const caption =
      (await genCaptionAI(p.name, p.shopName || "Shopee", pageName, niche, platform))
      || genCaptionFallback(p.name, pageName, niche);
    log(`   📝 "${caption.slice(0, 80)}..."`);

    const result = await postVideo(processed, caption, p, doneToday + success);

    state.posts_today.push({
      ...result,
      shopeeItemId: p.itemId,
      productName: p.name?.slice(0, 100),
      affiliateLink: p.affiliateLink || null,
      at: new Date().toISOString(),
    });
    saveState(state);
    captionHistory.push(caption);
    saveCaptionHistory(captionHistory);

    success++;
    try { unlinkSync(processed); } catch {}
    if (i < toProcess.length - 1) await sleep(5000);
  } catch (e) {
    log(`   ❌ ${e.message?.slice(0, 120)}`);
  }
}

state.last_check = new Date().toISOString();
saveState(state);

log("\n" + "=".repeat(60));
log(`✅ Đăng ${success}/${toProcess.length} video | Page: ${PAGE.name}`);
log(`📊 Tổng hôm nay: ${doneToday + success}/${MAX_PER_DAY}`);

// Cleanup raw files > 3 days
const cutoff = Date.now() - 3 * 24 * 3600_000;
try {
  readdirSync(OUTPUT_DIR).forEach(f => {
    if (!f.endsWith("_raw.mp4")) return;
    const fp = join(OUTPUT_DIR, f);
    if (statSync(fp).mtimeMs < cutoff) { unlinkSync(fp); log(`🗑️ Cleaned: ${f}`); }
  });
} catch {}

// Close Chrome CDP browser
await closeCdpBrowser();
