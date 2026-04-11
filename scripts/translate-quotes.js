/**
 * Translate all non-Vietnamese quotes to proper Vietnamese for display.
 *
 * Scans quotes_v2 for entries where text_vi is:
 *   - Hán-Việt phiên âm (not real Vietnamese)
 *   - Original language (Chinese, French, English, etc.)
 *   - Error messages ("Chưa tìm được bản dịch...")
 *
 * Uses Claude to translate into natural, understandable Vietnamese.
 * Stores result in text_vi_display column.
 *
 * For Vietnamese origin quotes: text_vi_display = text_vi (no translation needed)
 *
 * Usage: node scripts/translate-quotes.js [--batch-size 20]
 */

import "../src/env.js";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";

const db = new Database("./data/content.db");
const anthropic = new Anthropic();

const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith("--batch-size="))?.split("=")[1] || "20");

// Step 1: Set text_vi_display = text_vi for Vietnamese quotes (already correct)
const vnUpdate = db.prepare(`
  UPDATE quotes_v2 SET text_vi_display = text_vi
  WHERE origin = 'việt nam' AND text_vi_display IS NULL
`).run();
console.log(`✓ Vietnamese quotes: ${vnUpdate.changes} set to text_vi (no translation needed)`);

// Step 2: Find non-VN quotes needing translation
const needTranslation = db.prepare(`
  SELECT id, text_vi, text_original, author_vi, source_work, origin
  FROM quotes_v2
  WHERE origin != 'việt nam' AND text_vi_display IS NULL
  ORDER BY id
`).all();

console.log(`\n🔄 Need translation: ${needTranslation.length} quotes`);

if (needTranslation.length === 0) {
  console.log("Nothing to translate!");
  db.close();
  process.exit(0);
}

const updateStmt = db.prepare(`UPDATE quotes_v2 SET text_vi_display = ? WHERE id = ?`);

// Step 3: Translate in batches using Claude
for (let i = 0; i < needTranslation.length; i += BATCH_SIZE) {
  const batch = needTranslation.slice(i, i + BATCH_SIZE);
  console.log(`\n📝 Translating batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(needTranslation.length / BATCH_SIZE)} (${batch.length} quotes)...`);

  const quotesForPrompt = batch.map((q, idx) => ({
    idx,
    id: q.id,
    text_vi: q.text_vi,
    text_original: q.text_original,
    author: q.author_vi,
    source: q.source_work
  }));

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: `Dịch các câu trích dẫn sau sang TIẾNG VIỆT TỰ NHIÊN, DỄ HIỂU để hiển thị trên video TikTok.

QUY TẮC:
1. Dịch sang tiếng Việt thuần túy — người Việt bình thường đọc hiểu ngay
2. KHÔNG giữ Hán-Việt phiên âm (VD: "Bất ngôn chi giáo" → dịch thành "Lời dạy không cần nói")
3. KHÔNG giữ tiếng Anh/Pháp/Trung/Pali — dịch hết sang tiếng Việt
4. Giữ văn phong trang trọng, súc tích, phù hợp video truyền cảm hứng
5. Nếu text_vi ĐÃ là tiếng Việt tự nhiên rồi → giữ nguyên
6. Nếu text_vi chứa "Chưa tìm được bản dịch" hoặc lỗi → dịch từ text_original
7. Nếu là thơ Đường/thơ cổ → dịch thành thơ/văn Việt có vần, không cần giữ thể thơ gốc

Danh sách cần dịch:
${JSON.stringify(quotesForPrompt, null, 2)}

Trả về JSON array, mỗi item:
{ "idx": <số thứ tự>, "translation": "bản dịch tiếng Việt" }

CHỈ trả về JSON array.`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("  ⚠ No JSON found in response");
      continue;
    }

    const translations = JSON.parse(jsonMatch[0]);
    let updated = 0;

    const tx = db.transaction(() => {
      for (const t of translations) {
        const quote = batch[t.idx];
        if (!quote || !t.translation) continue;

        // Skip if translation is too short or looks like an error
        if (t.translation.length < 5) continue;

        updateStmt.run(t.translation.trim(), quote.id);
        updated++;
        console.log(`  ✓ [${quote.author_vi}] "${t.translation.slice(0, 60)}..."`);
      }
    });
    tx();

    console.log(`  → ${updated}/${batch.length} translated`);

    // Rate limit
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) {
    console.error(`  ✗ Batch error: ${e.message}`);
  }
}

// Final stats
const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN text_vi_display IS NOT NULL THEN 1 ELSE 0 END) as translated,
    SUM(CASE WHEN text_vi_display IS NULL THEN 1 ELSE 0 END) as missing
  FROM quotes_v2
`).get();

console.log(`\n${"═".repeat(50)}`);
console.log(`TRANSLATION COMPLETE`);
console.log(`  Total: ${stats.total}`);
console.log(`  Translated: ${stats.translated}`);
console.log(`  Missing: ${stats.missing}`);
console.log(`${"═".repeat(50)}`);

db.close();
