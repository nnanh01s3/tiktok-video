import "../src/env.js";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "fs";

// Use a temp DB to avoid polluting production — MUST be set before importing db.js
process.env.DB_PATH = "./data/_test_posted_reels.db";
if (existsSync(process.env.DB_PATH)) unlinkSync(process.env.DB_PATH);

const { getDb, isVideoPosted, recordPostedVideo, getPostedStats } = await import("../src/db.js");

const db = getDb();

// 1. Schema exists
const cols = db.prepare("PRAGMA table_info(posted_reels)").all();
assert.ok(cols.length >= 10, `expected >=10 columns, got ${cols.length}`);
const colNames = cols.map((c) => c.name);
for (const required of ["video_id", "source_url", "page_name", "niche", "posted_at", "pfm_post_id", "topic_score"]) {
  assert.ok(colNames.includes(required), `missing column: ${required}`);
}

// 2. isVideoPosted returns false for unknown id
assert.equal(isVideoPosted("nonexistent_id"), false);

// 3. recordPostedVideo inserts
recordPostedVideo({
  video_id: "test_123",
  source_url: "https://www.tiktok.com/@x/video/test_123",
  source_name: "Test Source",
  page_name: "tech",
  posted_at: new Date().toISOString(),
  pfm_post_id: "sp_test",
  topic_score: 0.85,
  video_title: "Test video",
});

// 4. isVideoPosted returns true after insert
assert.equal(isVideoPosted("test_123"), true);

// 5. INSERT OR IGNORE — second insert does not throw
recordPostedVideo({
  video_id: "test_123",
  source_url: "different",
  page_name: "shopee",
  posted_at: new Date().toISOString(),
});

// 6. getPostedStats returns aggregate
const stats = getPostedStats();
assert.ok(Array.isArray(stats));
assert.ok(stats.some((s) => s.page_name === "tech"));

console.log("✅ All verify-db-posted-reels checks passed");
