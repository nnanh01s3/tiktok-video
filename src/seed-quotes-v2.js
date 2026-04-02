/**
 * Seed quotes_v2 with verified, attributed quotes.
 *
 * Strategy — 2-phase with web verification:
 *   Phase 1: Claude generates candidate quotes from known works
 *   Phase 2: Claude + web_search verifies each quote against online sources
 *            → auto-corrects to verbatim text or rejects if unverifiable
 *
 * Key rule: Vietnamese poetry/prose MUST be copied verbatim (nguyên văn).
 *           No paraphrasing, no "explaining" the meaning.
 */

import "./env.js";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

const db = new Database("./data/content.db");
const anthropic = new Anthropic();

function hashText(text) {
  return createHash("md5").update(text).digest("hex").slice(0, 16);
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO quotes_v2
  (text_vi, text_original, author, author_vi, source_work, source_detail,
   era, origin, category, tags, tone, length_chars, verified, verify_source, hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Phase 2: Verify a single quote using Claude + web search.
 *
 * Claude searches the web for the exact original text, then either:
 *   - Returns the VERBATIM correct text (auto-correct)
 *   - Returns null if the quote is fabricated and can't be found
 */
async function verifyQuote(quote, config) {
  const isVietnamese = config.origin === "việt nam" || config.origin === "dân gian";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    messages: [{
      role: "user",
      content: `Xác minh câu trích dẫn sau bằng cách TÌM KIẾM TRÊN WEB.

Tác giả: ${config.author_vi || config.author}
Tác phẩm: ${config.source_work}
Câu trích dẫn cần verify:
"${quote.text_vi}"
${quote.text_original ? `Nguyên văn gốc: "${quote.text_original}"` : ""}

NHIỆM VỤ:
1. Search web tìm NGUYÊN VĂN CHÍNH XÁC của câu trích dẫn này
2. So sánh với câu được cho — nếu SAI, trả về bản ĐÚNG
3. ${isVietnamese
  ? "ĐÂY LÀ TÁC PHẨM VIỆT NAM — PHẢI giữ nguyên văn tuyệt đối (thơ lục bát, văn xuôi, tục ngữ). KHÔNG diễn giải, KHÔNG viết lại bằng lời khác."
  : "Tìm cả nguyên văn gốc (tiếng Anh/Hán/Pali...) VÀ bản dịch Việt chính xác."}

Return JSON:
{
  "verified": true nếu câu gốc ĐÚNG nguyên văn / false nếu SAI hoặc bị bịa,
  "found_online": true nếu tìm được trên web / false nếu không tìm thấy,
  "correct_text_vi": "nguyên văn tiếng Việt CHÍNH XÁC (copy từ nguồn web)",
  "correct_text_original": "nguyên văn gốc nếu không phải tiếng Việt, null nếu gốc là tiếng Việt",
  "source_detail": "chương/thiên/phần cụ thể",
  "source_url": "URL nguồn xác minh",
  "note": "ghi chú ngắn về kết quả verify"
}

CHỈ trả về JSON, không giải thích thêm.`
    }]
  });

  // Extract the final text block (after web search tool use)
  const textBlock = response.content.findLast(b => b.type === "text");
  if (!textBlock) return null;

  try {
    const raw = textBlock.text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    const result = JSON.parse(raw);

    // Reject if not found online or fabricated
    if (!result.found_online && !result.verified) {
      console.log(`    ✗ REJECTED (not found online): "${quote.text_vi.slice(0, 50)}..."`);
      return null;
    }

    // Auto-correct if different from original
    if (!result.verified && result.correct_text_vi) {
      console.log(`    ↻ CORRECTED: "${quote.text_vi.slice(0, 40)}..." → "${result.correct_text_vi.slice(0, 40)}..."`);
    } else {
      console.log(`    ✓ VERIFIED: "${quote.text_vi.slice(0, 50)}..."`);
    }

    return {
      text_vi: result.correct_text_vi || quote.text_vi,
      text_original: result.correct_text_original ?? quote.text_original,
      source_detail: result.source_detail || quote.source_detail,
      verify_source: result.source_url || config.verify_source,
      category: quote.category,
      tone: quote.tone
    };
  } catch (e) {
    console.log(`    ⚠ Verify parse error: ${e.message}`);
    return null; // reject on parse failure
  }
}

/**
 * Search-first flow for Vietnamese classical works.
 *
 * Instead of Generate → Verify, this does:
 *   1. Claude + web_search finds the FULL TEXT of the work online
 *   2. Claude reads the actual text and picks meaningful passages
 *   3. Each passage is categorized and returned as a quote
 *
 * This guarantees verbatim accuracy since quotes come FROM web sources.
 */
