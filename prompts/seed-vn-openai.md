# Prompt: Trích dẫn Văn học Việt Nam cổ điển

> Copy toàn bộ nội dung bên dưới vào ChatGPT (GPT-4o hoặc o1).
> Chạy từng PHẦN riêng (mỗi lần 1 tác giả) để tránh output quá dài bị cắt.

---

## PHẦN CHUNG (paste trước mỗi lần chạy)

```
Bạn là chuyên gia văn học Việt Nam cổ điển. Nhiệm vụ: trích dẫn NGUYÊN VĂN các câu thơ/văn nổi tiếng từ tác phẩm được chỉ định.

QUY TẮC BẮT BUỘC:
1. PHẢI trích NGUYÊN VĂN chính xác từng chữ — KHÔNG paraphrase, KHÔNG giải nghĩa thay cho nguyên văn
2. Thơ lục bát: trích CẶP câu 6+8 đi cùng nhau, phân tách bằng \n
   VD: "Trăm năm trong cõi người ta,\nChữ tài chữ mệnh khéo là ghét nhau."
3. Thơ song thất lục bát: trích đoạn 4 câu (7-7-6-8)
4. Thơ Đường luật: trích 2-4 câu liền nhau có ý nghĩa trọn vẹn
5. Văn xuôi/cáo/hịch: trích câu/đoạn ngắn gọn, súc tích
6. Mỗi đoạn phải có ý nghĩa TRỌN VẸN — đọc một mình vẫn hiểu được
7. NẾU KHÔNG NHỚ CHÍNH XÁC, BỎ QUA — đừng đoán mò
8. Phân loại category: triết lý sống | nghị lực | tình yêu | trí tuệ | lãnh đạo | tự do | nhân sinh

FORMAT TRẢ VỀ: CHỈ trả về JSON array, KHÔNG giải thích thêm.
Mỗi item theo format:
{
  "text_vi": "nguyên văn tiếng Việt chính xác",
  "text_original": null,
  "author": "tên tác giả (Latin)",
  "author_vi": "tên tác giả tiếng Việt",
  "source_work": "tên tác phẩm",
  "source_detail": "vị trí cụ thể (phần/chương/câu số nếu biết)",
  "era": "cổ đại",
  "origin": "việt nam",
  "category": "1 trong 7 category trên",
  "tone": "inspirational | philosophical | provocative | melancholic"
}
```

---

## PHẦN 1: Nguyễn Trãi (chạy riêng)

```
Trích 15 câu/đoạn hay nhất từ các tác phẩm của Nguyễn Trãi:

1. BÌNH NGÔ ĐẠI CÁO (5 câu) — về độc lập, nhân nghĩa, ý chí dân tộc. Dùng bản dịch Nôm phổ biến nhất.
2. GIA HUẤN CA (5 câu) — thơ lục bát về đạo làm người, giáo dục con cái, đối nhân xử thế.
3. QUỐC ÂM THI TẬP (5 câu) — thơ Nôm về thiên nhiên, triết lý sống nhàn, yêu nước.
```

## PHẦN 2: Nguyễn Du — Truyện Kiều (chạy riêng)

```
Trích 20 CẶP câu thơ lục bát nổi tiếng nhất từ TRUYỆN KIỀU của Nguyễn Du.

Yêu cầu:
- Mỗi trích dẫn là 1 CẶP câu 6+8 (hoặc 2 cặp nếu ý nghĩa cần liên tục)
- Chọn đa dạng chủ đề: nhân sinh (5), số phận/tài mệnh (5), tình yêu (5), đạo đức (5)
- Ghi rõ vị trí câu số (VD: "Câu 1-2", "Câu 1015-1016")
- Truyện Kiều có 3254 câu — chọn rải đều từ đầu đến cuối

VD đúng: "Trăm năm trong cõi người ta,\nChữ tài chữ mệnh khéo là ghét nhau."
VD sai: "Nguyễn Du nói về số phận con người qua hình ảnh tài mệnh tương đố" (← đây là giải nghĩa, KHÔNG phải nguyên văn)
```

## PHẦN 3: Hồ Xuân Hương (chạy riêng)

```
Trích 10 bài/đoạn thơ nổi tiếng nhất của Hồ Xuân Hương.

Bao gồm: Bánh trôi nước, Tự tình (I, II, III), Đề đền Sầm Nghi Đống, Mời trầu, Đánh đu, Vịnh quạt...
- Mỗi bài trích 2-4 câu hay nhất (đủ ý nghĩa trọn vẹn)
- Giữ nguyên văn thơ Đường luật hoặc lục bát
```

