/**
 * DAILY REELS RUN — 3 Reels per FB page/day for audience building.
 *
 * Schedule: 3 slots/day (VN time):
 *   Slot 1 (sáng):  06:00 – 06:30
 *   Slot 2 (trưa):  11:30 – 12:00
 *   Slot 3 (chiều): 18:00 – 18:30
 *
 * Auto-detect: when run WITHOUT --schedule-at, picks the NEXT upcoming
 * slot based on current VN time. If all 3 slots have passed today, picks
 * slot 1 tomorrow morning.
 *
 * Usage:
 *   node src/daily-reels.mjs                          # auto-detect next slot
 *   node src/daily-reels.mjs --schedule-at 19:00      # manual override
 *   node src/daily-reels.mjs --schedule-end 19:15     # manual window end
 *   node src/daily-reels.mjs --skip-page shopee,tech  # skip specific pages
 *
 * TikTok Tuệ Đàm is run separately (pipeline-quotes-veo.js).
 * Shopee product reup (daily.mjs) stays intact for later use.
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

const SKIP_PAGES = (arg("--skip-page", "") || "").split(",").filter(Boolean);

// ── 3-slot schedule (VN time) ─────────────────────────────────────────────
// Each slot: [startHH:MM, endHH:MM, label]
const SLOTS = [
  ["6:00",  "6:30",  "sáng"],
  ["11:30", "12:00", "trưa"],
  ["18:00", "18:30", "chiều"],
];

/**
 * Auto-detect next upcoming slot. If --schedule-at is provided, use that
 * instead (manual override). Returns { start, end, label }.
 */
function pickNextSlot() {
  const manualAt = arg("--schedule-at");
  if (manualAt) {
    return {
      start: manualAt,
      end: arg("--schedule-end") || addMinutes(manualAt, 30),
      label: "manual",
    };
  }
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const [start, end, label] of SLOTS) {
    const [sh, sm] = start.split(":").map(Number);
    const slotMinutes = sh * 60 + (sm || 0);
    // Pick this slot if it hasn't started yet (with 5-min grace for processing)
    if (nowMinutes < slotMinutes - 5) {
      return { start, end, label };
    }
  }
  // All slots passed today → pick first slot tomorrow (sáng)
  return { start: SLOTS[0][0], end: SLOTS[0][1], label: SLOTS[0][2] + " (mai)" };
}

function addMinutes(timeStr, mins) {
  const [h, m] = timeStr.split(":").map(Number);
  const total = h * 60 + (m || 0) + mins;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const SLOT = pickNextSlot();
const SCHEDULE_AT = SLOT.start;
const SCHEDULE_END = SLOT.end;

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
  log("║     DAILY REELS — 8 FB Pages (1 Reel each)      ║");
  log("╚══════════════════════════════════════════════════╝");
  log(`📅 Slot: ${SLOT.label} | ${SCHEDULE_AT}–${SCHEDULE_END} VN (base=+${baseDelay}m, stagger=${stagger.toFixed(1)}m)`);
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
