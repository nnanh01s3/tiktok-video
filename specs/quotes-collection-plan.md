# Kế Hoạch Thu Thập Danh Ngôn Chính Xác, Có Dẫn Chứng (v2)

**Cập nhật**: 2026-03-27 | **Phương pháp**: Rolling batches, không chờ đợi

## Nguyên Tắc Cốt Lõi

**Mỗi câu nói PHẢI có:**
1. Nguyên văn chính xác (hoặc bản dịch chuẩn)
2. Tên tác giả đầy đủ (cả tên gốc + tên tiếng Việt)
3. Nguồn gốc cụ thể (tên sách/tác phẩm, chương nếu có)
4. Xác minh theo tier (không đồng loạt)

**Tỷ lệ mục tiêu:** 40% Việt Nam — 30% Phương Đông — 30% Phương Tây

---

## Danh Sách Tác Giả

### Tầng 1: Việt Nam (40% — mục tiêu 320 quotes)

| Thời kỳ | Tác Giả | Tác Phẩm Chính |
|---|---|---|
| **Cổ đại** | Nguyễn Trãi | Bình Ngô Đại Cáo, Gia Huấn Ca, Quốc Âm Thi Tập |
| **Cổ đại** | Nguyễn Du | Truyện Kiều |
| **Cổ đại** | Trần Hưng Đạo | Hịch Tướng Sĩ |
| **Cổ đại** | Lê Thánh Tông | Thơ và chiếu chỉ |
| **Cổ đại** | Nguyễn Bỉnh Khiêm | Bạch Vân Am Thi Tập |
| **Cổ đại** | Nguyễn Công Trứ | Thơ chí nam nhi |
| **Cổ đại** | Cao Bá Quát | Thơ khí phách |
| **Cổ đại** | Nguyễn Đình Chiểu | Lục Vân Tiên, Văn tế nghĩa sĩ Cần Giuộc |
| **Cổ đại** | Đoàn Thị Điểm | Chinh Phụ Ngâm (bản dịch) |
| **Cổ đại** | Hồ Xuân Hương | Thơ trào phúng |
| **Cận đại** | Phan Bội Châu | Các bài viết cách mạng |
| **Cận đại** | Phan Châu Trinh | Bài diễn thuyết, thư |
| **Hiện đại** | Hồ Chí Minh | Di chúc, Nhật ký trong tù, bài phát biểu |
| **Hiện đại** | Võ Nguyên Giáp | Hồi ký, phỏng vấn |
| **Đương đại** | Thích Nhất Hạnh | Phép Lạ Của Sự Tỉnh Thức, No Mud No Lotus |
| **Dân gian** | Tục ngữ Việt Nam | Ca dao, tục ngữ truyền miệng |

### Tầng 2: Phương Đông (30% — mục tiêu 240 quotes)

| Truyền thống | Tác Giả | Tác Phẩm |
|---|---|---|
| **Đạo giáo** | Lão Tử | Đạo Đức Kinh |
| **Nho giáo** | Khổng Tử | Luận Ngữ |
| **Nho giáo** | Mạnh Tử | Mạnh Tử |
| **Tâm học** | Vương Dương Minh | Truyền Tập Lục |
| **Binh pháp** | Tôn Tử | Binh Pháp Tôn Tử |
| **Phật giáo** | Đức Phật | Kinh Pháp Cú (Dhammapada) |
| **Thiền tông** | Huệ Năng | Pháp Bảo Đàn Kinh |
| **Trung Quốc** | Trang Tử | Nam Hoa Kinh |
| **Nhật Bản** | Miyamoto Musashi | Ngũ Luân Thư |
| **Ấn Độ** | Mahatma Gandhi | Tự truyện, bài phát biểu |
| **Ấn Độ** | Rabindranath Tagore | Gitanjali |
| **Ba Tư** | Rumi | Masnavi, thơ Sufi |
| **Liban** | Khalil Gibran | Nhà Tiên Tri (The Prophet) |
| **Hàn Quốc** | Yi Sun-sin | Nanjung Ilgi |

