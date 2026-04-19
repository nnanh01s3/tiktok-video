/**
 * Reels analytics — quick review of posted_reels state.
 *
 * Usage:
 *   node scripts/reels-analytics.mjs                    # today (VN time)
 *   node scripts/reels-analytics.mjs --date 2026-04-20  # specific day
 *   node scripts/reels-analytics.mjs --since 2026-04-19 # from date to now
 *   node scripts/reels-analytics.mjs --all              # lifetime
 *
 * Reports:
 *   1. Per-page count + smallest/largest/avg size + avg topic score
 *   2. Size distribution (flags borderline <2.5MB, fail-risk <2.0MB)
 *   3. Topic score distribution (low-confidence passes as early warning)
 *   4. Source performance (which sources posted most / highest scores)
 *   5. Day-over-day comparison (if range > 1 day)
 */
import "../src/env.js";
import { getDb } from "../src/db.js";

// ── Parse args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const dateArg = arg("--date");
const sinceArg = arg("--since");
const all = argv.includes("--all");

// Default: today in VN
function todayVN() {
  const d = new Date();
  const vn = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  return vn.toISOString().slice(0, 10);
}

let whereClause, whereParams, label;
if (all) {
  whereClause = "";
  whereParams = [];
  label = "ALL TIME";
} else if (sinceArg) {
  whereClause = "WHERE posted_at >= ?";
  whereParams = [sinceArg + "T00:00:00Z"];
  label = `since ${sinceArg}`;
} else {
  const day = dateArg || todayVN();
  // VN day = UTC day starting from 17:00 UTC previous day through 16:59 UTC of day
  // But posted_at is UTC ISO. For simplicity, match UTC day (close enough for this tool)
  whereClause = "WHERE posted_at LIKE ?";
  whereParams = [day + "%"];
  label = dateArg || `today (${day}, VN)`;
}

const db = getDb();

// ── Helper: only new-pipeline entries (non-legacy) ────────────────────────
const NON_LEGACY = "(source_name IS NOT ? OR source_name IS NULL)";
const NON_LEGACY_PARAM = "legacy_migration";