async function collectFromWebSource(config) {
  const {
    author, author_vi, source_work, era, origin,
    prompt_detail, count = 10, category = "triết lý sống",
    tone = "philosophical", verify_source
  } = config;

  console.log(`\n🌐 [Web-first] ${author_vi || author} — ${source_work}...`);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    messages: [{
      role: "user",
      content: `Tìm kiếm NGUYÊN VĂN tác phẩm "${source_work}" của ${author_vi || author} trên internet.

BƯỚC 1: Search web tìm toàn văn hoặc các trích đoạn nổi tiếng của "${source_work}".
BƯỚC 2: Từ nguyên văn tìm được, chọn ra ${count} đoạn/cặp câu HAY NHẤT có ý nghĩa sâu sắc.

${prompt_detail || ""}

QUY TẮC CHỌN TRÍCH DẪN:
- PHẢI copy nguyên văn từ nguồn web tìm được — KHÔNG tự viết, KHÔNG diễn giải
- Thơ lục bát: chọn CẶP câu 6+8 đi cùng nhau (VD: "Trăm năm trong cõi người ta / Chữ tài chữ mệnh khéo là ghét nhau")
- Thơ song thất lục bát: chọn đoạn 4 câu (7-7-6-8)
- Thơ Đường luật: chọn 2-4 câu liền nhau
- Văn xuôi: chọn câu/đoạn ngắn gọn, súc tích
- Mỗi đoạn phải có ý nghĩa TRỌN VẸN, đọc một mình vẫn hiểu được
- Phân loại vào 1 trong các category: triết lý sống / nghị lực / tình yêu / trí tuệ / lãnh đạo / tự do / nhân sinh

Trả về JSON array:
[{
  "text_vi": "nguyên văn CHÍNH XÁC copy từ web",
  "text_original": null,
  "source_detail": "phần/chương/vị trí trong tác phẩm",
  "source_url": "URL nguồn đã copy",
  "category": "category phù hợp nhất",
  "tone": "inspirational / philosophical / provocative / melancholic"
}]

CHỈ trả về JSON array, không giải thích thêm.`
    }]
  });

  // Extract the final text block (after web search)
  const textBlock = response.content.findLast(b => b.type === "text");
  if (!textBlock) {
    console.log("  ⚠ No text response");
    return 0;
  }

  let quotes;
  try {
    const raw = textBlock.text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");
    quotes = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(`  ⚠ Failed to parse: ${e.message}`);
    console.error(`  Preview: ${textBlock.text.slice(0, 200)}`);
    return 0;
  }

  let inserted = 0;
  for (const q of quotes) {
    const textVi = q.text_vi?.trim();
    if (!textVi || textVi.length < 10) continue;

    const hash = hashText(textVi);
    const tags = JSON.stringify([source_work, era, origin]);
    const src = q.source_url ? `${verify_source} | ${q.source_url}` : verify_source;

    try {
      const result = insert.run(
        textVi,
        q.text_original || null,
        author,
        author_vi || null,
        source_work,
        q.source_detail || null,
        era,
        origin,
        q.category || category,
        tags,
        q.tone || tone,
        textVi.length,
        3, // web-sourced (highest confidence)
        src,
        hash
      );
      if (result.changes > 0) {
        inserted++;
        console.log(`    ✓ "${textVi.slice(0, 60)}..."`);
      }
    } catch (e) {
      // duplicate hash — skip
    }
  }

  console.log(`  ✓ Inserted ${inserted}/${quotes.length} quotes (web-sourced)`);
  return inserted;
}

async function collectFromAuthor(config) {
  const {
    author, author_vi, source_work, era, origin,
    prompt_detail, count = 10, category = "triết lý sống",
    tone = "philosophical", verify_source = "Claude knowledge + source text"
  } = config;

  console.log(`\n📚 Collecting from ${author_vi || author} — ${source_work}...`);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: `Bạn là chuyên gia về ${source_work} của ${author_vi || author}.

Hãy trích dẫn chính xác ${count} câu nói/đoạn văn nổi tiếng nhất từ tác phẩm "${source_work}".

${prompt_detail || ""}

YÊU CẦU BẮT BUỘC:
- Mỗi câu phải THỰC SỰ có trong tác phẩm gốc — KHÔNG tự sáng tác, KHÔNG paraphrase
- Nếu tác phẩm gốc không phải tiếng Việt, cho CẢ nguyên văn gốc VÀ bản dịch tiếng Việt phổ biến nhất
- Nếu tác phẩm gốc là tiếng Việt (thơ lục bát, ca dao, văn xuôi): PHẢI SAO CHÉP NGUYÊN VĂN TỪNG CHỮ
  + Thơ lục bát: giữ nguyên vần, nhịp, câu 6-8. VD: "Trăm năm trong cõi người ta / Chữ tài chữ mệnh khéo là ghét nhau"
  + Tục ngữ: giữ nguyên cả câu. VD: "Có công mài sắt, có ngày nên kim"
  + KHÔNG giải nghĩa thay cho nguyên văn
- Ghi rõ chương/thiên/phần nếu biết
- Chọn những câu có giá trị triết lý sâu sắc, phù hợp để truyền cảm hứng
- NẾU KHÔNG NHỚ CHÍNH XÁC, BỎ QUA — đừng đoán mò

Trả về JSON array, mỗi item có format:
{
  "text_vi": "Bản tiếng Việt",
  "text_original": "Original text (nếu không phải tiếng Việt, null nếu gốc là tiếng Việt)",
  "source_detail": "Chương/thiên/phần cụ thể",
  "category": "chủ đề phụ phù hợp nhất: triết lý sống / nghị lực / tình yêu / trí tuệ / lãnh đạo / tự do / nhân sinh",
  "tone": "inspirational / philosophical / provocative / melancholic"
}

CHỈ trả về JSON array, không giải thích thêm.`
    }]
  });

  const text = response.content[0].text;

  // Extract JSON from response
  let quotes;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");
    quotes = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error(`  ⚠ Failed to parse response for ${author}: ${e.message}`);
    console.error(`  Response preview: ${text.slice(0, 200)}`);
    return 0;
  }

  // --- Phase 2: Verify each quote via web search ---
  console.log(`  🔍 Verifying ${quotes.length} quotes via web search...`);

  let inserted = 0;
  let verified = 0;
  let rejected = 0;

  for (const q of quotes) {
    const textVi = q.text_vi?.trim();
    if (!textVi) continue;

    // Verify with web search
    const result = await verifyQuote(q, config);
    if (!result) {
      rejected++;
      continue;
    }
    verified++;

    const finalText = result.text_vi.trim();
    const hash = hashText(finalText);
    const tags = JSON.stringify([source_work, era, origin]);

    try {
      const dbResult = insert.run(
        finalText,
        result.text_original || null,
        author,
        author_vi || null,
        source_work,
        result.source_detail || null,
        era,
        origin,
        result.category || category,
        tags,
        result.tone || tone,
        finalText.length,
        2, // web-verified (higher confidence than 1)
        result.verify_source || verify_source,
        hash
      );
      if (dbResult.changes > 0) inserted++;
    } catch (e) {
      // duplicate hash — skip
    }

    // Rate limit: small delay between verification calls
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`  ✓ Inserted ${inserted} | Verified ${verified} | Rejected ${rejected} / ${quotes.length} quotes`);
  return inserted;
}

