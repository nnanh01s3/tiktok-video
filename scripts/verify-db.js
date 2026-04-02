/**
 * Verify quote database health.
 * Run after seeding to confirm data quality.
 */
import Database from "better-sqlite3";

const DB_PATH = process.env.DB_PATH || "./data/content.db";

const db = new Database(DB_PATH, { readonly: true });

const total = db.prepare("SELECT COUNT(*) as c FROM quotes").get().c;
const byCategory = db
  .prepare("SELECT category, COUNT(*) as total, SUM(CASE WHEN used_count = 0 THEN 1 ELSE 0 END) as unused FROM quotes GROUP BY category ORDER BY category")
  .all();

const shortest = db.prepare("SELECT text, LENGTH(text) as len FROM quotes ORDER BY len ASC LIMIT 3").all();
const longest = db.prepare("SELECT text, LENGTH(text) as len FROM quotes ORDER BY len DESC LIMIT 3").all();
const sample = db.prepare("SELECT text, category FROM quotes ORDER BY RANDOM() LIMIT 5").all();

console.log(`=== Quote DB Health Check ===\n`);
console.log(`Total quotes: ${total}`);
console.log(`Target: 1500+ (minimum viable), 2000 (ideal)\n`);

console.log(`By category:`);
let allOk = true;
for (const row of byCategory) {
  const status = row.total >= 100 ? "OK" : "LOW";
  if (status === "LOW") allOk = false;
  console.log(`  ${status === "OK" ? "✓" : "✗"} ${row.category}: ${row.total} total, ${row.unused} unused`);
}

console.log(`\nShortest quotes:`);
for (const q of shortest) console.log(`  [${q.len} chars] "${q.text}"`);

console.log(`\nLongest quotes:`);
for (const q of longest) console.log(`  [${q.len} chars] "${q.text}"`);

console.log(`\nRandom sample:`);
for (const q of sample) console.log(`  [${q.category}] "${q.text}"`);

console.log(`\n=== Verdict: ${total >= 1500 && allOk ? "PASS ✓" : "NEEDS ATTENTION ✗"} ===`);

db.close();
