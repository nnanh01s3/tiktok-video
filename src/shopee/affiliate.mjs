/**
 * SHOPEE AFFILIATE MODULE v3 — Dashboard API + Product Video
 *
 * Dùng chung cho tất cả reup scripts (shopee_reup, tech_reup, baby_reup)
 *
 * Cách hoạt động:
 *  - Gọi API nội bộ: GET affiliate.shopee.vn/api/v3/offer/product/list
 *  - Authentication bằng cookies session Shopee Affiliate
 *  - Trả về sản phẩm có commission + affiliate link (long_link) sẵn
 *  - Parse video_info_list → lấy video MP4 trực tiếp từ Shopee CDN
 *  - Chỉ chọn sản phẩm CÓ VIDEO (loại bỏ SP không có video)
 *
 * Cookies cần thiết (lấy từ browser sau khi đăng nhập affiliate.shopee.vn):
 *  - SPC_F, SPC_U, SPC_R_T_ID, SPC_R_T_IV, SPC_EC, csrftoken
 *
 * ENV:
 *  - SHOPEE_AFF_COOKIE: Full cookie string (copy từ browser DevTools)
 *  - Hoặc file: D:/tiktok/config/shopee_cookie.txt
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { join } from "path";

// ── CONFIG ──────────────────────────────────────────────────────────────────
const API_BASE = "https://affiliate.shopee.vn/api/v3";
const IMAGE_CDN = "https://down-vn.img.susercontent.com/file/";
const COOKIE_FILE = "D:/tiktok/config/shopee_cookie.txt";

// ── CATEGORY MAP ────────────────────────────────────────────────────────────
// Mapping từ match_id → tên category (lấy từ dashboard)
const CATEGORIES = {
  100636: { name: "Nhà Cửa & Đời Sống", tag: "nhacua" },
  100637: { name: "Sắc Đẹp", tag: "sacdep" },
  100638: { name: "Thời Trang Nữ", tag: "thoitrangnu" },
  100639: { name: "Bách Hóa Online", tag: "bachhoa" },
  100640: { name: "Thời Trang Nam", tag: "thoitrangnam" },
  100641: { name: "Mẹ & Bé", tag: "mebe" },
  100642: { name: "Thiết Bị Điện Tử", tag: "dientu" },
  100630: { name: "Điện Thoại & Phụ Kiện", tag: "dienthoai" },
  100632: { name: "Máy Tính & Laptop", tag: "maytinh" },
  100633: { name: "Đồng Hồ", tag: "dongho" },
  100634: { name: "Giày Dép", tag: "giaydep" },
  100635: { name: "Túi Ví", tag: "tuivi" },
  100010: { name: "Thể Thao & Du Lịch", tag: "thethao" },
  100011: { name: "Ô Tô & Xe Máy", tag: "otoxemay" },
  100012: { name: "Sức Khỏe", tag: "suckhoe" },
  100017: { name: "Nhà Sách", tag: "nhasach" },
};

// list_type values
const LIST_TYPE = {
  ALL: 1,          // Tất cả (Hoa hồng Shopee)
  BEST_SELLER: 2,  // Bán chạy nhất (500 SP)
  BY_CATEGORY: 3,  // Theo category (cần match_type=2 & match_id)
};

// ── COOKIE MANAGEMENT ───────────────────────────────────────────────────────

/**
 * Lấy cookie string từ env hoặc file
 */
function getCookieString() {
  // 1. Từ env variable
  const envCookie = process.env.SHOPEE_AFF_COOKIE;
  if (envCookie && envCookie.length > 50) return envCookie.trim();

  // 2. Từ file
  if (existsSync(COOKIE_FILE)) {
    try {
      const content = readFileSync(COOKIE_FILE, "utf8").trim();
      if (content.length > 50) return content;
    } catch {}
  }

  return "";
}

// ── CHROME CDP CLIENT ──────────────────────────────────────────────────────
// Shopee uses TLS fingerprinting — Node fetch gets 403.
// We launch Chrome headless and run fetch() from real browser context.

const CHROME = process.env.CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CHROME_PROFILE = "D:/tiktok/data/shopee/chrome_aff";
const CDP_PORT = 9399; // fixed port for affiliate

let _cdpBrowser = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function runSync(cmd) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 5000 });
}

/**
 * Get or create a persistent Chrome CDP connection.
 */