## PHẦN 4: Nguyễn Bỉnh Khiêm (chạy riêng)

```
Trích 10 câu/đoạn thơ hay nhất từ Bạch Vân Quốc Ngữ Thi Tập của Nguyễn Bỉnh Khiêm.

Bao gồm bài "Nhàn" nổi tiếng. Chọn câu về: nhàn, thanh bạch, xa lánh danh lợi, triết lý sống giản dị.
```

## PHẦN 5: Nguyễn Gia Thiều — Cung Oán Ngâm Khúc (chạy riêng)

```
Trích 10 đoạn thơ song thất lục bát hay nhất từ CUNG OÁN NGÂM KHÚC của Nguyễn Gia Thiều.

Mỗi đoạn gồm 4 câu (7-7-6-8). Chọn về: thân phận, nỗi buồn, nhân sinh, thời gian, vô thường.
```

## PHẦN 6: Chinh Phụ Ngâm — Đặng Trần Côn / Đoàn Thị Điểm (chạy riêng)

```
Trích 10 đoạn thơ song thất lục bát hay nhất từ CHINH PHỤ NGÂM (bản dịch Nôm Đoàn Thị Điểm).

Mỗi đoạn 4 câu. Chọn về: chiến tranh, ly biệt, nỗi nhớ, thời gian, thân phận phụ nữ.
Lưu ý author: "Đặng Trần Côn", author_vi: "Đặng Trần Côn (dịch Nôm: Đoàn Thị Điểm)"
```

## PHẦN 7: Các tác giả ngắn (chạy chung 1 lần)

```
Trích nguyên văn câu/đoạn hay nhất từ các tác giả sau. Mỗi tác giả 3-5 câu:

1. LÊ THÁNH TÔNG — Hồng Đức Quốc Âm Thi Tập: thơ Nôm về đất nước, triết lý, thiên nhiên
2. LÝ THƯỜNG KIỆT — Nam Quốc Sơn Hà: bài thơ tuyên ngôn độc lập (cả bản Hán lẫn bản dịch)
3. TRẦN NHÂN TÔNG — Cư Trần Lạc Đạo Phú & thơ thiền: về thiền, sống giữa đời thường
4. TRẦN QUANG KHẢI — Tụng Giá Hoàn Kinh Sư: hào khí chiến thắng
5. CHU VĂN AN — thơ văn: giáo dục, khí tiết, thanh liêm
6. NGUYỄN DỮ — Truyền Kỳ Mạn Lục: câu hay về nhân quả, đạo đức, số phận
7. LÊ QUÝ ĐÔN — Vân Đài Loại Ngữ: danh ngôn về học vấn, trí tuệ
8. NGÔ SĨ LIÊN — Đại Việt Sử Ký Toàn Thư: lời bình sử về đạo trị nước
9. NGÔ THÌ NHẬM — thơ văn & Thiền học
10. PHAN HUY ÍCH — Dụ Am Văn Tập
11. PHÙNG KHẮC KHOAN — thơ văn
12. NGUYỄN HỮU CHỈNH — thơ văn
13. PHAN PHU TIÊN — Việt Âm Thi Tập
```

## PHẦN 8: Ca dao tục ngữ cổ ngữ (chạy riêng)

```
Trích 30 câu ca dao, tục ngữ, cổ ngữ Việt Nam PHỔ BIẾN NHẤT.

Phân bố:
- Nghị lực / kiên trì (6 câu)
- Trí tuệ / học hỏi (6 câu)
- Đạo đức / làm người (6 câu)
- Nhân sinh / triết lý sống (6 câu)
- Tình yêu / gia đình (6 câu)

CHỈ chọn câu mà người Việt nào cũng biết, đã thuộc lòng.
Lưu ý: author = "Dân gian Việt Nam", author_vi = "Ca dao tục ngữ", source_work = "Ca dao tục ngữ dân gian", era = "dân gian"
```

---

## CÁCH SEED VÀO DB

Sau khi có JSON từ OpenAI, lưu vào file `data/openai-vn-quotes.json` rồi chạy:

```bash
node scripts/import-openai-quotes.js
```

(Script import sẽ được tạo sẵn)
