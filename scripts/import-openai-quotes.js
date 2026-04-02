/**
 * Import quotes from OpenAI JSON files into quotes_v2.
 *
 * Usage:
 *   node scripts/import-openai-quotes.js data/openai-vn-quotes.json
 *   node scripts/import-openai-quotes.js data/openai-vn-part1.json data/openai-vn-part2.json
 *
 * JSON format (array of objects):
 * [{
 *   "text_vi": "nguyên văn",
 *   "text_original": null,
 *   "author": "Nguyễn Du",
 *   "author_vi": "Nguyễn Du",
 *   "source_work": "Truyện Kiều",
 *   "source_detail": "Câu 1-2",
 *   "era": "cổ đại",
 *   "origin": "việt nam",
 *   "category": "triết lý sống",
 *   "tone": "philosophical"
 * }]
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { createHash } from "crypto";

const db = new Database("./data/content.db");

function hashText(text) {
  return createHash("md5").update(text).digest("hex").slice(0, 16);
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO quotes_v2
  (text_vi, text_original, author, author_vi, source_work, source_detail,
   era, origin, category, tags, tone, length_chars, verified, verify_source, hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/import-openai-quotes.js <file1.json> [file2.json] ...");
  process.exit(1);
}

let totalInserted = 0;
let totalSkipped = 0;
let totalInvalid = 0;

for (const file of files) {
  console.log(`\n📂 Reading ${file}...`);

  let quotes;
  try {
    const raw = readFileSync(file, "utf-8");
    // Handle both raw JSON array and markdown-wrapped JSON
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found in file");
    quotes = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(`  ✗ Failed to parse ${file}: ${e.message}`);
    continue;
  }

  console.log(`  Found ${quotes.length} quotes`);

  let inserted = 0;
  let skipped = 0;
  let invalid = 0;

  for (const q of quotes) {
    const textVi = q.text_vi?.trim();
    if (!textVi || textVi.length < 5) {
      invalid++;
      continue;
    }

    // Validate required fields
    if (!q.author || !q.source_work) {
      console.log(`  ⚠ Missing author/source_work: "${textVi.slice(0, 40)}..."`);
      invalid++;
      continue;
    }

    const hash = hashText(textVi);
    const tags = JSON.stringify([q.source_work, q.era || "cổ đại", q.origin || "việt nam"]);

    try {
      const result = insert.run(
        textVi,
        q.text_original || null,
        q.author,
        q.author_vi || q.author,
        q.source_work,
        q.source_detail || null,
        q.era || "cổ đại",
        q.origin || "việt nam",
        q.category || "triết lý sống",
        tags,
        q.tone || "philosophical",
        textVi.length,
        4, // openai-sourced
        "OpenAI GPT-4o",
        hash
      );
      if (result.changes > 0) {
        inserted++;
        console.log(`  ✓ [${q.author_vi || q.author}] "${textVi.slice(0, 50)}..."`);
      } else {
        skipped++; // duplicate hash
      }
    } catch (e) {
      skipped++;
    }
  }

  console.log(`  → ${inserted} inserted, ${skipped} duplicates, ${invalid} invalid`);
  totalInserted += inserted;
  totalSkipped += skipped;
  totalInvalid += invalid;
}

// Final stats
const total = db.prepare("SELECT COUNT(*) as c FROM quotes_v2").get();
console.log(`\n${"═".repeat(50)}`);
console.log(`IMPORT COMPLETE`);
console.log(`  Inserted: ${totalInserted}`);
console.log(`  Skipped (duplicate): ${totalSkipped}`);
console.log(`  Invalid: ${totalInvalid}`);
console.log(`  Total in DB: ${total.c}`);
console.log(`${"═".repeat(50)}`);

db.close();
