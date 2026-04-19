/**
 * One-shot: migrate data/shopee/reels/<page>/processed.json files into
 * the new posted_reels SQLite table, then rename JSON files to .migrated.bak.
 *
 * Safe to re-run — uses INSERT OR IGNORE.
 */
import "../src/env.js";
import { readFileSync, readdirSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { getDb } from "../src/db.js";

const REELS_DIR = "./data/shopee/reels";
if (!existsSync(REELS_DIR)) {
  console.error(`Not found: ${REELS_DIR}`);
  process.exit(1);
}

const db = getDb();
const stmt = db.prepare(`
  INSERT OR IGNORE INTO posted_reels
    (video_id, source_url, source_name, page_name, niche, posted_at, topic_score, video_title)
  VALUES (?, '', 'legacy_migration', ?, ?, ?, NULL, NULL)
`);

const dirs = readdirSync(REELS_DIR, { withFileTypes: true }).filter(
  (d) => d.isDirectory() && !d.name.startsWith("_")
);

let migrated = 0;
let pages = 0;
const skipped = [];

const tx = db.transaction(() => {
  for (const d of dirs) {
    const file = join(REELS_DIR, d.name, "processed.json");
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      const ts = data.last_check || new Date().toISOString();
      for (const id of data.processed_ids || []) {
        if (!id) continue;
        stmt.run(String(id), d.name, d.name, ts);
        migrated++;
      }
      renameSync(file, file + ".migrated.bak");
      pages++;
    } catch (e) {
      skipped.push({ page: d.name, err: e.message });
    }
  }
});
tx();

console.log(`✅ Migrated ${migrated} entries across ${pages} pages`);
if (skipped.length) {
  console.log(`⚠️  Skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`    ${s.page}: ${s.err}`);
}
