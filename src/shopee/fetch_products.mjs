/**
 * FETCH SHOPEE PRODUCTS — Dùng Chrome thật (không headless) để bypass anti-bot
 *
 * Mở Chrome window nhỏ → navigate tới Shopee Affiliate → fetch API → save cache
 * Chạy trước reup.mjs để refresh product cache.
 *
 * Usage:
 *   node src/shopee/fetch_products.mjs              # Fetch all categories
 *   node src/shopee/fetch_products.mjs --cats 100637,100640  # Specific cats
 */

import { spawn, spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";

const CHROME = process.env.CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CHROME_PROFILE = "D:/tiktok/data/shopee/chrome_fetch";
const COOKIE_FILE = "D:/tiktok/config/shopee_cookie.txt";
const CACHE_FILE = "D:/tiktok/data/shopee/products_cache.json";
const CDP_PORT = 9398;
const API_BASE = "https://affiliate.shopee.vn/api/v3";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCookie() {
  if (existsSync(COOKIE_FILE)) {
    try { return readFileSync(COOKIE_FILE, "utf8").trim(); } catch {}
  }
  return "";
}

// Kill any previous instance on our port
spawnSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${CDP_PORT}') do taskkill /F /PID %a 2>nul`,
  { shell: true, encoding: "utf8" });

mkdirSync(CHROME_PROFILE, { recursive: true });
mkdirSync("D:/tiktok/data/shopee", { recursive: true });

console.log("🚀 Launching Chrome (visible window)...");

// Launch Chrome WITH visible window (not headless) — bypasses anti-bot
const proc = spawn(
  `"${CHROME}"`,
  [
    "--disable-gpu", "--no-first-run",
    "--disable-blink-features=AutomationControlled",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--window-size=800,600",
    "--window-position=9999,9999", // off-screen
    "about:blank",
  ],
  { shell: true, detached: true, stdio: "ignore" }
);
proc.unref();

// Connect via CDP
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
      setTimeout(() => { ws.off("message", handler); rej(new Error("CDP timeout")); }, 30000);
    });
    console.log("✅ Chrome connected");
    break;
  } catch {}
}

if (!cdp) {
  console.error("❌ Chrome startup failed");
  process.exit(1);
}

// Hide automation + inject cookies
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: "Object.defineProperty(navigator, 'webdriver', { get: () => false });"
});
await cdp("Network.enable");

const cookie = getCookie();
if (cookie) {
  const pairs = cookie.split(";").map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    try {
      await cdp("Network.setCookie", {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        domain: ".shopee.vn", path: "/", secure: true,
      });
      await cdp("Network.setCookie", {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        domain: "affiliate.shopee.vn", path: "/", secure: true,
      });
    } catch {}
  }
  console.log(`🍪 Injected ${pairs.length} cookies`);
}

// Navigate to affiliate page
console.log("📡 Loading Shopee Affiliate...");
await cdp("Page.navigate", { url: "https://affiliate.shopee.vn/offer/product_offer" });
await sleep(5000);

// Check if page loaded
const titleResult = await cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true });
console.log("📄 Page:", titleResult?.result?.value);

// Fetch products from multiple categories
const ALL_CATS = [100630, 100632, 100633, 100635, 100636, 100637, 100638, 100639, 100640, 100641, 100642];
const args = process.argv.slice(2);
const catFilter = args.includes("--cats")
  ? args[args.indexOf("--cats") + 1].split(",").map(Number)
  : ALL_CATS;

const allProducts = [];

// Bestsellers
console.log("\n🔥 Fetching bestsellers...");
try {
  const result = await cdp("Runtime.evaluate", {
    expression: `(async () => {
      const r = await fetch("${API_BASE}/offer/product/list?list_type=2&sort_type=1&page_offset=0&page_limit=20&client_type=1", { credentials: "include" });
      return await r.text();
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  const data = JSON.parse(result?.result?.value);
  if (data.code === 0 && data.data?.list) {
    console.log(`   ✅ ${data.data.list.length} bestsellers`);
    for (const item of data.data.list) {
      allProducts.push({ ...item, _source: "bestseller" });
    }
  } else {
    console.log(`   ❌ code=${data.code} ${data.msg || ""}`);
  }
} catch (e) { console.log(`   ❌ ${e.message}`); }

// Per category
for (const catId of catFilter) {
  console.log(`📦 Category ${catId}...`);
  try {
    const result = await cdp("Runtime.evaluate", {
      expression: `(async () => {
        const r = await fetch("${API_BASE}/offer/product/list?list_type=0&match_type=2&match_id=${catId}&sort_type=1&page_offset=0&page_limit=20&client_type=1", { credentials: "include" });
        return await r.text();
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    const data = JSON.parse(result?.result?.value);
    if (data.code === 0 && data.data?.list) {
      console.log(`   ✅ ${data.data.list.length} products`);
      for (const item of data.data.list) {
        allProducts.push({ ...item, _source: `cat_${catId}` });
      }
    } else {
      console.log(`   ❌ code=${data.code} ${data.msg || ""}`);
    }
  } catch (e) { console.log(`   ❌ ${e.message}`); }
  await sleep(500);
}

// Deduplicate by item_id
const seen = new Set();
const unique = allProducts.filter(p => {
  if (seen.has(p.item_id)) return false;
  seen.add(p.item_id);
  return true;
});

// Save cache
const cache = {
  fetchedAt: new Date().toISOString(),
  totalRaw: allProducts.length,
  totalUnique: unique.length,
  categories: catFilter,
  products: unique,
};
writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
console.log(`\n${"=".repeat(50)}`);
console.log(`✅ Saved ${unique.length} unique products → ${CACHE_FILE}`);

// Cleanup
try { ws.close(); } catch {}
try { proc.kill(); } catch {}
spawnSync(`taskkill /F /PID ${proc.pid} 2>nul`, { shell: true });
