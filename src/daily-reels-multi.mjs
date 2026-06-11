/**
 * MULTI-DAY REELS PRE-SCHEDULE — pre-schedule N future days of Reels for when away.
 *
 * Schedules N days × 4 slots × 8 pages = 32N Reels in a single run. Videos are
 * uploaded to CDN (data.postforme.dev) immediately and FB Scheduled API stores
 * the publish time. Once this script exits, the machine can be turned off —
 * FB will publish posts at the scheduled times.
 *
 * Schedule (VN time, applies to each of N days starting TOMORROW):
 *   Slot 1 (sáng):  06:00 – 06:30
 *   Slot 2 (trưa):  11:00 – 11:30
 *   Slot 3 (chiều): 17:00 – 17:30
 *   Slot 4 (tối):   21:00 – 21:30
 *
 * Execution: slot-by-slot serial (8 pages parallel within each slot), with
 * Round 2 auto-retry for misses. Total runtime ~ N × 30-60 min.
 *
 * Usage:
 *   node src/daily-reels-multi.mjs --days 5                       # 5 days starting tomorrow
 *   node src/daily-reels-multi.mjs --days 2 --from 2026-05-23     # Sat-Sun only
 *   node src/daily-reels-multi.mjs --days 7 --dry-run             # preview
 *   node src/daily-reels-multi.mjs --days 3 --skip-page gia_dung
 *
 * For TODAY's remaining slots, run `node src/daily-reels.mjs` separately.
 */
import "./env.js";
import { spawn, execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, existsSync, appendFileSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function flag(name) {
  return args.includes(name);
}

const DAYS = parseInt(arg("--days"), 10);
const FROM_DATE = arg("--from"); // YYYY-MM-DD; default = tomorrow
const DRY_RUN = flag("--dry-run");
const SKIP_PAGES = (arg("--skip-page", "") || "").split(",").filter(Boolean);

if (!Number.isFinite(DAYS) || DAYS < 1 || DAYS > 30) {
  console.error("Usage: node src/daily-reels-multi.mjs --days N (required, 1-30)");
  console.error("  Optional: --from YYYY-MM-DD     start date (default: tomorrow)");
  console.error("  Optional: --dry-run             preview without uploading");
  console.error("  Optional: --skip-page p1,p2     skip specific pages");
  process.exit(1);
}

/**
 * Compute starting day offset from today.
 *   default → 1 (tomorrow)
 *   --from YYYY-MM-DD → integer days from today (0 = today, 1 = tomorrow, ...)
 * Past dates rejected; today allowed (past slots within day auto-skip via baseDelay=0).
 */
function getStartDayOffset() {
  if (!FROM_DATE) return 1;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM_DATE)) {
    console.error(`Invalid --from date "${FROM_DATE}". Use YYYY-MM-DD.`);
    process.exit(1);
  }
  const from = new Date(`${FROM_DATE}T00:00:00`);
  if (Number.isNaN(from.getTime())) {
    console.error(`Invalid --from date "${FROM_DATE}".`);
    process.exit(1);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const offset = Math.round((from - today) / (24 * 60 * 60 * 1000));
  if (offset < 0) {
    console.error(`--from date "${FROM_DATE}" is in the past.`);
    process.exit(1);
  }
  if (offset + DAYS > 31) {
    console.error(`--from + --days exceeds 30-day FB scheduling guard.`);
    process.exit(1);
  }
  return offset;
}

const START_DAY = getStartDayOffset();

// ── 5-slot schedule (VN time) — MUST match daily-reels.mjs (23h added 2026-06-11) ──
const SLOTS = [
  ["6:00",  "6:30",  "sáng"],
  ["11:00", "11:30", "trưa"],
  ["17:00", "17:30", "chiều"],
  ["21:00", "21:30", "tối"],
  ["23:00", "23:30", "đêm"],
];