function q(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function h1(title) {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}

function h2(title) {
  console.log("\n── " + title + " " + "─".repeat(Math.max(3, 68 - title.length)));
}

// ── Report 1: Per-page summary ────────────────────────────────────────────
h1(`Reels analytics — ${label}`);

h2("Per-page summary");
const perPage = q(
  `SELECT page_name,
          COUNT(*) as n,
          ROUND(AVG(file_size_mb), 1) as avg_mb,
          MIN(file_size_mb) as min_mb,
          MAX(file_size_mb) as max_mb,
          ROUND(AVG(topic_score), 2) as avg_score,
          COUNT(CASE WHEN file_size_mb < 2.0 THEN 1 END) as fail_risk,
          COUNT(CASE WHEN file_size_mb >= 2.0 AND file_size_mb < 2.5 THEN 1 END) as borderline
   FROM posted_reels
   ${whereClause ? whereClause + " AND " : "WHERE "} ${NON_LEGACY}
   GROUP BY page_name
   ORDER BY n DESC`,
  [...whereParams, NON_LEGACY_PARAM]
);

if (perPage.length === 0) {
  console.log("  (no posts in this range — have you run reels.mjs with the new code?)");
} else {
  console.table(perPage);
}

// ── Report 2: Fail-risk posts (<2.0MB — should have been skipped) ─────────
h2("Fail-risk posts (<2.0MB — should have been skipped by 2MB rule)");
const failRisk = q(
  `SELECT page_name, source_name,
          ROUND(file_size_mb, 1) as mb,
          video_duration as sec,
          SUBSTR(video_title, 1, 60) as title_snippet,
          pfm_post_id,
          posted_at
   FROM posted_reels
   ${whereClause ? whereClause + " AND " : "WHERE "} file_size_mb < 2.0
     AND ${NON_LEGACY}
   ORDER BY file_size_mb ASC`,
  [...whereParams, NON_LEGACY_PARAM]
);

if (failRisk.length === 0) {
  console.log("  ✅ None — new threshold working as expected.");
} else {
  console.table(failRisk);
  console.log(`  ⚠ ${failRisk.length} posts under the 2MB bar — check FB for playback failures.`);
}

// ── Report 3: Borderline posts (2.0-2.5MB) ────────────────────────────────
h2("Borderline posts (2.0-2.5MB — watch for playback issues)");
const border = q(
  `SELECT page_name, source_name,
          ROUND(file_size_mb, 1) as mb,
          video_duration as sec,
          SUBSTR(video_title, 1, 50) as title_snippet,
          pfm_post_id
   FROM posted_reels
   ${whereClause ? whereClause + " AND " : "WHERE "} file_size_mb >= 2.0 AND file_size_mb < 2.5
     AND ${NON_LEGACY}
   ORDER BY file_size_mb ASC`,
  [...whereParams, NON_LEGACY_PARAM]
);

if (border.length === 0) {
  console.log("  (none)");
} else {
  console.table(border);
}

// ── Report 4: Topic score distribution ────────────────────────────────────
h2("Topic score distribution (confidence of classifier)");
const scoreDist = q(
  `SELECT
     CASE
       WHEN topic_score >= 0.9 THEN '0.90-1.00 strong'
       WHEN topic_score >= 0.8 THEN '0.80-0.89 good  '
       WHEN topic_score >= 0.7 THEN '0.70-0.79 pass  '
       WHEN topic_score >= 0.5 THEN '0.50-0.69 fail-open'
       WHEN topic_score IS NULL THEN '(null — legacy)'
       ELSE '<0.50 anomaly'
     END as band,
     COUNT(*) as n
   FROM posted_reels
   ${whereClause ? whereClause + " AND " : "WHERE "} ${NON_LEGACY}
   GROUP BY band
   ORDER BY band DESC`,
  [...whereParams, NON_LEGACY_PARAM]
);

if (scoreDist.length === 0) {
  console.log("  (no scored entries)");
} else {
  console.table(scoreDist);
}

// ── Report 5: Low-confidence passes (score 0.7-0.79 = borderline accept) ──
h2("Low-confidence accepts (score 0.5-0.79 — classifier uncertain)");
const lowConf = q(
  `SELECT page_name, source_name,
          ROUND(topic_score, 2) as score,
          SUBSTR(video_title, 1, 60) as title_snippet,
          pfm_post_id
   FROM posted_reels
   ${whereClause ? whereClause + " AND " : "WHERE "} topic_score IS NOT NULL
     AND topic_score < 0.80
     AND ${NON_LEGACY}
   ORDER BY topic_score ASC`,
  [...whereParams, NON_LEGACY_PARAM]
);

if (lowConf.length === 0) {
  console.log("  ✅ None — all accepted posts had high confidence (≥0.80).");
} else {
  console.table(lowConf);
  console.log("  ⚠ These videos were close to the 0.7 rejection threshold — may be borderline off-topic.");
}

// ── Report 6: Source performance ──────────────────────────────────────────
h2("Top sources by volume + avg quality");
const sourcePerf = q(
  `SELECT source_name,
          COUNT(*) as n,
          COUNT(DISTINCT page_name) as pages,
          ROUND(AVG(file_size_mb), 1) as avg_mb,
          ROUND(AVG(topic_score), 2) as avg_score
   FROM posted_reels
   ${whereClause ? whereClause + " AND " : "WHERE "} ${NON_LEGACY}
   GROUP BY source_name
   ORDER BY n DESC
   LIMIT 15`,
  [...whereParams, NON_LEGACY_PARAM]
);

if (sourcePerf.length === 0) {
  console.log("  (no sources)");
} else {
  console.table(sourcePerf);
}

// ── Report 7: Day-over-day (if >1 day window or --all) ────────────────────
if (all || sinceArg) {
  h2("Posts per day");
  const daily = q(
    `SELECT SUBSTR(posted_at, 1, 10) as day,
            COUNT(*) as n,
            ROUND(AVG(file_size_mb), 1) as avg_mb,
            ROUND(AVG(topic_score), 2) as avg_score
     FROM posted_reels
     ${whereClause ? whereClause + " AND " : "WHERE "} ${NON_LEGACY}
     GROUP BY day
     ORDER BY day DESC
     LIMIT 14`,
    [...whereParams, NON_LEGACY_PARAM]
  );
  if (daily.length === 0) {
    console.log("  (no data)");
  } else {
    console.table(daily);
  }
}

// ── Summary line ──────────────────────────────────────────────────────────
const total = q(
  `SELECT COUNT(*) as n FROM posted_reels
   ${whereClause ? whereClause + " AND " : "WHERE "} ${NON_LEGACY}`,
  [...whereParams, NON_LEGACY_PARAM]
)[0].n;

console.log("\n" + "═".repeat(70));
console.log(`  TOTAL NEW-PIPELINE POSTS IN RANGE: ${total}`);
console.log("═".repeat(70) + "\n");
