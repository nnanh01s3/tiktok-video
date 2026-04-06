/**
 * DAILY RUN — Chạy toàn bộ TikTok + Facebook pipeline 1 lần.
 *
 * Usage:
 *   node src/daily.mjs              # Chạy tất cả (TikTok + FB)
 *   node src/daily.mjs --fb-only    # Chỉ FB
 *   node src/daily.mjs --tt-only    # Chỉ TikTok
 *   node src/daily.mjs --skip-cache # Bỏ qua fetch_products (dùng cache hiện tại)
 *
 * Flow:
 *   1. TikTok Veo pipeline (song song với FB)
 *   2. Refresh Shopee cache nếu >4h (fetch_products.mjs → kill Chrome)
 *   3. 4 FB scripts song song (reup shopee/gia_dung/tech + fb_repost)
 *   4. Tổng kết kết quả
 */

import { spawn, execSync } from "child_process";
import { existsSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FB_ONLY = args.includes("--fb-only");
const TT_ONLY = args.includes("--tt-only");
const SKIP_CACHE = args.includes("--skip-cache");

// ── Config ────────────────────────────────────────────────────────────────
const CACHE_FILE = join(ROOT, "data/shopee/products_cache.json");
const CACHE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours

const FB_SCRIPTS = [
  { name: "shopee",   cmd: ["src/shopee/reup.mjs", "--page", "shopee", "--delay", "0"] },
  { name: "gia_dung", cmd: ["src/shopee/reup.mjs", "--page", "gia_dung", "--delay", "10"] },
  { name: "tech",     cmd: ["src/shopee/reup.mjs", "--page", "tech", "--delay", "20"] },
  { name: "fb_repost", cmd: ["src/shopee/fb_repost.mjs", "--max", "2", "--delay", "30"] },
];

// ── Helpers ───────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function isCacheFresh() {
  if (!existsSync(CACHE_FILE)) return false;
  const age = Date.now() - statSync(CACHE_FILE).mtimeMs;
  return age < CACHE_MAX_AGE;
}

/**
 * Chạy 1 Node script trong subprocess, trả về Promise.
 * Stream output realtime với prefix.
 */
function runScript(name, cmdArgs, { prefix = "", silent = false } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", cmdArgs, {
      cwd: ROOT,
      stdio: silent ? "pipe" : ["ignore", "pipe", "pipe"],
      shell: true,
    });

    const output = [];

    if (proc.stdout) {
      proc.stdout.on("data", (data) => {
        const lines = data.toString().trim();
        if (!silent && lines) {
          lines.split("\n").forEach(l => console.log(`  ${prefix}${l}`));
        }
        output.push(lines);
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data) => {
        const lines = data.toString().trim();
        if (!silent && lines) {
          lines.split("\n").forEach(l => console.log(`  ${prefix}⚠ ${l}`));
        }
      });
    }

    proc.on("close", (code) => {
      resolve({ name, code, output: output.join("\n") });
    });

    proc.on("error", (err) => {
      resolve({ name, code: 1, output: err.message });
    });
  });
}

function killChrome() {
  try {
    execSync("taskkill //F //IM chrome.exe", { stdio: "pipe", shell: true });
    log("   Killed Chrome processes");
  } catch {
    // No Chrome running — fine
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  log("╔══════════════════════════════════════════════════╗");
  log("║           DAILY RUN — TikTok + Facebook         ║");
  log("╚══════════════════════════════════════════════════╝");
  log("");

  const results = [];
  const tasks = [];

  // ── Step 1: TikTok Veo Pipeline (song song với FB) ──
  if (!FB_ONLY) {
    log("🎬 [TikTok] Starting Veo pipeline...");
    const ttTask = runScript("tiktok", ["src/pipeline-quotes-veo.js"], {
      prefix: "[TT] ",
    }).then((r) => {
      const ok = r.code === 0;
      log(`🎬 [TikTok] ${ok ? "✅ Done" : "❌ Failed"}`);
      results.push({ name: "TikTok", ok, ...r });
      return r;
    });
    tasks.push(ttTask);
  }

  // ── Step 2: FB Pipeline ──
  if (!TT_ONLY) {
    const fbTask = (async () => {
      // 2a. Refresh Shopee cache nếu cần
      if (!SKIP_CACHE && !isCacheFresh()) {
        log("🛒 [Cache] Refreshing Shopee product cache...");
        const cacheResult = await runScript("cache", ["src/shopee/fetch_products.mjs"], {
          prefix: "[Cache] ",
        });
        killChrome();
        if (cacheResult.code !== 0) {
          log("🛒 [Cache] ⚠ fetch_products failed, using existing cache");
        } else {
          log("🛒 [Cache] ✅ Cache refreshed");
        }
      } else if (SKIP_CACHE) {
        log("🛒 [Cache] Skipped (--skip-cache)");
      } else {
        log("🛒 [Cache] Fresh (<4h), skipping refresh");
      }

      // 2b. Kill any remaining Chrome before launching FB scripts
      killChrome();

      // 2c. Run 4 FB scripts in parallel
      log("📱 [Facebook] Starting 4 scripts...");
      log("");

      const fbResults = await Promise.all(
        FB_SCRIPTS.map((s) =>
          runScript(s.name, s.cmd, { prefix: `[${s.name}] ` }).then((r) => {
            const ok = r.code === 0;
            log(`📱 [${s.name}] ${ok ? "✅ Done" : "❌ Failed (code " + r.code + ")"}`);
            results.push({ name: s.name, ok, ...r });
            return r;
          })
        )
      );

      return fbResults;
    })();
    tasks.push(fbTask);
  }

  // ── Wait for everything ──
  await Promise.all(tasks);

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log("");
  log("╔══════════════════════════════════════════════════╗");
  log("║                    SUMMARY                      ║");
  log("╚══════════════════════════════════════════════════╝");

  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    // Extract video count from output
    const videoMatch = r.output.match(/Đăng (\d+)\/(\d+)/) || r.output.match(/Posted (\d+)\/(\d+)/);
    const videos = videoMatch ? `${videoMatch[1]} videos` : r.output.includes("Pipeline Complete") ? "1 video" : "0 videos";
    log(`  ${icon} ${r.name.padEnd(12)} ${videos}`);
  }

  const totalOk = results.filter(r => r.ok).length;
  const totalFail = results.filter(r => !r.ok).length;
  log("");
  log(`⏱ ${elapsed}s | ✅ ${totalOk} passed | ${totalFail > 0 ? `❌ ${totalFail} failed` : "All good!"}`);

  // Exit with error if any failed
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
