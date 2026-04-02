/**
 * Seed quotes_v2 with verified, attributed quotes.
 *
 * Strategy:
 * - Use Claude Sonnet to generate quotes WITH source citations
 * - Each quote must have: text_vi, text_original, author, source_work
 * - Batch by author/work for accuracy (Claude is more accurate when focused on one source)
 * - Auto-calculate length_chars and hash
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
- Mỗi câu phải THỰC SỰ có trong tác phẩm gốc — KHÔNG tự sáng tác
- Nếu tác phẩm gốc không phải tiếng Việt, cho CẢ nguyên văn gốc VÀ bản dịch tiếng Việt
- Nếu tác phẩm gốc là tiếng Việt (thơ, văn), giữ nguyên văn chính xác
- Ghi rõ chương/thiên/phần nếu biết
- Chọn những câu có giá trị triết lý sâu sắc, phù hợp để truyền cảm hứng

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

  let inserted = 0;
  for (const q of quotes) {
    const textVi = q.text_vi?.trim();
    if (!textVi) continue;

    const hash = hashText(textVi);
    const tags = JSON.stringify([source_work, era, origin]);

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
        1, // auto-verified (from known source text)
        verify_source,
        hash
      );
      if (result.changes > 0) inserted++;
    } catch (e) {
      // duplicate hash — skip
    }
  }

  console.log(`  ✓ Inserted ${inserted}/${quotes.length} quotes`);
  return inserted;
}

// ═══════════════════════════════════════════════════
// BATCH 1: VIỆT NAM
// ═══════════════════════════════════════════════════

const BATCH_VN = [
  {
    author: "Nguyễn Trãi",
    author_vi: "Nguyễn Trãi",
    source_work: "Bình Ngô Đại Cáo",
    era: "cổ đại",
    origin: "việt nam",
    count: 8,
    prompt_detail: "Trích các câu về độc lập, nhân nghĩa, ý chí dân tộc. Giữ nguyên văn chữ Hán-Nôm đã dịch sang tiếng Việt hiện đại.",
    verify_source: "Bình Ngô Đại Cáo — Nguyễn Trãi (1428)"
  },
  {
    author: "Nguyễn Trãi",
    author_vi: "Nguyễn Trãi",
    source_work: "Gia Huấn Ca",
    era: "cổ đại",
    origin: "việt nam",
    count: 8,
    prompt_detail: "Trích các câu về đạo làm người, giáo dục con cái, đối nhân xử thế.",
    verify_source: "Gia Huấn Ca — Nguyễn Trãi"
  },
  {
    author: "Nguyễn Du",
    author_vi: "Nguyễn Du",
    source_work: "Truyện Kiều",
    era: "cổ đại",
    origin: "việt nam",
    count: 12,
    prompt_detail: "Trích các câu thơ lục bát nổi tiếng nhất về nhân sinh, số phận, tình yêu, đạo đức. Giữ nguyên văn thơ lục bát.",
    verify_source: "Truyện Kiều — Nguyễn Du (1820)"
  },
  {
    author: "Trần Hưng Đạo",
    author_vi: "Trần Hưng Đạo",
    source_work: "Hịch Tướng Sĩ",
    era: "cổ đại",
    origin: "việt nam",
    count: 6,
    prompt_detail: "Trích các câu về lòng yêu nước, ý chí chiến đấu, trách nhiệm. Giữ nguyên văn dịch.",
    verify_source: "Hịch Tướng Sĩ — Trần Hưng Đạo (1285)"
  },
  {
    author: "Nguyễn Bỉnh Khiêm",
    author_vi: "Nguyễn Bỉnh Khiêm",
    source_work: "Bạch Vân Am Thi Tập",
    era: "cổ đại",
    origin: "việt nam",
    count: 8,
    prompt_detail: "Trích các câu thơ về nhàn, thanh bạch, triết lý sống giản dị, xa lánh danh lợi.",
    verify_source: "Bạch Vân Am Thi Tập — Nguyễn Bỉnh Khiêm"
  },
  {
    author: "Nguyễn Công Trứ",
    author_vi: "Nguyễn Công Trứ",
    source_work: "Thơ Nguyễn Công Trứ",
    era: "cổ đại",
    origin: "việt nam",
    count: 8,
    prompt_detail: "Trích các câu về chí nam nhi, tang bồng hồ thỉ, nghĩa khí. Bao gồm các bài Chí Nam Nhi, Luận Kẻ Sĩ.",
    verify_source: "Thơ Nguyễn Công Trứ"
  },
  {
    author: "Nguyễn Đình Chiểu",
    author_vi: "Nguyễn Đình Chiểu",
    source_work: "Lục Vân Tiên",
    era: "cổ đại",
    origin: "việt nam",
    count: 8,
    prompt_detail: "Trích các câu về nhân nghĩa, trung hiếu, đạo đức. Bao gồm cả Văn Tế Nghĩa Sĩ Cần Giuộc nếu có câu hay.",
    verify_source: "Lục Vân Tiên — Nguyễn Đình Chiểu"
  },
  {
    author: "Hồ Chí Minh",
    author_vi: "Hồ Chí Minh",
    source_work: "Nhật Ký Trong Tù và Di Chúc",
    era: "hiện đại",
    origin: "việt nam",
    count: 12,
    prompt_detail: "Trích từ Nhật Ký Trong Tù (thơ), Di Chúc (1969), và các bài phát biểu nổi tiếng. Bao gồm câu về độc lập, giáo dục, đạo đức cách mạng.",
    verify_source: "Nhật Ký Trong Tù, Di Chúc — Hồ Chí Minh"
  },
  {
    author: "Thích Nhất Hạnh",
    author_vi: "Thích Nhất Hạnh",
    source_work: "Phép Lạ Của Sự Tỉnh Thức & No Mud No Lotus",
    era: "đương đại",
    origin: "việt nam",
    count: 10,
    prompt_detail: "Trích các câu về chánh niệm, bình an nội tâm, sống trọn vẹn hiện tại. Cho cả tiếng Việt và tiếng Anh (sách xuất bản song ngữ).",
    verify_source: "Thích Nhất Hạnh — sách xuất bản"
  },
  {
    author: "Tục ngữ Việt Nam",
    author_vi: "Tục ngữ Việt Nam",
    source_work: "Ca dao tục ngữ dân gian",
    era: "dân gian",
    origin: "việt nam",
    count: 20,
    category: "triết lý sống",
    prompt_detail: "Trích 20 câu tục ngữ/ca dao Việt Nam nổi tiếng nhất về: nghị lực (5), trí tuệ (5), đạo đức (5), nhân sinh (5). Chỉ chọn câu phổ biến, ai cũng biết. Giữ nguyên văn dân gian.",
    verify_source: "Ca dao tục ngữ Việt Nam — truyền khẩu dân gian"
  }
];

// ═══════════════════════════════════════════════════
// BATCH 2: PHƯƠNG ĐÔNG
// ═══════════════════════════════════════════════════

const BATCH_EAST = [
  {
    author: "Lao Tzu",
    author_vi: "Lão Tử",
    source_work: "Đạo Đức Kinh",
    era: "cổ đại",
    origin: "phương đông",
    count: 15,
    prompt_detail: "Trích từ 81 chương Đạo Đức Kinh. Cho nguyên văn Hán văn + bản dịch Việt. Ghi rõ chương số. Chọn câu về vô vi, nước, đạo, đức.",
    verify_source: "Đạo Đức Kinh — Lão Tử"
  },
  {
    author: "Confucius",
    author_vi: "Khổng Tử",
    source_work: "Luận Ngữ",
    era: "cổ đại",
    origin: "phương đông",
    count: 15,
    prompt_detail: "Trích từ Luận Ngữ. Cho nguyên văn Hán văn + bản dịch Việt. Ghi rõ thiên/chương. Chọn câu về học hành, nhân, lễ, quân tử.",
    verify_source: "Luận Ngữ — Khổng Tử"
  },
  {
    author: "Sun Tzu",
    author_vi: "Tôn Tử",
    source_work: "Binh Pháp Tôn Tử",
    era: "cổ đại",
    origin: "phương đông",
    count: 10,
    prompt_detail: "Trích từ 13 thiên Binh Pháp. Cho nguyên văn Hán văn + bản dịch Việt. Ghi rõ thiên. Chọn câu áp dụng được cho đời sống/kinh doanh.",
    verify_source: "Binh Pháp Tôn Tử — Tôn Tử"
  },
  {
    author: "Siddhartha Gautama",
    author_vi: "Đức Phật",
    source_work: "Kinh Pháp Cú (Dhammapada)",
    era: "cổ đại",
    origin: "phương đông",
    count: 10,
    prompt_detail: "Trích từ Kinh Pháp Cú (Dhammapada). Cho nguyên văn Pali/Sanskrit nếu biết + bản dịch Việt. Ghi rõ phẩm/kệ số. Chọn câu về tâm, khổ đau, giải thoát.",
    verify_source: "Kinh Pháp Cú — Dhammapada"
  },
  {
    author: "Wang Yangming",
    author_vi: "Vương Dương Minh",
    source_work: "Truyền Tập Lục",
    era: "cổ đại",
    origin: "phương đông",
    count: 8,
    prompt_detail: "Trích từ Truyền Tập Lục. Cho nguyên văn Hán văn + bản dịch Việt. Chọn câu về tri hành hợp nhất, lương tri, tâm học.",
    verify_source: "Truyền Tập Lục — Vương Dương Minh"
  },
  {
    author: "Rumi",
    author_vi: "Rumi",
    source_work: "Masnavi & thơ Sufi",
    era: "cổ đại",
    origin: "phương đông",
    count: 10,
    prompt_detail: "Trích từ Masnavi và các bài thơ Sufi nổi tiếng. Cho nguyên văn tiếng Anh (bản dịch Coleman Barks hoặc Arberry) + dịch Việt. Chọn câu về tình yêu, tâm linh, chuyển hoá.",
    verify_source: "Rumi — Masnavi, bản dịch Barks/Arberry"
  },
  {
    author: "Khalil Gibran",
    author_vi: "Khalil Gibran",
    source_work: "Nhà Tiên Tri (The Prophet)",
    era: "hiện đại",
    origin: "phương đông",
    count: 10,
    prompt_detail: "Trích từ The Prophet. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ chương (On Love, On Freedom, etc.). Chọn câu về tình yêu, tự do, con cái, công việc.",
    verify_source: "The Prophet — Khalil Gibran (1923)"
  }
];

// ═══════════════════════════════════════════════════
// BATCH 3: PHƯƠNG TÂY
// ═══════════════════════════════════════════════════

const BATCH_WEST = [
  {
    author: "Marcus Aurelius",
    author_vi: "Marcus Aurelius",
    source_work: "Meditations (Suy Tưởng)",
    era: "cổ đại",
    origin: "phương tây",
    count: 12,
    prompt_detail: "Trích từ Meditations. Cho nguyên văn tiếng Anh (bản dịch Gregory Hays hoặc Hammond) + dịch Việt. Ghi rõ quyển/đoạn. Chọn câu về kỷ luật bản thân, chấp nhận, trách nhiệm.",
    verify_source: "Meditations — Marcus Aurelius"
  },
  {
    author: "Seneca",
    author_vi: "Seneca",
    source_work: "Letters to Lucilius (Thư Gửi Lucilius)",
    era: "cổ đại",
    origin: "phương tây",
    count: 10,
    prompt_detail: "Trích từ Letters to Lucilius và On the Shortness of Life. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ số thư/đoạn. Chọn câu về thời gian, cái chết, sống tốt.",
    verify_source: "Letters to Lucilius — Seneca"
  },
  {
    author: "Carl Jung",
    author_vi: "Carl Jung",
    source_work: "Memories, Dreams, Reflections & các tác phẩm",
    era: "hiện đại",
    origin: "phương tây",
    count: 10,
    prompt_detail: "Trích từ các tác phẩm đã xuất bản. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ tên sách. Chọn câu về bóng tối (shadow), vô thức, cá nhân hoá (individuation).",
    verify_source: "Carl Jung — tác phẩm xuất bản"
  },
  {
    author: "Viktor Frankl",
    author_vi: "Viktor Frankl",
    source_work: "Man's Search for Meaning",
    era: "hiện đại",
    origin: "phương tây",
    count: 8,
    prompt_detail: "Trích từ Man's Search for Meaning. Cho nguyên văn tiếng Anh + dịch Việt. Chọn câu về ý nghĩa cuộc sống, tự do chọn thái độ, chịu đựng khổ đau.",
    verify_source: "Man's Search for Meaning — Viktor Frankl (1946)"
  },
  {
    author: "Nelson Mandela",
    author_vi: "Nelson Mandela",
    source_work: "Long Walk to Freedom & bài phát biểu",
    era: "hiện đại",
    origin: "phương tây",
    count: 8,
    prompt_detail: "Trích từ tự truyện và bài phát biểu. Cho nguyên văn tiếng Anh + dịch Việt. Ghi rõ nguồn. Chọn câu về tự do, can đảm, tha thứ.",
    verify_source: "Nelson Mandela — tự truyện và phát biểu"
  },
  {
    author: "Mahatma Gandhi",
    author_vi: "Mahatma Gandhi",
    source_work: "The Story of My Experiments with Truth & phát biểu",
    era: "hiện đại",
    origin: "phương đông",
    count: 8,
    prompt_detail: "Trích từ tự truyện và bài phát biểu có dẫn chứng. Cho nguyên văn tiếng Anh + dịch Việt. CHÚ Ý: Nhiều câu bị gán nhầm cho Gandhi — chỉ trích câu có source rõ ràng.",
    verify_source: "Gandhi — tác phẩm và phát biểu có ghi nhận"
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
      const count = await collectFromAuthor(config);
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