### Tầng 3: Phương Tây & Toàn Cầu (30% — mục tiêu 240 quotes)

| Truyền thống | Tác Giả | Tác Phẩm |
|---|---|---|
| **Stoicism** | Marcus Aurelius | Meditations |
| **Stoicism** | Seneca | Letters to Lucilius |
| **Stoicism** | Epictetus | Discourses |
| **Triết học** | Socrates/Plato | The Republic, Apology |
| **Tâm lý** | Carl Jung | Memories, Dreams, Reflections |
| **Tâm lý** | Viktor Frankl | Man's Search for Meaning |
| **Tâm lý** | Brené Brown | Daring Greatly |
| **Khoa học** | Albert Einstein | Thư và bài giảng |
| **Lãnh đạo** | Nelson Mandela | Long Walk to Freedom |
| **Lãnh đạo** | Martin Luther King Jr. | Bài phát biểu |
| **Văn học** | Shakespeare | Hamlet, Macbeth... |
| **Hiện đại** | James Clear | Atomic Habits |
| **Hiện đại** | Ryan Holiday | The Obstacle Is the Way |

---

## Schema DB

```sql
CREATE TABLE quotes_v2 (
  id            INTEGER PRIMARY KEY,
  text_vi       TEXT    NOT NULL,
  text_original TEXT,
  author        TEXT    NOT NULL,
  author_vi     TEXT,
  source_work   TEXT,
  source_detail TEXT,
  era           TEXT,       -- cổ đại / cận đại / hiện đại / đương đại / dân gian
  origin        TEXT,       -- việt nam / phương đông / phương tây
  category      TEXT    NOT NULL,
  tags          TEXT,       -- JSON array
  tone          TEXT,       -- inspirational / philosophical / humorous / provocative / melancholic
  length_chars  INTEGER,    -- auto-calculated
  verified      INTEGER DEFAULT 0, -- 0=chưa, 1=auto-verified, 2=manual-verified
  verify_source TEXT,
  viral_score   REAL    DEFAULT 0, -- updated by analytics loop
  times_used    INTEGER DEFAULT 0,
  created_at    TEXT    DEFAULT (datetime('now')),
  used_at       TEXT
);
```

---

## Xác Minh Theo Tier

| Loại tác giả | Mức xác minh | Ví dụ |
|---|---|---|
| Kinh điển (tác phẩm gốc rõ ràng) | Xác nhận tác phẩm tồn tại | Lão Tử - Đạo Đức Kinh chương 33 |
| Tục ngữ/ca dao | Không cần attribution, chỉ đúng nội dung | "Có công mài sắt..." |
| Nhân vật lịch sử | Cross-check 2 nguồn | Hồ Chí Minh, Gandhi |
| Internet-famous (hay bị gán nhầm) | Xác minh kỹ 3 bước | Einstein, Lincoln, Churchill |
| Sách hiện đại (<50 năm) | Ghi tên sách + đảm bảo <30 từ | James Clear, Brené Brown |

---

## Thực Thi: Rolling Batches

| Batch | Nội dung | Số lượng | Thời gian |
|---|---|---|---|
| **Batch 1** | Việt Nam (cổ đại + hiện đại + tục ngữ) | 100 | Ngay |
| **Batch 2** | Phương Đông (Lão Tử, Khổng Tử, Phật, Rumi, Gibran, Vương Dương Minh) | 80 | Sau batch 1 |
| **Batch 3** | Phương Tây (Stoicism, Jung, Frankl, sách hiện đại) | 60 | Sau batch 2 |
| **Batch 4+** | Mở rộng theo analytics (tăng tác giả viral, giảm tác giả kém) | Ongoing | Hàng tuần |

Mỗi batch xong → nhập DB ngay → pipeline dùng ngay. Không chờ đợi.