const REEL_PAGES = [
  "shopee", "gia_dung", "tech", "sac_dep",
  "thoi_trang", "me_be", "the_thao", "bach_hoa",
].filter((p) => !SKIP_PAGES.includes(p));

// ── Helpers ───────────────────────────────────────────────────────────────
function vnTs() {
  return new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}
function logC(msg) {
  console.log(`[${vnTs()}] ${msg}`);
}

/**
 * Kill ONLY pipeline Chromes — leave user's regular browser alone.
 * Matches: --user-data-dir pointing to tiktok\data\shopee, OR automation
 * launcher Chrome (--disable-blink-features=AutomationControlled, no --type).
 */
function killPipelineChrome() {
  try {
    const ps =
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | " +
      "Where-Object { ($_.CommandLine -match 'tiktok\\\\data\\\\shopee') -or " +
      "($_.CommandLine -match 'disable-blink-features=Automatio' -and $_.CommandLine -notmatch '--type=') } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "pipe", shell: true });
  } catch {}
}

function cleanChromeTmp() {
  try {
    execSync("rm -rf data/shopee/reels/*/chrome_tmp_* 2>/dev/null", { stdio: "pipe", shell: true });
  } catch {}
}

/**
 * Kill any Chrome whose --user-data-dir points to data\shopee\reels\<page>\.
 * Called immediately after a worker for that page exits — even if reels.mjs
 * cleaned up its own Chromes via process.on('exit'), this is a belt-and-
 * suspenders safety net for races (e.g. shell wrapper PID confusion,
 * SIGKILL of the worker before its exit handler fires).
 */
function killChromeForPage(page) {
  try {
    // PS regex `\\` matches literal `\`; JS template `\\\\` = string `\\` = PS regex `\\`
    const ps =
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | " +
      `Where-Object { $_.CommandLine -match 'reels\\\\${page}\\\\' } | ` +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "pipe", timeout: 8000 });
  } catch {}
}

/**
 * Sweep stale Chromes by chrome_tmp_<timestamp> age. Anything older than
 * maxAgeSec seconds is considered orphaned (active FB scrapes complete in
 * ~40s; threshold 90s gives generous margin for slow scrolls/large pages).
 *
 * Runs on an interval throughout main() to catch any Chromes that slip past
 * both reels.mjs cleanup AND killChromeForPage (e.g. parent worker died
 * before spawning Chrome but Chrome started anyway).
 */
function sweepStaleChromes(maxAgeSec = 90) {
  try {
    const cutoffMs = Date.now() - maxAgeSec * 1000;
    // PS Where-Object: inline `if` keeps $Matches in the same pipeline scope
    // so the regex capture is reliably bound when the comparison runs.
    const ps =
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | " +
      `Where-Object { if ($_.CommandLine -match 'chrome_tmp_(\\d+)') { [int64]$Matches[1] -lt ${cutoffMs} } else { $false } } | ` +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "pipe", timeout: 8000 });
  } catch {}
}

function runWorker(page, delayMin, logFile) {
  return new Promise((resolve) => {
    const proc = spawn("node", [
      "src/shopee/reels.mjs",
      "--page", page,
      "--delay", String(delayMin),
      "--max", "1",
    ], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    const outputLines = [];
    proc.stdout?.on("data", (d) => {
      d.toString().split("\n").forEach((l) => {
        if (l.trim()) {
          try { appendFileSync(logFile, `[${page}] ${l}\n`); } catch {}
          outputLines.push(l);
        }
      });
    });
    proc.stderr?.on("data", (d) => {
      d.toString().split("\n").forEach((l) => {
        if (l.trim()) {
          try { appendFileSync(logFile, `[${page}] ⚠ ${l}\n`); } catch {}
        }
      });
    });
    proc.on("close", (code) => resolve({ page, code, output: outputLines.join("\n") }));
    proc.on("error", (err) => resolve({ page, code: 1, output: err.message }));
  });
}

/**
 * Compute base/end delay (minutes from now) for a (dayOffset, slot) target.
 */
function computeDelays(dayOffset, slotStart, slotEnd) {
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + dayOffset);
  const [sh, sm] = slotStart.split(":").map(Number);
  target.setHours(sh, sm || 0, 0, 0);

  const endTarget = new Date(target);
  const [eh, em] = slotEnd.split(":").map(Number);
  endTarget.setHours(eh, em || 0, 0, 0);

  const baseDelay = Math.max(0, Math.round((target - now) / 60000));
  const endDelay = Math.max(0, Math.round((endTarget - now) / 60000));
  return { baseDelay, endDelay, target, endTarget };
}

