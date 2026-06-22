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
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const FB_ONLY = args.includes("--fb-only");
const TT_ONLY = args.includes("--tt-only");
const SKIP_CACHE = args.includes("--skip-cache");

// ── Absolute scheduling ─────────────────────────────────────────────────
// Usage: node src/daily.mjs --schedule-at 18:00 --schedule-end 18:45
//   → schedules FB videos evenly between 18:00 and 18:45 (VN local time)
//   Without these flags, videos are scheduled immediately with short delays.
const SCHEDULE_AT = arg("--schedule-at");   // "HH:MM" local time
const SCHEDULE_END = arg("--schedule-end"); // "HH:MM" local time (default: +45min)

function minutesUntil(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m || 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.max(0, Math.round((target - now) / 60000));
}

// ── Config ────────────────────────────────────────────────────────────────
const CACHE_FILE = join(ROOT, "data/shopee/products_cache.json");
const CACHE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 hours

// Each script posts 1 video per run (MAX_PER_RUN=1 in config.mjs).
// 9 FB scripts total (8 shop pages + 1 fb_repost from Đồ Độc Lạ).
//
// Scheduling modes:
//   --schedule-at 18:00 --schedule-end 18:45
//     → absolute: videos land at 18:00, 18:05, 18:10, ..., 18:40 VN time
//     → stagger auto-computed: window / (N-1)
//   No flags → immediate: 0-12 min from now (legacy behavior)
const FB_SCRIPT_DEFS = [
  { name: "shopee",     base: ["src/shopee/reup.mjs", "--page", "shopee"] },
  { name: "gia_dung",   base: ["src/shopee/reup.mjs", "--page", "gia_dung"] },
  { name: "tech",       base: ["src/shopee/reup.mjs", "--page", "tech"] },
  { name: "sac_dep",    base: ["src/shopee/reup.mjs", "--page", "sac_dep"] },
  { name: "thoi_trang", base: ["src/shopee/reup.mjs", "--page", "thoi_trang"] },
  { name: "me_be",      base: ["src/shopee/reup.mjs", "--page", "me_be"] },
  { name: "the_thao",   base: ["src/shopee/reup.mjs", "--page", "the_thao"] },
  { name: "bach_hoa",   base: ["src/shopee/reup.mjs", "--page", "bach_hoa"] },
  { name: "fb_repost",  base: ["src/shopee/fb_repost.mjs", "--max", "1"] },
];

const IMMEDIATE_STAGGERS = [0, 2, 3, 4, 5, 7, 8, 10, 12];

const FB_SCRIPTS = (() => {
  const n = FB_SCRIPT_DEFS.length;
  if (SCHEDULE_AT) {
    const baseDelay = minutesUntil(SCHEDULE_AT);
    const endDelay = SCHEDULE_END ? minutesUntil(SCHEDULE_END) : baseDelay + 45;
    const window = endDelay - baseDelay;
    const stagger = n > 1 ? window / (n - 1) : 0;
    return FB_SCRIPT_DEFS.map((def, i) => ({
      name: def.name,
      cmd: [...def.base, "--delay", String(Math.round(baseDelay + i * stagger))],
    }));
  }
  return FB_SCRIPT_DEFS.map((def, i) => ({
    name: def.name,
    cmd: [...def.base, "--delay", String(IMMEDIATE_STAGGERS[i] || 0)],
  }));
})();

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
    // TikTok delay: place it in the middle of the schedule window so it
    // doesn't always be the first or last post. With 9 FB scripts, TikTok
    // gets the slot right after the 5th FB page (~halfway through window).
    const ttDelayMin = SCHEDULE_AT
      ? Math.round(minutesUntil(SCHEDULE_AT) + (SCHEDULE_END ? (minutesUntil(SCHEDULE_END) - minutesUntil(SCHEDULE_AT)) / 2 : 22))
      : 1; // immediate mode: 1 min
    log(`🎬 [TikTok] Starting Veo pipeline... (schedule delay=${ttDelayMin}m)`);
    const ttTask = runScript("tiktok", ["src/pipeline-quotes-veo.js", `--delay=${ttDelayMin}`], {
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