async function getCdpBrowser() {
  // Check existing connection
  if (_cdpBrowser?.ws?.readyState === 1) {
    try {
      // Quick health check
      await _cdpBrowser.cdp("Runtime.evaluate", { expression: "1+1", returnByValue: true });
      return _cdpBrowser;
    } catch {
      _cdpBrowser = null;
    }
  }

  // Kill any previous Chrome on our port
  runSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${CDP_PORT}') do taskkill /F /PID %a 2>nul`);
  await sleep(1000);

  mkdirSync(CHROME_PROFILE, { recursive: true });

  const proc = spawn(
    `"${CHROME}"`,
    [
      "--headless=new", "--disable-gpu", "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { shell: true, detached: true, stdio: "ignore" }
  );
  proc.unref();

  // Wait for Chrome to start
  let ws, cdp;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(2000) });
      const tabs = await r.json();
      const tab = tabs.find(t => t.type === "page") || tabs[0];
      if (!tab?.webSocketDebuggerUrl) continue;

      const { default: WS } = await import("ws");
      ws = new WS(tab.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

      cdp = (method, params = {}) => new Promise((res, rej) => {
        const id = Math.floor(Math.random() * 1e8);
        const handler = d => {
          const m = JSON.parse(d.toString());
          if (m.id === id) { ws.off("message", handler); res(m.result); }
        };
        ws.on("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { ws.off("message", handler); rej(new Error("CDP timeout")); }, 20000);
      });
      break;
    } catch {}
  }
  if (!ws || !cdp) throw new Error("Chrome CDP startup failed");

  // Anti-detection: hide webdriver flag
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
  });
  // Enable Network + inject cookies
  await cdp("Network.enable");
  const cookie = getCookieString();
  if (cookie) {
    const pairs = cookie.split(";").map(s => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      try {
        await cdp("Network.setCookie", { name, value, domain: ".shopee.vn", path: "/", secure: true });
        await cdp("Network.setCookie", { name, value, domain: "affiliate.shopee.vn", path: "/", secure: true });
      } catch {}
    }
  }

  // Navigate to affiliate page so cookies are active
  await cdp("Page.navigate", { url: "https://affiliate.shopee.vn/offer/product_offer" });
  await sleep(4000);

  _cdpBrowser = { ws, cdp, proc, port: CDP_PORT };
  return _cdpBrowser;
}

/**
 * Kill Chrome CDP browser
 */
function closeCdpBrowser() {
  if (!_cdpBrowser) return;
  try { _cdpBrowser.ws.close(); } catch {}
  try { _cdpBrowser.proc.kill(); } catch {}
  runSync(`taskkill /F /PID ${_cdpBrowser.proc.pid} 2>nul`);
  _cdpBrowser = null;
}

// ── PRODUCT CACHE ─────────────────────────────────────────────────────────
// Shopee uses anti-bot that blocks headless Chrome and Node fetch.
// Products are fetched via real browser (MCP extension) and cached to JSON.
// Run: node src/shopee/fetch_products.mjs  (uses Chrome CDP with user profile)
// Or manually: save API responses to CACHE_FILE via browser DevTools.

const CACHE_FILE = "D:/tiktok/data/shopee/products_cache.json";
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours (was 4h — too aggressive)

function readCache(ignoreAge = false) {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (!ignoreAge && Date.now() - new Date(cache.fetchedAt).getTime() > CACHE_MAX_AGE) return null;
    if (!cache.products?.length) return null; // empty cache = useless
    return cache;
  } catch { return null; }
}

/**
 * Gọi Shopee Affiliate API — thử CDP trước, fallback đọc cache
 */
async function callApi(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? "?" + qs : ""}`;

  // Try Chrome CDP first
  try {
    const { cdp } = await getCdpBrowser();
    const result = await cdp("Runtime.evaluate", {
      expression: `
        (async () => {
          try {
            const r = await fetch("${url}", { credentials: "include" });
            return await r.text();
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });

    const raw = result?.result?.value;
    if (raw && typeof raw === "string") {
      const parsed = JSON.parse(raw);
      if (!parsed.error && parsed.code === 0) return parsed.data;
    }
  } catch {}

  // Fallback: try direct fetch (sometimes works)
  try {
    const cookie = getCookieString();
    if (cookie) {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://affiliate.shopee.vn/offer/product_offer",
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.code === 0) return data.data;
      }
    }
  } catch {}

  throw new Error(`Shopee Affiliate API failed: ${path}`);
}