async function runSlot(dayOffset, slotStart, slotEnd, slotLabel, dateStr, logFile) {
  const { baseDelay, endDelay } = computeDelays(dayOffset, slotStart, slotEnd);
  const windowMin = endDelay - baseDelay;
  const n = REEL_PAGES.length;
  const stagger = n > 1 ? windowMin / (n - 1) : 0;

  appendFileSync(
    logFile,
    `=== ${dateStr} | slot ${slotLabel} ${slotStart}-${slotEnd} ` +
    `(base=+${baseDelay}m, stagger=${stagger.toFixed(1)}m) at ${vnTs()} ===\n`
  );

  // ── Round 1 ──
  killPipelineChrome();
  // Per-page kill in the promise chain: when a worker resolves we know its
  // node process has exited, so any Chrome with that page's profile dir is
  // an orphan. Fires inline before resolve propagates upward.
  const round1Promises = REEL_PAGES.map((page, i) => {
    const delay = Math.round(baseDelay + i * stagger);
    return runWorker(page, delay, logFile).then((r) => {
      killChromeForPage(page);
      return r;
    });
  });
  const round1 = await Promise.all(round1Promises);

  const misses = round1.filter((r) => /Posted 0\//.test(r.output)).map((r) => r.page);
  appendFileSync(logFile, `=== Round 1 done. Misses: ${misses.length ? misses.join(", ") : "none"} ===\n`);

  // ── Round 2 retry (FB schedule still within slot end + 5min) ──
  let stillMissed = [];
  if (misses.length) {
    killPipelineChrome();
    const retryBase = endDelay + 5;
    const round2Promises = misses.map((page, i) =>
      runWorker(page, retryBase + i * 3, logFile).then((r) => {
        killChromeForPage(page);
        return r;
      })
    );
    const round2 = await Promise.all(round2Promises);
    stillMissed = round2.filter((r) => /Posted 0\//.test(r.output)).map((r) => r.page);
    appendFileSync(
      logFile,
      `=== Round 2 done. Still missed: ${stillMissed.length ? stillMissed.join(", ") : "none"} ===\n`
    );
  }

  // End-of-slot sweep — during multi-day runs we can sit between slots for
  // hours. Without this, ~20-30 Chromes from each slot stay resident the
  // whole interval, accumulating RAM. The slot-start kill at line 199 only
  // cleans up right before the NEXT slot; this kills now so the box stays
  // quiet during the long wait.
  killPipelineChrome();
  cleanChromeTmp();

  return { posted: n - stillMissed.length, total: n, missed: stillMissed };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const logsDir = join(ROOT, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  const totalSlots = SLOTS.length * DAYS;
  const totalReels = REEL_PAGES.length * totalSlots;

  // Date label for header
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() + START_DAY);
  const endDateObj = new Date();
  endDateObj.setDate(endDateObj.getDate() + START_DAY + DAYS - 1);
  const dateRange = DAYS === 1
    ? startDateObj.toISOString().slice(0, 10)
    : `${startDateObj.toISOString().slice(0, 10)} → ${endDateObj.toISOString().slice(0, 10)}`;

  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║         MULTI-DAY REELS PRE-SCHEDULE              ║");
  console.log("╚════════════════════════════════════════════════════╝");
  console.log(`📅 Days:   ${DAYS} (${dateRange})`);
  console.log(`🎬 Slots:  ${SLOTS.length}/day × ${REEL_PAGES.length} pages = ${REEL_PAGES.length * SLOTS.length}/day`);
  console.log(`📊 Total:  ${totalReels} Reels to pre-schedule`);
  console.log(`📱 Pages:  ${REEL_PAGES.join(", ")}`);
  if (SKIP_PAGES.length) console.log(`⏭️  Skip:   ${SKIP_PAGES.join(", ")}`);
  console.log("");

  // ── DRY RUN: preview only ──
  if (DRY_RUN) {
    console.log("── DRY-RUN PREVIEW ──");
    for (let d = START_DAY; d < START_DAY + DAYS; d++) {
      const dateObj = new Date();
      dateObj.setDate(dateObj.getDate() + d);
      const dateStr = dateObj.toISOString().slice(0, 10);
      for (const [start, end, label] of SLOTS) {
        const { baseDelay, endDelay } = computeDelays(d, start, end);
        console.log(
          `  ${dateStr} ${label.padEnd(7)} ${start}-${end}  ` +
          `base=+${baseDelay}m  end=+${endDelay}m  ` +
          `(${REEL_PAGES.length} pages)`
        );
      }
    }
    console.log("");
    console.log(`Would pre-schedule ${totalReels} Reels. Run without --dry-run to execute.`);
    return;
  }

  // ── REAL RUN ──
  // Periodic Chrome sweeper: belt-and-suspenders safety net for any leaks
  // that escape both reels.mjs cleanup AND killChromeForPage. Runs every 60s
  // for the whole run; threshold 90s ensures we don't kill an active scrape
  // (FB scrapes complete in ~40s).
  const sweepInterval = setInterval(() => sweepStaleChromes(90), 60_000);

  let slotIdx = 0;
  const summary = [];

  for (let d = START_DAY; d < START_DAY + DAYS; d++) {
    const dateObj = new Date();
    dateObj.setDate(dateObj.getDate() + d);
    const dateStr = dateObj.toISOString().slice(0, 10);

    for (const [start, end, label] of SLOTS) {
      slotIdx++;
      const logFile = join(logsDir, `multi-day-${dateStr}-${label}.log`);
      writeFileSync(logFile, ""); // truncate

      logC(`━━━ [${slotIdx}/${totalSlots}] ${dateStr} ${label} ${start}-${end} ━━━`);
      logC(`    Log: ${logFile}`);

      const result = await runSlot(d, start, end, label, dateStr, logFile);
      summary.push({ dateStr, label, ...result });

      const icon = result.posted === result.total ? "✅" : result.posted > 0 ? "⚠️" : "❌";
      logC(`    ${icon} ${result.posted}/${result.total} posted` +
           (result.missed.length ? ` | miss: ${result.missed.join(",")}` : ""));
    }
  }

  // ── Final cleanup ──
  clearInterval(sweepInterval);
  killPipelineChrome();
  cleanChromeTmp();

  // ── Summary ──
  const elapsedMin = Math.round((Date.now() - startTime) / 1000 / 60);
  console.log("");
  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║                  FINAL SUMMARY                    ║");
  console.log("╚════════════════════════════════════════════════════╝");

  const totalPosted = summary.reduce((s, r) => s + r.posted, 0);
  for (const r of summary) {
    const icon = r.posted === r.total ? "✅" : r.posted > 0 ? "⚠️" : "❌";
    console.log(
      `  ${icon} ${r.dateStr} ${r.label.padEnd(7)} ${r.posted}/${r.total}` +
      (r.missed.length ? `  (miss: ${r.missed.join(",")})` : "")
    );
  }
  console.log("");
  console.log(`📊 Total: ${totalPosted}/${totalReels} Reels pre-scheduled`);
  console.log(`⏱️  Runtime: ${elapsedMin} min`);
  console.log("");
  console.log("✅ Safe to turn off machine — FB will publish at scheduled times.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
