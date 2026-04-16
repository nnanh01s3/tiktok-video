/**
 * DAILY REELS RUN — 1 Reel per FB page/day for audience building.
 *
 * Strategy (per user decision):
 *   - Goal: build audience FIRST, sell later
 *   - 8 FB pages × 1 Reel/page/day = 8 Reels scheduled
 *   - Post time: 18:30 VN (peak engagement per research)
 *   - Source: rotated from reels-config.mjs (TikTok + Facebook creators)
 *
 * Usage:
 *   node src/daily-reels.mjs                          # schedule at 18:30 today (or tomorrow)
 *   node src/daily-reels.mjs --schedule-at 19:00      # custom post time
 *   node src/daily-reels.mjs --schedule-end 19:15     # custom window end
 *   node src/daily-reels.mjs --skip-page shopee,tech  # skip specific pages
 *
 * Note: Shopee product reup (daily.mjs) stays intact for later use.
 * This orchestrator is separate — run it alongside or instead of daily.mjs
 * depending on your current growth phase.
 */
import "./env.js";
import { spawn, execSync } from "child_process";
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

// Default: post at 18:30 VN today. Window ends 18:45 (15 min for 8 pages).
const SCHEDULE_AT = arg("--schedule-at", "18:30");
const SCHEDULE_END = arg("--schedule-end", "18:45");
const SKIP_PAGES = (arg("--skip-page", "") || "").split(",").filter(Boolean);

function minutesUntil(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m || 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.max(0, Math.round((target - now) / 60000));
}

// ── Pages with Reels sources ──────────────────────────────────────────────
// Order matters: earlier pages post first. Shuffle or customize if needed.
const REEL_PAGES = [
  "shopee",
  "gia_dung",
  "tech",
  "sac_dep",
  "thoi_trang",
  "me_be",
  "the_thao",
  "bach_hoa",
].filter((p) => !SKIP_PAGES.includes(p));

// Compute stagger across window
const baseDelay = minutesUntil(SCHEDULE_AT);
const endDelay = minutesUntil(SCHEDULE_END);
const windowMin = endDelay - baseDelay;
const n = REEL_PAGES.length;
const stagger = n > 1 ? windowMin / (n - 1) : 0;

// ── Helpers ───────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function runScript(name, cmdArgs, { prefix = "" } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("node", cmdArgs, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    const output = [];
    if (proc.stdout) proc.stdout.on("data", (d) => {
      const s = d.toString().trim();
      if (s) { s.split("\n").forEach((l) => console.log(`  ${prefix}${l}`)); output.push(s); }
    });
    if (proc.stderr) proc.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) s.split("\n").forEach((l) => console.log(`  ${prefix}⚠ ${l}`));
    });
    proc.on("close", (code) => resolve({ name, code, output: output.join("\n") }));
    proc.on("error", (err) => resolve({ name, code: 1, output: err.message }));
  });
}

function killChrome() {
  try {
    execSync("taskkill //F //IM chrome.exe", { stdio: "pipe", shell: true });
    log("   Killed Chrome processes");
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  log("╔══════════════════════════════════════════════════╗");
  log("║        DAILY REELS — 8 FB Pages (1 Reel each)   ║");
  log("╚══════════════════════════════════════════════════╝");
  log(`📅 Schedule: ${SCHEDULE_AT}–${SCHEDULE_END} VN (base=+${baseDelay}m, stagger=${stagger.toFixed(1)}m)`);
  log(`📱 Pages: ${REEL_PAGES.join(", ")}`);
  log("");

  // Pre-kill Chrome to avoid CDP port conflicts (Facebook scrapes launch Chrome)
  killChrome();

  // Schedule each Reels script in parallel (like daily.mjs FB_SCRIPTS).
  // Each reels.mjs launches its own Chrome if source is Facebook (CDP scrape),
  // or uses yt-dlp directly if source is TikTok. Parallel is fine because
  // each worker uses a unique CDP port (9400 + random).
  const results = [];
  const promises = REEL_PAGES.map((page, i) => {
    const delay = Math.round(baseDelay + i * stagger);
    return runScript(page, [
      "src/shopee/reels.mjs",
      "--page", page,
      "--delay", String(delay),
      "--max", "1",
    ], { prefix: `[${page}] ` }).then((r) => {
      const ok = r.code === 0;
      log(`📱 [${page}] ${ok ? "✅ Done" : "❌ Failed (code " + r.code + ")"}`);
      results.push({ name: page, ok, ...r });
      return r;
    });
  });

  await Promise.all(promises);

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log("");
  log("╔══════════════════════════════════════════════════╗");
  log("║                    SUMMARY                      ║");
  log("╚══════════════════════════════════════════════════╝");
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    const posted = r.output.match(/Posted (\d+)\/(\d+)/);
    const n = posted ? `${posted[1]} Reel${posted[1] === "1" ? "" : "s"}` : "0 Reels";
    log(`  ${icon} ${r.name.padEnd(12)} ${n}`);
  }

  const totalOk = results.filter((r) => r.ok).length;
  const totalFail = results.filter((r) => !r.ok).length;
  log("");
  log(`⏱ ${elapsed}s | ✅ ${totalOk} passed | ${totalFail > 0 ? `❌ ${totalFail} failed` : "All good!"}`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
