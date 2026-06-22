/**
 * Driver: schedule Shopee bestseller posts across 5 pages between 18:00-18:24 today.
 *
 * Each page runs reup.mjs sequentially with a recomputed --delay based on the
 * current time at the moment that iteration starts. This compensates for the
 * 1-5 min compute per page (image prep + Veo or Ken Burns + upload).
 *
 * Empty pages (me_be, the_thao, bach_hoa) are dry-run-logged only — their
 * cache has no overlap with the CSV short-link export, so they would skip.
 *
 * Run: node scripts/schedule-shopee-evening.mjs
 */
import { spawnSync } from "child_process";

// (page, "HH:MM" target time today)
const SCHEDULE = [
  ["shopee",     "18:00"],
  ["gia_dung",   "18:06"],
  ["tech",       "18:12"],
  ["sac_dep",    "18:18"],
  ["thoi_trang", "18:24"],
];

// Pages we know are empty/can't post — log only, don't waste time
const EMPTY_PAGES = ["me_be", "the_thao", "bach_hoa"];

function todayAt(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function delayMinutes(target) {
  return Math.max(1, Math.round((target.getTime() - Date.now()) / 60_000));
}

function fmtTime(d) {
  return d.toTimeString().slice(0, 5);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("  SHOPEE EVENING SCHEDULER  —  18:00–18:24 today");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`Started at ${new Date().toLocaleString("vi-VN")}\n`);

for (const [page, hhmm] of SCHEDULE) {
  const target = todayAt(hhmm);
  const delay = delayMinutes(target);

  console.log("───────────────────────────────────────────────────────────────");
  console.log(`▶ Page: ${page}  |  target=${hhmm}  |  delay=${delay} min  |  now=${fmtTime(new Date())}`);
  console.log("───────────────────────────────────────────────────────────────");

  const r = spawnSync(
    "node",
    ["src/shopee/reup.mjs", "--page", page, "--delay", String(delay)],
    { stdio: "inherit", shell: false }
  );

  if (r.status !== 0) {
    console.log(`⚠️  ${page} exited with code ${r.status}`);
  }
  console.log("");
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("  EMPTY PAGES (no CSV overlap — diagnostic only)");
console.log("═══════════════════════════════════════════════════════════════");
for (const page of EMPTY_PAGES) {
  console.log(`\n▶ ${page} (dry-run)`);
  spawnSync(
    "node",
    ["src/shopee/reup.mjs", "--page", page, "--dry-run"],
    { stdio: "inherit", shell: false }
  );
}

console.log("\n═══════════════════════════════════════════════════════════════");
console.log(`  Scheduler finished at ${new Date().toLocaleString("vi-VN")}`);
console.log("═══════════════════════════════════════════════════════════════");
