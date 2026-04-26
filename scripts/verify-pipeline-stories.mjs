/**
 * Verify pipeline-stories-veo DB helpers.
 * Tests getNextStory() filter logic + markStoryUsed() side effects.
 */
import "../src/env.js";
import assert from "node:assert/strict";
import { existsSync, copyFileSync, unlinkSync } from "fs";
import { genStoryDirector } from "../src/pipeline-stories-veo.js";

// Use a temp DB to avoid polluting production
const PROD_DB = "./data/content.db";
const TEST_DB = "./data/_test_stories.db";
process.env.DB_PATH = TEST_DB;
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
copyFileSync(PROD_DB, TEST_DB); // Clone production DB for read fixtures

const { getNextStory, markStoryUsed, getDb, closeDb } = await import("../src/db.js");

// 1. getNextStory() with no filters returns least-used (ASC by used_count)
const story1 = getNextStory();
assert.ok(story1, "getNextStory() should return a story");
assert.ok(story1.id, "story should have id");
assert.ok(story1.title, "story should have title");
assert.ok(story1.content_vi, "story should have content_vi");
assert.ok(story1.type, "story should have type");
console.log(`✅ Default pick: ${story1.type} #${story1.id} "${story1.title.slice(0, 40)}" (used_count=${story1.used_count})`);

// 2. Filter by type
const bookOnly = getNextStory({ type: "book" });
assert.equal(bookOnly?.type, "book", "type=book filter should return book");
console.log(`✅ Type filter: book #${bookOnly.id} "${bookOnly.title.slice(0, 40)}"`);

// 3. Filter by category
const nghiluc = getNextStory({ category: "nghị lực" });
assert.equal(nghiluc?.category, "nghị lực", "category filter should match");
console.log(`✅ Category filter: nghị lực #${nghiluc.id} "${nghiluc.title.slice(0, 40)}"`);

// 4. Filter by id
const byId = getNextStory({ id: story1.id });
assert.equal(byId?.id, story1.id, "id filter should return exact entry");
console.log(`✅ ID filter: #${byId.id}`);

// 5. markStoryUsed increments used_count + sets used_at
const beforeCount = story1.used_count || 0;
markStoryUsed(story1.id);
const afterRow = getDb().prepare("SELECT used_count, used_at FROM content_library WHERE id = ?").get(story1.id);
assert.equal(afterRow.used_count, beforeCount + 1, "used_count should increment");
assert.ok(afterRow.used_at, "used_at should be set");
console.log(`✅ markStoryUsed: count ${beforeCount} → ${afterRow.used_count}, used_at=${afterRow.used_at}`);

// 6. After mark, ORDER BY used_count ASC should rotate to a different story
const story2 = getNextStory();
assert.notEqual(story2.id, story1.id, "after marking story1 used, getNextStory should return different story");
console.log(`✅ Rotation: after marking #${story1.id}, next = #${story2.id}`);

// 7. Director generates valid JSON for a real story
console.log("\n--- Testing genStoryDirector (slow, ~30s) ---");
const testStory = getNextStory({ type: "story" });
console.log(`Generating director for: "${testStory.title}"`);
const director = await genStoryDirector(testStory);

assert.ok(director.title && director.title.length > 0, "director should have title");
assert.ok(director.hook && director.hook.length > 0, "director should have hook");
assert.ok(director.hookVeoPrompt && director.hookVeoPrompt.length > 0, "director should have Veo prompt");
assert.ok(Array.isArray(director.scenes), "scenes should be array");
assert.ok(director.scenes.length >= 3 && director.scenes.length <= 6, `scenes should be 3-6 (got ${director.scenes.length})`);
for (const [i, s] of director.scenes.entries()) {
  assert.ok(s.narration, `scene ${i} should have narration`);
  assert.ok(s.imagenPrompt, `scene ${i} should have imagenPrompt`);
  assert.ok(typeof s.duration === "number" && s.duration >= 20 && s.duration <= 40, `scene ${i} duration should be 20-40s (got ${s.duration})`);
}
console.log(`✅ Director generated ${director.scenes.length} scenes for "${testStory.title}"`);
console.log(`   Hook: "${director.hook.slice(0, 80)}..."`);
console.log(`   Veo prompt: "${director.hookVeoPrompt.slice(0, 80)}..."`);

// Cleanup
closeDb();
unlinkSync(TEST_DB);
console.log("\n✅ All verify-pipeline-stories DB checks passed");