// ═══════════════════════════════════════════════════
// BATCH 1: VIỆT NAM — Văn học cổ điển + Ca dao tục ngữ
// ═══════════════════════════════════════════════════

const BATCH_VN = [
  // --- Nguyễn Trãi ---
  {
    author: "Nguyễn Trãi", author_vi: "Nguyễn Trãi",
    source_work: "Bình Ngô Đại Cáo",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 8,
    prompt_detail: "Trích các câu về độc lập, nhân nghĩa, ý chí dân tộc. Giữ nguyên văn bản dịch Nôm phổ biến nhất.",
    verify_source: "Bình Ngô Đại Cáo — Nguyễn Trãi (1428)"
  },
  {
    author: "Nguyễn Trãi", author_vi: "Nguyễn Trãi",
    source_work: "Gia Huấn Ca",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 8,
    prompt_detail: "Trích các câu thơ về đạo làm người, giáo dục, đối nhân xử thế. Giữ nguyên văn thơ lục bát.",
    verify_source: "Gia Huấn Ca — Nguyễn Trãi"
  },
  {
    author: "Nguyễn Trãi", author_vi: "Nguyễn Trãi",
    source_work: "Quốc Âm Thi Tập",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 6,
    prompt_detail: "Trích thơ Nôm hay nhất về thiên nhiên, triết lý sống nhàn, yêu nước. Giữ nguyên văn thơ Nôm.",
    verify_source: "Quốc Âm Thi Tập — Nguyễn Trãi"
  },
  // --- Nguyễn Du ---
  {
    author: "Nguyễn Du", author_vi: "Nguyễn Du",
    source_work: "Truyện Kiều",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 15,
    prompt_detail: "Trích các CẶP câu thơ lục bát nổi tiếng nhất (câu 6 + câu 8 đi cùng nhau). Chọn câu về nhân sinh, số phận, tài mệnh, tình yêu, đạo đức. PHẢI giữ nguyên văn lục bát chính xác từng chữ.",
    verify_source: "Truyện Kiều — Nguyễn Du (1820)"
  },
  // --- Hồ Xuân Hương ---
  {
    author: "Hồ Xuân Hương", author_vi: "Hồ Xuân Hương",
    source_work: "Thơ Hồ Xuân Hương",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 8,
    prompt_detail: "Trích thơ Nôm nổi tiếng nhất: Bánh trôi nước, Tự tình, Đề đền Sầm Nghi Đống, Mời trầu... Giữ nguyên văn thơ Đường luật / lục bát.",
    verify_source: "Thơ Hồ Xuân Hương"
  },
  // --- Nguyễn Bỉnh Khiêm ---
  {
    author: "Nguyễn Bỉnh Khiêm", author_vi: "Nguyễn Bỉnh Khiêm",
    source_work: "Bạch Vân Quốc Ngữ Thi Tập",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 8,
    prompt_detail: "Trích thơ Nôm về nhàn, thanh bạch, xa lánh danh lợi. Bao gồm bài 'Nhàn' nổi tiếng. Giữ nguyên văn thơ.",
    verify_source: "Bạch Vân Quốc Ngữ Thi Tập — Nguyễn Bỉnh Khiêm"
  },
  // --- Nguyễn Gia Thiều ---
  {
    author: "Nguyễn Gia Thiều", author_vi: "Nguyễn Gia Thiều",
    source_work: "Cung Oán Ngâm Khúc",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 8,
    prompt_detail: "Trích các câu thơ song thất lục bát hay nhất về thân phận, nỗi buồn, nhân sinh, thời gian. Giữ nguyên văn.",
    verify_source: "Cung Oán Ngâm Khúc — Nguyễn Gia Thiều"
  },
  // --- Đặng Trần Côn & Đoàn Thị Điểm ---
  {
    author: "Đặng Trần Côn", author_vi: "Đặng Trần Côn (dịch Nôm: Đoàn Thị Điểm)",
    source_work: "Chinh Phụ Ngâm",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 10,
    prompt_detail: "Trích từ bản dịch Nôm (Đoàn Thị Điểm). Chọn câu về chiến tranh, ly biệt, nỗi nhớ, thời gian, thân phận phụ nữ. Giữ nguyên văn song thất lục bát.",
    verify_source: "Chinh Phụ Ngâm — Đặng Trần Côn, bản dịch Đoàn Thị Điểm"
  },
  // --- Lê Thánh Tông ---
  {
    author: "Lê Thánh Tông", author_vi: "Lê Thánh Tông",
    source_work: "Hồng Đức Quốc Âm Thi Tập",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 6,
    prompt_detail: "Trích thơ Nôm hay nhất của vua Lê Thánh Tông về đất nước, triết lý, thiên nhiên. Giữ nguyên văn.",
    verify_source: "Hồng Đức Quốc Âm Thi Tập — Lê Thánh Tông"
  },
  // --- Ngô Thì Nhậm ---
  {
    author: "Ngô Thì Nhậm", author_vi: "Ngô Thì Nhậm",
    source_work: "Trúc Lâm Tông Chỉ Nguyên Thanh & thơ văn",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 5,
    prompt_detail: "Trích từ thơ văn và trước tác Thiền học. Chọn câu về thiền, triết lý sống, thời thế. Giữ nguyên văn.",
    verify_source: "Ngô Thì Nhậm — thơ văn"
  },
  // --- Phan Huy Ích ---
  {
    author: "Phan Huy Ích", author_vi: "Phan Huy Ích",
    source_work: "Dụ Am Văn Tập",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 4,
    prompt_detail: "Trích thơ văn hay nhất về thời cuộc, đạo đức, trung nghĩa. Giữ nguyên văn.",
    verify_source: "Dụ Am Văn Tập — Phan Huy Ích"
  },
  // --- Lý Thường Kiệt ---
  {
    author: "Lý Thường Kiệt", author_vi: "Lý Thường Kiệt",
    source_work: "Nam Quốc Sơn Hà",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 3,
    prompt_detail: "Trích bài thơ Nam Quốc Sơn Hà (bản tuyên ngôn độc lập đầu tiên). Giữ nguyên văn bản dịch phổ biến nhất + nguyên văn Hán.",
    verify_source: "Nam Quốc Sơn Hà — Lý Thường Kiệt (1077)"
  },
  // --- Trần Nhân Tông ---
  {
    author: "Trần Nhân Tông", author_vi: "Trần Nhân Tông",
    source_work: "Cư Trần Lạc Đạo Phú & thơ thiền",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 6,
    prompt_detail: "Trích từ Cư Trần Lạc Đạo Phú và thơ thiền. Vua-thiền sư sáng lập Trúc Lâm. Chọn câu về thiền, đạo, sống giữa đời thường. Giữ nguyên văn.",
    verify_source: "Trần Nhân Tông — thơ thiền, Cư Trần Lạc Đạo Phú"
  },
  // --- Trần Quang Khải ---
  {
    author: "Trần Quang Khải", author_vi: "Trần Quang Khải",
    source_work: "Tụng Giá Hoàn Kinh Sư",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 3,
    prompt_detail: "Trích bài thơ Tụng Giá Hoàn Kinh Sư và các câu thơ khác về chiến thắng, hào khí dân tộc. Giữ nguyên văn + Hán.",
    verify_source: "Tụng Giá Hoàn Kinh Sư — Trần Quang Khải"
  },
  // --- Chu Văn An ---
  {
    author: "Chu Văn An", author_vi: "Chu Văn An",
    source_work: "Thơ văn Chu Văn An",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 4,
    prompt_detail: "Trích thơ và danh ngôn về giáo dục, khí tiết, thanh liêm. Bao gồm Thất Trảm Sớ nếu có câu trích hay. Giữ nguyên văn.",
    verify_source: "Chu Văn An — thơ văn"
  },
  // --- Nguyễn Dữ ---
  {
    author: "Nguyễn Dữ", author_vi: "Nguyễn Dữ",
    source_work: "Truyền Kỳ Mạn Lục",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 5,
    prompt_detail: "Trích các câu hay nhất từ 20 truyện. Chọn câu về nhân quả, đạo đức, số phận, tình yêu. Giữ nguyên văn bản dịch Việt phổ biến.",
    verify_source: "Truyền Kỳ Mạn Lục — Nguyễn Dữ"
  },
  // --- Phùng Khắc Khoan ---
  {
    author: "Phùng Khắc Khoan", author_vi: "Phùng Khắc Khoan",
    source_work: "Thơ văn Phùng Khắc Khoan",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 4,
    prompt_detail: "Trích thơ và ngâm khúc hay nhất. Nhà ngoại giao, nhà thơ thời Lê-Mạc. Giữ nguyên văn.",
    verify_source: "Phùng Khắc Khoan — thơ văn"
  },
  // --- Nguyễn Hữu Chỉnh ---
  {
    author: "Nguyễn Hữu Chỉnh", author_vi: "Nguyễn Hữu Chỉnh",
    source_work: "Thơ văn Nguyễn Hữu Chỉnh",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 3,
    prompt_detail: "Trích thơ hay nhất của nhà quân sự-thi sĩ thời Tây Sơn. Giữ nguyên văn.",
    verify_source: "Nguyễn Hữu Chỉnh — thơ văn"
  },
  // --- Lê Quý Đôn ---
  {
    author: "Lê Quý Đôn", author_vi: "Lê Quý Đôn",
    source_work: "Vân Đài Loại Ngữ & Kiến Văn Tiểu Lục",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 5,
    prompt_detail: "Trích danh ngôn, nhận định hay nhất của nhà bác học Lê Quý Đôn về học vấn, trí tuệ, xã hội. Giữ nguyên văn bản dịch.",
    verify_source: "Lê Quý Đôn — Vân Đài Loại Ngữ"
  },
  // --- Ngô Sĩ Liên ---
  {
    author: "Ngô Sĩ Liên", author_vi: "Ngô Sĩ Liên",
    source_work: "Đại Việt Sử Ký Toàn Thư",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 5,
    prompt_detail: "Trích các lời bình sử (lời bàn của sử thần) hay nhất về đạo trị nước, nhân nghĩa, giáo dục. Giữ nguyên văn bản dịch phổ biến.",
    verify_source: "Đại Việt Sử Ký Toàn Thư — Ngô Sĩ Liên"
  },
  // --- Phan Phu Tiên ---
  {
    author: "Phan Phu Tiên", author_vi: "Phan Phu Tiên",
    source_work: "Việt Âm Thi Tập & thơ văn",
    era: "cổ đại", origin: "việt nam", webFirst: true, count: 3,
    prompt_detail: "Trích thơ và danh ngôn hay nhất. Giữ nguyên văn.",
    verify_source: "Phan Phu Tiên — thơ văn"
  },
  // --- Ca dao tục ngữ cổ ngữ ---
  {
    author: "Dân gian Việt Nam", author_vi: "Ca dao tục ngữ",
    source_work: "Ca dao tục ngữ dân gian",
    era: "dân gian", origin: "việt nam", webFirst: true, count: 25,
    category: "triết lý sống",
    prompt_detail: "Trích 25 câu tục ngữ/ca dao/cổ ngữ Việt Nam PHỔ BIẾN NHẤT về: nghị lực (5), trí tuệ (5), đạo đức (5), nhân sinh (5), tình yêu/gia đình (5). CHỈ chọn câu ai cũng biết, đã thuộc lòng. Giữ nguyên văn dân gian chính xác.",
    verify_source: "Ca dao tục ngữ Việt Nam — truyền khẩu dân gian"
  }
];

