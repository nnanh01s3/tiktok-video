/**
 * Seed 2000+ motivational quotes into SQLite.
 *
 * Strategy:
 *   - 10 categories × 4 batches × 50 quotes = 2000 target
 *   - Uses Claude Haiku for cost efficiency (~$0.30 total for 2000 quotes)
 *   - Deduplicates by SHA-256 hash of lowercased text
 *   - Retries failed batches up to 2 times
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/seed-quotes.js
 *   node scripts/seed-quotes.js --count 10   # 10 per batch (for testing)
 */
import "../src/env.js";
import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";

const DB_PATH = process.env.DB_PATH || "./data/content.db";
const BATCH_SIZE = parseInt(process.argv.find((a) => a.startsWith("--count="))?.split("=")[1] || "50");
const DRY_RUN = process.argv.includes("--dry-run");

const CATEGORIES = [
  "thành công và tham vọng",
  "kỷ luật và thói quen",
  "sức mạnh tinh thần",
  "vượt qua thất bại",
  "phát triển bản thân",
  "triết lý sống",
  "tư duy tài chính",
  "lãnh đạo và ảnh hưởng",
  "quản lý thời gian",
  "trí tuệ cảm xúc",
];

const BATCHES_PER_CATEGORY = 4;

function hashQuote(text) {
  return createHash("sha256").update(text.toLowerCase().trim()).digest("hex").slice(0, 16);
}

async function generateBatch(client, category, batchNum) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Tạo ${BATCH_SIZE} câu nói truyền cảm hứng bằng TIẾNG VIỆT về chủ đề "${category}".

NGUỒN CẢM HỨNG (bắt buộc lấy từ đây):
- Câu nói nổi tiếng của danh nhân thế giới (Steve Jobs, Elon Musk, Warren Buffett, Einstein, Marcus Aurelius, Seneca, Lão Tử, Khổng Tử...)
- Trích dẫn từ sách nổi tiếng (Atomic Habits, Think and Grow Rich, The Art of War, Meditations, 48 Laws of Power, Đắc Nhân Tâm...)
- Triết lý từ doanh nhân Việt Nam và châu Á (Phạm Nhật Vượng, Jack Ma, Matsushita Konosuke...)
- Câu nói từ phim, bài phát biểu nổi tiếng

Quy tắc:
- DỊCH hoặc DIỄN GIẢI sang tiếng Việt tự nhiên, có dấu đầy đủ
- Mỗi câu: 10-30 từ, ngắn gọn, dễ nhớ, sâu sắc
- GHI RÕ tác giả gốc (author field)
- KHÔNG tự sáng tác câu nói rồi gán cho người nổi tiếng
- KHÔNG lặp lại câu nói đã phổ biến quá mức trên mạng
- Batch ${batchNum}/${BATCHES_PER_CATEGORY} — đa dạng tác giả, không lặp
- Ưu tiên câu nói ít người biết nhưng cực kỳ hay

Return ONLY a JSON array: [{"text": "...", "author": "Tên tác giả"}]
No markdown, no explanation, just the array.`,
      },
    ],
  });

  const raw = response.content[0].text.trim();
  // Handle potential markdown wrapping
  const json = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(json);
}

async function main() {
  console.log(`\n=== TikTokBot Quote Seeder ===`);
  console.log(`Target: ${CATEGORIES.length} categories × ${BATCHES_PER_CATEGORY} batches × ${BATCH_SIZE} quotes`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const dir = "./data";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Create table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      text        TEXT    NOT NULL UNIQUE,
      author      TEXT    DEFAULT 'Original',
      category    TEXT    NOT NULL,
      hash        TEXT    NOT NULL UNIQUE,
      used_count  INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at  TEXT    DEFAULT (datetime('now')),
      source      TEXT    DEFAULT 'seed'
    );
    CREATE INDEX IF NOT EXISTS idx_quotes_category ON quotes(category);
    CREATE INDEX IF NOT EXISTS idx_quotes_unused ON quotes(used_count, last_used_at);
  `);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO quotes (text, author, category, hash, source) VALUES (?, ?, ?, ?, 'seed')`
  );

  const client = new Anthropic();
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;

  for (const category of CATEGORIES) {
    console.log(`\n📁 ${category}`);

    for (let batch = 1; batch <= BATCHES_PER_CATEGORY; batch++) {
      let quotes = null;
      let retries = 0;

      while (!quotes && retries < 3) {
        try {
          quotes = await generateBatch(client, category, batch);
        } catch (err) {
          retries++;
          console.error(`   ⚠ Batch ${batch} attempt ${retries} failed: ${err.message}`);
          if (retries < 3) await new Promise((r) => setTimeout(r, 2000 * retries));
        }
      }

      if (!quotes) {
        console.error(`   ✗ Batch ${batch} failed after 3 attempts, skipping`);
        totalErrors++;
        continue;
      }

      let batchInserted = 0;
      let batchDupes = 0;

      if (!DRY_RUN) {
        const tx = db.transaction(() => {
          for (const q of quotes) {
            if (!q.text || q.text.length < 10) continue;
            const hash = hashQuote(q.text);
            const author = q.author || "Unknown";
            const result = insert.run(q.text.trim(), author, category, hash);
            if (result.changes > 0) batchInserted++;
            else batchDupes++;
          }
        });
        tx();
      } else {
        batchInserted = quotes.length;
      }

      totalInserted += batchInserted;
      totalDuplicates += batchDupes;
      console.log(`   Batch ${batch}/${BATCHES_PER_CATEGORY}: +${batchInserted} quotes (${batchDupes} dupes)`);
    }
  }

  // Final stats
  const totalInDb = DRY_RUN ? "N/A" : db.prepare("SELECT COUNT(*) as c FROM quotes").get().c;
  const byCategory = DRY_RUN
    ? []
    : db.prepare("SELECT category, COUNT(*) as c FROM quotes GROUP BY category ORDER BY category").all();

  console.log(`\n=== Results ===`);
  console.log(`Inserted: ${totalInserted}`);
  console.log(`Duplicates skipped: ${totalDuplicates}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Total in DB: ${totalInDb}`);

  if (byCategory.length > 0) {
    console.log(`\nBy category:`);
    for (const row of byCategory) {
      console.log(`  ${row.category}: ${row.c}`);
    }
  }

  db.close();
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