// ── PRODUCT PARSING ─────────────────────────────────────────────────────────

/**
 * Parse raw API item → clean product object
 */
function parseProduct(item, categoryName = "") {
  const b = item.batch_item_for_item_card_full || {};

  // Price: Shopee trả về đơn vị = VND * 100000
  const rawPrice = b.price || b.price_min || 0;
  const price = Math.round(Number(rawPrice) / 100_000);
  const priceMax = Math.round(Number(b.price_max || rawPrice) / 100_000);

  // Commission rate: string "13,5%" → float 13.5
  const parseRate = (s) => {
    if (!s) return 0;
    return parseFloat(String(s).replace(",", ".").replace("%", "")) || 0;
  };

  // ── Video info: video_info_list → lấy MP4 URL trực tiếp ──
  const videoList = b.video_info_list || [];
  let videoUrl = null;
  let videoDuration = 0;
  let videoWidth = 0;
  let videoHeight = 0;
  let videoThumb = null;

  if (videoList.length > 0) {
    const firstVideo = videoList[0];
    videoDuration = firstVideo.duration || 0;
    videoThumb = firstVideo.thumb_url || null;

    // Chọn format tốt nhất (ưu tiên resolution cao nhất)
    const formats = firstVideo.formats || [];
    if (formats.length > 0) {
      // Sort by resolution (width * height) descending
      const sorted = [...formats].sort((a, b) =>
        (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
      );
      const best = sorted[0];
      videoUrl = best.url || null;
      videoWidth = best.width || 0;
      videoHeight = best.height || 0;
    }
  }

  return {
    itemId: String(item.item_id || b.itemid || ""),
    shopId: String(b.shopid || ""),
    name: (b.name || "").trim(),
    price,
    priceMax,
    sold: b.historical_sold || 0,
    rating: b.item_rating?.rating_star || 0,
    image: b.image ? `${IMAGE_CDN}${b.image}` : null,
    link: item.product_link || "",
    affiliateLink: item.long_link || "",  // ← Affiliate link có tracking sẵn
    commissionRate: parseRate(item.default_commission_rate),
    sellerCommissionRate: parseRate(item.seller_commission_rate),
    maxCommissionRate: parseRate(item.max_commission_rate),
    shopName: b.shop_name || "",
    category: categoryName,
    catId: b.catid || 0,
    // ── Video fields ──
    videoUrl,         // Direct MP4 URL từ Shopee CDN
    videoDuration,    // Giây
    videoWidth,
    videoHeight,
    videoThumb,       // Thumbnail URL
    hasVideo: !!videoUrl,
    source: "shopee_affiliate_dashboard",
  };
}

// ── PUBLIC API ──────────────────────────────────────────────────────────────

export class ShopeeAffiliate {
  constructor() {
    this.hasCookies = !!getCookieString();
  }

  /**
   * Kiểm tra có cookies không
   */
  isReady() {
    this.hasCookies = !!getCookieString();
    return this.hasCookies;
  }

  /**
   * Lấy sản phẩm bán chạy nhất (có commission)
   *
   * @param {Object} opts
   * @param {number} opts.limit   — Số SP cần (max 50/page, tổng 500)
   * @param {number} opts.offset  — Bắt đầu từ vị trí
   * @returns {Promise<{products: Array, total: number}>}
   */
  async getBestSellers({ limit = 20, offset = 0 } = {}) {
    const data = await callApi("/offer/product/list", {
      list_type: LIST_TYPE.BEST_SELLER,
      sort_type: 1,
      page_offset: offset,
      page_limit: Math.min(limit, 50),
      client_type: 1,
    });

    return {
      products: (data.list || []).map((item) => parseProduct(item, "Bán chạy nhất")),
      total: data.total_count || 0,
    };
  }

  /**
   * Lấy sản phẩm theo category
   *
   * @param {number} catId  — Category ID (100636, 100637, ...)
   * @param {Object} opts
   * @param {number} opts.limit
   * @param {number} opts.offset
   */
  async getByCategory(catId, { limit = 20, offset = 0 } = {}) {
    const catInfo = CATEGORIES[catId] || { name: `Cat ${catId}`, tag: "unknown" };

    const data = await callApi("/offer/product/list", {
      list_type: LIST_TYPE.BY_CATEGORY,
      match_type: 2,
      match_id: catId,
      sort_type: 1,
      page_offset: offset,
      page_limit: Math.min(limit, 50),
      client_type: 1,
    });

    return {
      products: (data.list || []).map((item) => parseProduct(item, catInfo.name)),
      total: data.total_count || 0,
    };
  }

  /**
   * Tìm sản phẩm qua tất cả offers (Hoa hồng Shopee)
   */
  async getAllOffers({ limit = 20, offset = 0 } = {}) {
    const data = await callApi("/offer/product/list", {
      list_type: LIST_TYPE.ALL,
      sort_type: 1,
      page_offset: offset,
      page_limit: Math.min(limit, 50),
      client_type: 1,
    });

    return {
      products: (data.list || []).map((item) => parseProduct(item, "Tất cả")),
      total: data.total_count || 0,
    };
  }

  /**
   * ★ MAIN METHOD — Dùng trong reup scripts
   *
   * Tìm sản phẩm từ nhiều category ngẫu nhiên, lọc chưa dùng, có affiliate link
   *
   * @param {string[]} usedIds     — Danh sách itemId đã dùng (tránh trùng)
   * @param {Object}   opts
   * @param {number}   opts.categoriesPerRun — Số category random (default 3)
   * @param {number}   opts.productsPerCat   — Số SP/category (default 3)
   * @param {number}   opts.minCommission    — Commission tối thiểu % (default 0)
   * @param {boolean}  opts.videoOnly        — Chỉ lấy SP có video (default true)
   * @param {Function} opts.log              — Logger function
   *
   * @returns {Promise<Array>} — Mảng sản phẩm có affiliate link (+ video nếu videoOnly)
   */
  async discoverProducts(
    usedIds = [],
    {
      strategy = "random",        // "random" (default, legacy) | "bestseller"
      categoriesPerRun = 3,
      productsPerCat = 3,
      minCommission = 0,
      videoOnly = true,
      categoryIds = null,  // match_ids for API queries
      catidFilter = null,  // product catids for cache filtering
      log = console.log,
    } = {}
  ) {
    // Try cache first (API luôn bị TLS fingerprinting chặn, dùng fetch_products.mjs để refresh cache)
    let allProducts = [];
    let usedCache = false;

    const cache = readCache();
    if (cache) {
      log("📦 Đọc từ cache (fetch_products.mjs)...");

      // Filter by product catid (from batch_item_for_item_card_full.catid)
      // This is the REAL product category, not the offer match_id
      const catidSet = catidFilter ? new Set(catidFilter.map(Number)) : null;
      const matchesCategory = (item) => {
        if (!catidSet) return true; // null = no filter, accept all
        const productCatid = item.batch_item_for_item_card_full?.catid;
        return productCatid ? catidSet.has(Number(productCatid)) : false;
      };

      const products = cache.products
        .filter(matchesCategory)
        .map(item => parseProduct(item, "cache"));

      const filtered = products.filter(
        p => !usedIds.includes(p.itemId) &&
             p.affiliateLink &&
             p.commissionRate >= minCommission &&
             (!videoOnly || p.hasVideo)
      );

      if (strategy === "bestseller") {
        // Sort by historical_sold DESC, tiebreak by commissionRate DESC
        allProducts = filtered
          .sort((a, b) =>
            ((b.sold || 0) - (a.sold || 0)) ||
            ((b.commissionRate || 0) - (a.commissionRate || 0))
          )
          .slice(0, productsPerCat);
      } else {
        // Legacy: random shuffle, larger slice
        allProducts = filtered
          .sort(() => Math.random() - 0.5)
          .slice(0, categoriesPerRun * productsPerCat);
      }
      usedCache = true;

      if (categoryIds) {
        log(`   🏷️ Filtered by categories: [${categoryIds.join(", ")}] → ${allProducts.length} products (strategy=${strategy})`);
      }
    }

    // Fallback 1: try API if cache missed/expired
    if (allProducts.length === 0 && !usedCache) {
      let apiError = null;
      try {
        if (!this.isReady()) throw new Error("no cookies");
        allProducts = await this._fetchFromApi({ strategy, usedIds, categoriesPerRun, productsPerCat, minCommission, videoOnly, categoryIds, log });
      } catch (e) {
        apiError = e;
      }

      // Fallback 2: read expired cache — triggered if API threw OR returned empty
      if (allProducts.length === 0) {
        const staleCache = readCache(true); // ignoreAge = true
        if (staleCache) {
          log(apiError ? "📦 API fail → đọc cache cũ (expired)..." : "📦 API trả 0 SP → đọc cache cũ (expired)...");
          const catidSet2 = catidFilter ? new Set(catidFilter.map(Number)) : null;
          const matchesCat = (item) => {
            if (!catidSet2) return true;
            const cid = item.batch_item_for_item_card_full?.catid;
            return cid ? catidSet2.has(Number(cid)) : false;
          };
          const products = staleCache.products.filter(matchesCat).map(item => parseProduct(item, "cache-stale"));
          const filtered = products.filter(
            p => !usedIds.includes(p.itemId) && p.affiliateLink &&
                 p.commissionRate >= minCommission && (!videoOnly || p.hasVideo)
          );
          if (strategy === "bestseller") {
            allProducts = filtered
              .sort((a, b) =>
                ((b.sold || 0) - (a.sold || 0)) ||
                ((b.commissionRate || 0) - (a.commissionRate || 0))
              )
              .slice(0, productsPerCat);
          } else {
            allProducts = filtered
              .sort(() => Math.random() - 0.5)
              .slice(0, categoriesPerRun * productsPerCat);
          }
          if (allProducts.length > 0) {
            log(`   ✅ Stale cache: ${allProducts.length} SP (strategy=${strategy})`);
          }
        } else {
          log("❌ API fail + không có cache, 0 sản phẩm.");
        }
      }
    }

    log(`   📊 Tổng: ${allProducts.length} sản phẩm${usedCache ? " (từ cache)" : ""}${videoOnly ? " (có video + hoa hồng)" : ""}`);
    return allProducts;
  }

  /** @private Fetch products from live API */
  async _fetchFromApi({ strategy = "random", usedIds, categoriesPerRun, productsPerCat, minCommission, videoOnly, categoryIds, log }) {
    log("🛒 Tìm sản phẩm qua Shopee Affiliate Dashboard API...");
    const allProducts = [];

    const catIds = categoryIds || Object.keys(CATEGORIES).map(Number);
    const selectedCats = catIds
      .sort(() => Math.random() - 0.5)
      .slice(0, categoriesPerRun);

    const sources = [
      { type: "bestseller", catId: null },
      ...selectedCats.map((id) => ({ type: "category", catId: id })),
    ];

    for (const src of sources) {
      try {
        let result;
        const randomOffset = Math.floor(Math.random() * 40);

        if (src.type === "bestseller") {
          log("   🔥 Bán chạy nhất");
          result = await this.getBestSellers({ limit: productsPerCat * 3, offset: randomOffset });
        } else {
          const catInfo = CATEGORIES[src.catId] || {};
          log(`   📦 ${catInfo.name || src.catId}`);
          result = await this.getByCategory(src.catId, { limit: productsPerCat * 3, offset: randomOffset });
        }

        if (result.products.length > 0) {
          const fresh = result.products.filter(
            p => !usedIds.includes(p.itemId) && p.affiliateLink &&
                 p.commissionRate >= minCommission && (!videoOnly || p.hasVideo)
          );
          const picked = fresh.slice(0, productsPerCat);
          const withVideo = result.products.filter(p => p.hasVideo).length;
          log(`   ✅ ${result.products.length} SP (${withVideo} có video), ${picked.length} mới`);
          allProducts.push(...picked);
        }
      } catch (e) {
        log(`   ❌ Lỗi: ${e.message?.slice(0, 80)}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (strategy === "bestseller") {
      allProducts.sort((a, b) =>
        ((b.sold || 0) - (a.sold || 0)) ||
        ((b.commissionRate || 0) - (a.commissionRate || 0))
      );
      return allProducts.slice(0, productsPerCat);
    }
    return allProducts;
  }
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────

let _instance = null;

export function getShopeeAffiliate() {
  if (!_instance) _instance = new ShopeeAffiliate();
  return _instance;
}

export { CATEGORIES, LIST_TYPE, closeCdpBrowser };
export default ShopeeAffiliate;