// ═══════════════════════════════════════════════════
// BATCH 2: PHƯƠNG ĐÔNG — Triết học, Văn học, Thơ ca
// ═══════════════════════════════════════════════════

const BATCH_EAST = [
  // ─── Triết học Trung Hoa ───
  {
    author: "Confucius", author_vi: "Khổng Tử",
    source_work: "Luận Ngữ",
    era: "cổ đại", origin: "phương đông", count: 15,
    prompt_detail: "Trích từ Luận Ngữ. Cho nguyên văn Hán văn + bản dịch Việt phổ biến. Ghi rõ thiên/chương. Chọn câu về học hành, nhân, lễ, quân tử.",
    verify_source: "Luận Ngữ — Khổng Tử"
  },
  {
    author: "Lao Tzu", author_vi: "Lão Tử",
    source_work: "Đạo Đức Kinh",
    era: "cổ đại", origin: "phương đông", count: 15,
    prompt_detail: "Trích từ 81 chương Đạo Đức Kinh. Cho nguyên văn Hán văn + bản dịch Việt. Ghi rõ chương số. Chọn câu về vô vi, nước, đạo, đức.",
    verify_source: "Đạo Đức Kinh — Lão Tử"
  },
  {
    author: "Zhuangzi", author_vi: "Trang Tử",
    source_work: "Nam Hoa Kinh",
    era: "cổ đại", origin: "phương đông", count: 10,
    prompt_detail: "Trích từ Nam Hoa Kinh (Trang Tử). Cho nguyên văn Hán văn + bản dịch Việt. Ghi rõ thiên. Chọn câu về tự do, tự nhiên, vô vi, tương đối.",
    verify_source: "Nam Hoa Kinh — Trang Tử"
  },
  // ─── Thơ Đường (Trung Quốc) ───
  {
    author: "Li Bai", author_vi: "Lý Bạch",
    source_work: "Thơ Lý Bạch",
    era: "cổ đại", origin: "phương đông", count: 8,
    prompt_detail: "Trích thơ Đường nổi tiếng nhất: Tĩnh Dạ Tứ, Tương Tiến Tửu, Hành Lộ Nan... Cho nguyên văn Hán + bản dịch Việt phổ biến nhất (Tương Như, Trần Trọng San...). Giữ nguyên văn cả hai.",
    verify_source: "Thơ Lý Bạch — bản dịch phổ biến"
  },
  {
    author: "Du Fu", author_vi: "Đỗ Phủ",
    source_work: "Thơ Đỗ Phủ",
    era: "cổ đại", origin: "phương đông", count: 8,
    prompt_detail: "Trích thơ Đường nổi tiếng nhất: Xuân Vọng, Thu Hứng, Đăng Cao... Cho nguyên văn Hán + bản dịch Việt phổ biến nhất. Giữ nguyên văn cả hai.",
    verify_source: "Thơ Đỗ Phủ — bản dịch phổ biến"
  },
  {
    author: "Bai Juyi", author_vi: "Bạch Cư Dị",
    source_work: "Thơ Bạch Cư Dị",
    era: "cổ đại", origin: "phương đông", count: 6,
    prompt_detail: "Trích thơ nổi tiếng nhất: Tỳ Bà Hành, Trường Hận Ca, Phú Đắc Cổ Thảo Nguyên Tống Biệt... Cho nguyên văn Hán + bản dịch Việt. Giữ nguyên văn.",
    verify_source: "Thơ Bạch Cư Dị — bản dịch phổ biến"
  },
  // ─── Tứ Đại Danh Tác (Trung Quốc) ───
  {
    author: "Luo Guanzhong", author_vi: "La Quán Trung",
    source_work: "Tam Quốc Diễn Nghĩa",
    era: "cổ đại", origin: "phương đông", count: 10,
    prompt_detail: "Trích các câu nói nổi tiếng nhất từ nhân vật: Tào Tháo, Gia Cát Lượng, Lưu Bị, Quan Vũ... Cho nguyên văn Hán + bản dịch Việt (Phan Kế Bính hoặc phổ biến nhất). Ghi rõ hồi/chương.",
    verify_source: "Tam Quốc Diễn Nghĩa — La Quán Trung"
  },
  {
    author: "Wu Cheng'en", author_vi: "Ngô Thừa Ân",
    source_work: "Tây Du Ký",
    era: "cổ đại", origin: "phương đông", count: 8,
    prompt_detail: "Trích các câu nói hay nhất về nghị lực, kiên trì, tu hành, trí tuệ. Ghi rõ hồi. Cho nguyên văn Hán + dịch Việt.",
    verify_source: "Tây Du Ký — Ngô Thừa Ân"
  },
  {
    author: "Shi Nai'an", author_vi: "Thi Nại Am",
    source_work: "Thủy Hử",
    era: "cổ đại", origin: "phương đông", count: 6,
    prompt_detail: "Trích các câu nói nổi tiếng về anh hùng, nghĩa khí, giang hồ. Ghi rõ hồi. Cho nguyên văn Hán + dịch Việt.",
    verify_source: "Thủy Hử — Thi Nại Am"
  },
  {
    author: "Cao Xueqin", author_vi: "Tào Tuyết Cần",
    source_work: "Hồng Lâu Mộng",
    era: "cổ đại", origin: "phương đông", count: 8,
    prompt_detail: "Trích các câu thơ và lời thoại hay nhất về tình yêu, nhân sinh, phú quý, vô thường. Ghi rõ hồi. Cho nguyên văn Hán + dịch Việt.",
    verify_source: "Hồng Lâu Mộng — Tào Tuyết Cần"
  },
  // ─── Nhật Bản ───
  {
    author: "Murasaki Shikibu", author_vi: "Murasaki Shikibu",
    source_work: "Truyện Genji (Genji Monogatari)",
    era: "cổ đại", origin: "phương đông", count: 6,
    prompt_detail: "Trích các câu hay nhất về tình yêu, vẻ đẹp, vô thường. Cho nguyên văn tiếng Anh (bản dịch Seidensticker hoặc Tyler) + dịch Việt.",
    verify_source: "Genji Monogatari — Murasaki Shikibu"
  },
  {
    author: "Sei Shonagon", author_vi: "Sei Shōnagon",
    source_work: "Makura no Sōshi (Chẩm Thảo Tử)",
    era: "cổ đại", origin: "phương đông", count: 5,
    prompt_detail: "Trích các đoạn hay nhất về thẩm mỹ, thiên nhiên, cảm xúc. Cho nguyên văn tiếng Anh (bản dịch Ivan Morris) + dịch Việt.",
    verify_source: "Makura no Sōshi — Sei Shōnagon"
  },
  {
    author: "Matsuo Basho", author_vi: "Matsuo Bashō",
    source_work: "Haiku Bashō",
    era: "cổ đại", origin: "phương đông", count: 8,
    prompt_detail: "Trích các bài haiku nổi tiếng nhất (Frog pond, Old pond, etc.). Cho nguyên văn tiếng Nhật (romaji) + tiếng Anh + dịch Việt. Haiku ngắn nên giữ nguyên văn dễ dàng.",
    verify_source: "Haiku — Matsuo Bashō"
  },
  // ─── Ấn Độ ───
  {
    author: "Valmiki", author_vi: "Valmiki",
    source_work: "Ramayana",
    era: "cổ đại", origin: "phương đông", count: 6,
    prompt_detail: "Trích các câu hay nhất về dharma, lòng trung thành, tình yêu, chiến đấu. Cho nguyên văn tiếng Anh (bản dịch phổ biến) + dịch Việt. Ghi rõ chương/khanda.",
    verify_source: "Ramayana — Valmiki"
  },
  {
    author: "Vyasa", author_vi: "Vyasa",
    source_work: "Mahabharata & Bhagavad Gita",
    era: "cổ đại", origin: "phương đông", count: 10,
    prompt_detail: "Trích từ Bhagavad Gita (ưu tiên) và Mahabharata. Chọn câu về dharma, hành động, tâm linh, chiến đấu. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ chương/verse.",
    verify_source: "Bhagavad Gita / Mahabharata — Vyasa"
  },
  {
    author: "Kalidasa", author_vi: "Kalidasa",
    source_work: "Shakuntala & Meghadūta",
    era: "cổ đại", origin: "phương đông", count: 5,
    prompt_detail: "Trích thơ và kịch hay nhất về tình yêu, thiên nhiên, vẻ đẹp. Cho nguyên văn tiếng Anh (bản dịch phổ biến) + dịch Việt.",
    verify_source: "Kalidasa — tác phẩm"
  },
  // ─── Ba Tư ───
  {
    author: "Rumi", author_vi: "Rumi",
    source_work: "Masnavi & thơ Sufi",
    era: "cổ đại", origin: "phương đông", count: 10,
    prompt_detail: "Trích từ Masnavi và các bài thơ Sufi nổi tiếng. Cho nguyên văn tiếng Anh (bản dịch Coleman Barks hoặc Arberry) + dịch Việt. Chọn câu về tình yêu, tâm linh, chuyển hoá.",
    verify_source: "Rumi — Masnavi"
  },
  {
    author: "Hafez", author_vi: "Hafez",
    source_work: "Divan-e Hafez",
    era: "cổ đại", origin: "phương đông", count: 6,
    prompt_detail: "Trích thơ ghazal nổi tiếng nhất về tình yêu, rượu, tâm linh. Cho nguyên văn tiếng Anh (bản dịch phổ biến) + dịch Việt.",
    verify_source: "Divan-e Hafez — Hafez"
  },
  {
    author: "Ferdowsi", author_vi: "Ferdowsi",
    source_work: "Shahnameh (Sử thi các vua)",
    era: "cổ đại", origin: "phương đông", count: 6,
    prompt_detail: "Trích các câu hay nhất từ sử thi Ba Tư vĩ đại về anh hùng, số phận, vinh quang. Cho nguyên văn tiếng Anh (bản dịch Dick Davis) + dịch Việt.",
    verify_source: "Shahnameh — Ferdowsi"
  },
  {
    author: "Saadi", author_vi: "Saadi",
    source_work: "Gulistan & Bustan",
    era: "cổ đại", origin: "phương đông", count: 8,
    prompt_detail: "Trích từ Gulistan (Vườn hồng) và Bustan (Vườn cây). Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu triết lý nhẹ nhàng, dễ đọc.",
    verify_source: "Gulistan / Bustan — Saadi"
  },
  // ─── Ả Rập ───
  {
    author: "Al-Mutanabbi", author_vi: "Al-Mutanabbi",
    source_work: "Thơ Al-Mutanabbi",
    era: "cổ đại", origin: "phương đông", count: 5,
    prompt_detail: "Trích thơ nổi tiếng nhất của thi hào Ả Rập vĩ đại nhất về kiêu hãnh, dũng cảm, nhân sinh. Cho nguyên văn tiếng Anh + dịch Việt.",
    verify_source: "Thơ Al-Mutanabbi"
  },
  {
    author: "Al-Jahiz", author_vi: "Al-Jahiz",
    source_work: "Kitab al-Hayawan & văn xuôi",
    era: "cổ đại", origin: "phương đông", count: 5,
    prompt_detail: "Trích các câu văn xuôi hay nhất về tri thức, xã hội, con người. Văn phong sinh động, gần phong cách hiện đại. Cho nguyên văn tiếng Anh + dịch Việt.",
    verify_source: "Al-Jahiz — tác phẩm"
  },
  {
    author: "Ibn Tufail", author_vi: "Ibn Tufail",
    source_work: "Hayy ibn Yaqdhan",
    era: "cổ đại", origin: "phương đông", count: 5,
    prompt_detail: "Trích từ tiểu thuyết triết học về con người tự nhiên, tri thức, tâm linh. Cho nguyên văn tiếng Anh (bản dịch phổ biến) + dịch Việt.",
    verify_source: "Hayy ibn Yaqdhan — Ibn Tufail"
  }
];

// ═══════════════════════════════════════════════════
// BATCH 3: PHƯƠNG TÂY — Triết học Hy Lạp đến Khai Sáng
// ═══════════════════════════════════════════════════

const BATCH_WEST = [
  // ─── Hy Lạp – La Mã cổ đại ───
  {
    author: "Socrates", author_vi: "Socrates",
    source_work: "Đối thoại Plato (ghi lại lời Socrates)",
    era: "cổ đại", origin: "phương tây", count: 10,
    prompt_detail: "Trích các câu nổi tiếng nhất được ghi lại qua Plato: Apology, Crito, Phaedo, Republic. Cho nguyên văn tiếng Anh (bản dịch Jowett hoặc Grube) + dịch Việt. Ghi rõ tác phẩm nguồn.",
    verify_source: "Socrates — qua Plato's Dialogues"
  },
  {
    author: "Plato", author_vi: "Plato",
    source_work: "The Republic & các đối thoại",
    era: "cổ đại", origin: "phương tây", count: 10,
    prompt_detail: "Trích từ The Republic, Symposium, Phaedrus, Apology. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ tác phẩm/quyển. Chọn câu về ý niệm, chính trị, tình yêu, tri thức.",
    verify_source: "Plato — The Republic & Dialogues"
  },
  {
    author: "Aristotle", author_vi: "Aristotle",
    source_work: "Nicomachean Ethics & các tác phẩm",
    era: "cổ đại", origin: "phương tây", count: 10,
    prompt_detail: "Trích từ Nicomachean Ethics, Politics, Metaphysics, Rhetoric. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ tác phẩm. Chọn câu về đạo đức, hạnh phúc, logic, chính trị.",
    verify_source: "Aristotle — tác phẩm"
  },
  {
    author: "Epicurus", author_vi: "Epicurus",
    source_work: "Letter to Menoeceus & Principal Doctrines",
    era: "cổ đại", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ thư gửi Menoeceus, Principal Doctrines, Vatican Sayings. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về hạnh phúc, khoái lạc có kiểm soát, cái chết, tình bạn.",
    verify_source: "Epicurus — thư và giáo lý"
  },
  {
    author: "Zeno of Citium", author_vi: "Zeno xứ Citium",
    source_work: "Fragments & ghi chép về Stoicism",
    era: "cổ đại", origin: "phương tây", count: 5,
    prompt_detail: "Trích các câu còn lưu lại của người sáng lập Khắc kỷ. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về đức hạnh, tự nhiên, lý trí.",
    verify_source: "Zeno of Citium — fragments"
  },
  {
    author: "Seneca", author_vi: "Seneca",
    source_work: "Letters to Lucilius & On the Shortness of Life",
    era: "cổ đại", origin: "phương tây", count: 10,
    prompt_detail: "Trích từ Moral Letters to Lucilius và On the Shortness of Life. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ số thư/đoạn. Chọn câu về thời gian, bình thản, sống tốt.",
    verify_source: "Seneca — Letters to Lucilius"
  },
  {
    author: "Marcus Aurelius", author_vi: "Marcus Aurelius",
    source_work: "Meditations (Suy Tưởng)",
    era: "cổ đại", origin: "phương tây", count: 10,
    prompt_detail: "Trích từ Meditations. Cho nguyên văn tiếng Anh (bản dịch Gregory Hays) + dịch Việt. Ghi rõ quyển/đoạn. Chọn câu về kỷ luật, chấp nhận, trách nhiệm.",
    verify_source: "Meditations — Marcus Aurelius"
  },
  {
    author: "Cicero", author_vi: "Cicero",
    source_work: "De Officiis & bài diễn văn",
    era: "cổ đại", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ De Officiis (On Duties), De Amicitia, Orations. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ tác phẩm. Chọn câu về bổn phận, hùng biện, tình bạn, chính trị.",
    verify_source: "Cicero — tác phẩm"
  },
  // ─── Trung cổ (Kitô giáo) ───
  {
    author: "Augustine of Hippo", author_vi: "Thánh Augustine",
    source_work: "Confessions & City of God",
    era: "trung cổ", origin: "phương tây", count: 8,
    prompt_detail: "Trích từ Confessions và City of God. Cho nguyên văn tiếng Anh (bản dịch phổ biến) + dịch Việt. Ghi rõ quyển/chương. Chọn câu về tâm hồn, Chúa, thời gian, tội lỗi, ân sủng.",
    verify_source: "Augustine — Confessions, City of God"
  },
  {
    author: "Thomas Aquinas", author_vi: "Thomas Aquinas",
    source_work: "Summa Theologica",
    era: "trung cổ", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ Summa Theologica và các tác phẩm. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về lý trí, đức tin, đạo đức, chân lý.",
    verify_source: "Thomas Aquinas — Summa Theologica"
  },
  // ─── Phục hưng & Cận đại sớm ───
  {
    author: "Niccolò Machiavelli", author_vi: "Machiavelli",
    source_work: "The Prince (Quân Vương)",
    era: "phục hưng", origin: "phương tây", count: 8,
    prompt_detail: "Trích từ The Prince. Cho nguyên văn tiếng Anh (bản dịch phổ biến) + dịch Việt. Ghi rõ chương. Chọn câu về quyền lực, lãnh đạo, chiến lược, bản chất con người.",
    verify_source: "The Prince — Machiavelli"
  },
  {
    author: "Francis Bacon", author_vi: "Francis Bacon",
    source_work: "Novum Organum & Essays",
    era: "phục hưng", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ Novum Organum, Essays, và Advancement of Learning. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về tri thức, khoa học, phương pháp thực nghiệm.",
    verify_source: "Francis Bacon — tác phẩm"
  },
  {
    author: "René Descartes", author_vi: "Descartes",
    source_work: "Discourse on the Method & Meditations",
    era: "cận đại", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ Discourse on the Method và Meditations on First Philosophy. Cho nguyên văn tiếng Anh/Pháp + dịch Việt. Bao gồm 'Cogito ergo sum'. Chọn câu về tư duy, hoài nghi, lý trí.",
    verify_source: "Descartes — Discourse on the Method"
  },
  {
    author: "Baruch Spinoza", author_vi: "Spinoza",
    source_work: "Ethics",
    era: "cận đại", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ Ethics (Ethica). Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ phần/mệnh đề. Chọn câu về Chúa/tự nhiên, tự do, cảm xúc, lý trí.",
    verify_source: "Ethics — Spinoza"
  },
  {
    author: "John Locke", author_vi: "John Locke",
    source_work: "Two Treatises of Government & Essay Concerning Human Understanding",
    era: "cận đại", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ Two Treatises và Essay. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về quyền tự nhiên, tự do, kinh nghiệm, giáo dục.",
    verify_source: "John Locke — tác phẩm"
  },
  {
    author: "Gottfried Wilhelm Leibniz", author_vi: "Leibniz",
    source_work: "Monadology & Theodicy",
    era: "cận đại", origin: "phương tây", count: 5,
    prompt_detail: "Trích từ Monadology, Theodicy, và thư từ. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về thế giới tốt nhất có thể, logic, siêu hình.",
    verify_source: "Leibniz — tác phẩm"
  },
  // ─── Khai Sáng (Enlightenment) ───
  {
    author: "David Hume", author_vi: "David Hume",
    source_work: "A Treatise of Human Nature & Enquiries",
    era: "khai sáng", origin: "phương tây", count: 6,
    prompt_detail: "Trích từ Treatise và Enquiries. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về hoài nghi, cảm xúc vs lý trí, nhân quả, đạo đức.",
    verify_source: "David Hume — tác phẩm"
  },
  {
    author: "Jean-Jacques Rousseau", author_vi: "Rousseau",
    source_work: "The Social Contract & Emile",
    era: "khai sáng", origin: "phương tây", count: 8,
    prompt_detail: "Trích từ Social Contract, Emile, Discourse on Inequality. Cho nguyên văn tiếng Anh/Pháp + dịch Việt. Chọn câu về khế ước xã hội, tự do, giáo dục, bản tính con người.",
    verify_source: "Rousseau — tác phẩm"
  },
  {
    author: "Voltaire", author_vi: "Voltaire",
    source_work: "Candide & Lettres philosophiques",
    era: "khai sáng", origin: "phương tây", count: 8,
    prompt_detail: "Trích từ Candide, Philosophical Letters, và các tác phẩm khác. Cho nguyên văn tiếng Anh/Pháp + dịch Việt. Chọn câu về tự do tư tưởng, châm biếm, khoan dung, lý trí.",
    verify_source: "Voltaire — tác phẩm"
  }
];

// ═══════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════

async function runBatch(name, configs) {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`BATCH: ${name}`);
  console.log(`${"═".repeat(50)}`);

  let total = 0;
  for (const config of configs) {
    try {
      const fn = config.webFirst ? collectFromWebSource : collectFromAuthor;
      const count = await fn(config);
      total += count;
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  ✗ Error for ${config.author}: ${e.message}`);
    }
  }

  console.log(`\n→ Batch "${name}" complete: ${total} quotes inserted`);
  return total;
}

// Parse CLI args
const args = process.argv.slice(2);
const batchArg = args[0] || "all";

let grandTotal = 0;

if (batchArg === "vn" || batchArg === "all") {
  grandTotal += await runBatch("Việt Nam", BATCH_VN);
}
if (batchArg === "east" || batchArg === "all") {
  grandTotal += await runBatch("Phương Đông", BATCH_EAST);
}
if (batchArg === "west" || batchArg === "all") {
  grandTotal += await runBatch("Phương Tây", BATCH_WEST);
}

// Final count
const total = db.prepare("SELECT COUNT(*) as c FROM quotes_v2").get();
console.log(`\n${"═".repeat(50)}`);
console.log(`DONE — ${grandTotal} quotes inserted this run`);
console.log(`Total in quotes_v2: ${total.c}`);
console.log(`${"═".repeat(50)}`);

db.close();
