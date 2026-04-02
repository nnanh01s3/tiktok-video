# Hệ Thống Kênh TikTok Tự Động — Tài Liệu Thiết Kế

**Ngày**: 2026-03-25
**Trạng thái**: Bản nháp
**Chủ sở hữu**: nnanh01

## 1. Tổng Quan

Xây dựng hệ thống tự động hoá toàn bộ quy trình tạo nội dung và kiếm tiền trên TikTok, sử dụng OpenClaw + Genviral Skill. Hệ thống chạy 24/7 trên VPS, quản lý 3 kênh theo 3 niche khác nhau với cơ chế phân tích phản hồi vòng kín (closed-loop analytics).

### Mục Tiêu

- **Doanh thu mục tiêu**: Tối thiểu $1K, mục tiêu $3K, khả năng đạt $5K/tháng vào tháng thứ 6
- **Mức độ tự động**: Hoàn toàn tự động (chỉ cần review dashboard <1 giờ/tuần)
- **Số kênh**: 3 niche (Motivation/Quotes, Dark Psychology/Facts, AI Storytelling)
- **Kiếm tiền**: Full stack (Creator Rewards + Affiliate + Brand Deals)

### Không Bao Gồm

- Tạo nội dung thủ công hoặc cần thao tác hàng ngày
- Phân phối đa nền tảng ở Phase 1 (Reels/Shorts sẽ làm sau)
- Xây dựng mô hình AI tạo video riêng

## 2. Kiến Trúc

### Một Agent Duy Nhất, Triển Khai Theo Giai Đoạn

Một OpenClaw agent quản lý cả 3 kênh, triển khai theo từng giai đoạn để giảm rủi ro.

```
┌──────────────────────────────────────────────────────┐
│              OpenClaw Agent "TikTokBot"               │
│               (chạy trên VPS 24/7)                    │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌───────────┐   ┌───────────────┐   ┌────────────┐ │
│  │ Scheduler │──▶│Content Engine │──▶│ Publisher   │ │
│  │ (Cron)    │   │               │   │ (Genviral) │ │
│  └───────────┘   └───────────────┘   └────────────┘ │
│       │               │                    │        │
│       │          ┌────┴─────┐              │        │
│       │          │ 3 Niche  │              │        │
│       │          │ Pipeline │              │        │
│       │          └──────────┘              │        │
│       │                                    ▼        │
│       │          ┌──────────────────────────┐       │
│       └─────────◀│  Analytics Feedback Loop │       │
│                  │  (chu kỳ hàng ngày)      │       │
│                  └──────────────────────────┘       │
└──────────────────────────────────────────────────────┘
```

### Các Thành Phần Chính

1. **Bộ Lập Lịch (Scheduler)**: Kích hoạt tạo nội dung theo cron. Đăng 2–3 video/ngày/kênh với jitter ngẫu nhiên (±30 phút) để tránh bị phát hiện pattern.
2. **Bộ Tạo Nội Dung (Content Engine)**: Chọn niche pipeline, tạo kịch bản, render video. Mỗi niche có pipeline riêng với công cụ và công thức nội dung khác nhau.
3. **Bộ Đăng Bài (Publisher)**: Genviral API (42 lệnh) xử lý upload, lên lịch, đăng lên TikTok với caption và hashtag đã tối ưu.
4. **Vòng Phản Hồi Phân Tích (Analytics Feedback Loop)**: Chu kỳ hàng ngày — lấy số liệu lúc 06:00, phân tích xu hướng lúc 06:15, điều chỉnh kế hoạch nội dung lúc 06:30, tạo báo cáo lúc 07:00.
5. **Kho Trạng Thái (State Store)**: Cơ sở dữ liệu SQLite (local trên VPS) theo dõi tất cả các job. Mỗi job có các trạng thái: `pending → rendering → rendered → uploading → posted → analyzed`. Khi agent khởi động lại, agent tiếp tục từ trạng thái cuối cùng — render lại nếu crash khi đang render, upload lại nếu crash khi đang upload. Phát hiện trùng lặp bằng hash nội dung video + timestamp để tránh đăng trùng.

### Phục Hồi Trạng Thái & Idempotency

Agent lưu trạng thái mỗi job vào SQLite trước mỗi bước pipeline. Khi crash/khởi động lại:
- **Crash khi đang render**: Job ở trạng thái `rendering` → agent render lại từ kịch bản
- **Crash khi đang upload**: Job ở trạng thái `rendered` → agent upload lại file video đã có
- **Crash khi đang đăng bài**: Job ở trạng thái `uploading` → agent kiểm tra Genviral API xem bài đã đăng chưa để tránh trùng lặp
- **VPS khởi động lại**: Agent tự động khởi động qua systemd, đọc SQLite để tìm các job đang chờ/đang xử lý, tiếp tục pipeline

## 3. Các Pipeline Theo Niche

### Pipeline A — Motivation/Quotes (Giai Đoạn 1)

**Công thức nội dung**: Quote + background đẹp + giọng AI + âm thanh trending
**Độ dài video**: 60–90 giây (bắt buộc để đủ điều kiện Creator Rewards). Mỗi video trình bày 3–5 quote liên quan với hiệu ứng chuyển cảnh, tạo thành format "tổng hợp quote" thay vì clip đơn lẻ.

| Bước | Công Cụ/API | Mô Tả |
|---|---|---|
| Nghiên cứu xu hướng | Genviral Analytics API | Quét âm thanh trending, hashtag trong niche motivation |
| Chọn quote | Claude/GPT API | Chọn từ cơ sở dữ liệu quote + tạo quote gốc dựa trên xu hướng |
| Thiết kế hình ảnh | Genviral Slideshow API | Slideshow thẩm mỹ với typography đẹp |
| Giọng đọc | ElevenLabs API | Giọng AI trầm, truyền cảm hứng |
| Render | Genviral | Kết hợp hình ảnh + âm thanh + nhạc trending |
| Đăng bài | Genviral Publisher | Tự động đăng với caption và hashtag đã tối ưu |

**Số lượng**: 3 video/ngày (sáng, trưa, tối — giờ cao điểm tương tác)
**Thời gian sản xuất mỗi video**: ~2–5 phút (tự động)

### Pipeline B — Dark Psychology/Facts (Giai Đoạn 2)

**Công thức nội dung**: Hook gây sốc → kiến thức tâm lý → "follow để xem thêm"
**Độ dài video**: 60–90 giây (bắt buộc để đủ điều kiện Creator Rewards). Mỗi video trình bày 2–3 sự thật tâm lý học liên quan với cấu trúc kịch tính.

| Bước | Công Cụ/API | Mô Tả |
|---|---|---|
| Nghiên cứu chủ đề | Claude API + danh sách nguồn đã chọn lọc | Tạo chủ đề từ tóm tắt sách tâm lý, bài Wikipedia về tâm lý học, và hashtag TikTok đang trending. Không scrape web hay dùng Reddit API — LLM tạo sự thật/insight gốc từ kiến thức huấn luyện, đối chiếu với cơ sở dữ liệu sự thật đã kiểm chứng (file JSON các khái niệm tâm lý đã xác minh, cập nhật hàng tháng). |
| Viết kịch bản | Claude API | Kịch bản nhấn mạnh hook (hook 3–5 giây → mang lại giá trị) |
| Tài nguyên hình ảnh | Genviral + Stock imagery | Slideshow ấn tượng với text overlay |
| Giọng đọc | ElevenLabs API | Giọng trầm, bí ẩn |
| Chỉnh sửa | Genviral | Kết hợp tất cả, tự động thêm phụ đề |
| Đăng bài | Genviral Publisher | Đăng với caption thu hút tương tác |

**Số lượng**: 2–3 video/ngày
**Thời gian sản xuất mỗi video**: ~3–8 phút (tự động)

### Pipeline C — AI Storytelling (Giai Đoạn 3)

**Công thức nội dung**: Phim ngắn 60–90 giây, kết thúc cliff-hanger → "Phần 2?"

| Bước | Công Cụ/API | Mô Tả |
|---|---|---|
| Ý tưởng câu chuyện | Claude API + phân tích xu hướng | Tạo ý tưởng từ các pattern đã viral |
| Kịch bản | Claude API | Kịch bản 60–90 giây: hook → căng thẳng → cao trào |
| Hoạt hình AI | Kling/Pika API | Tạo cảnh hoạt hình từ kịch bản |
| Giọng đọc | ElevenLabs (giọng nhân vật) | Giọng người kể chuyện + giọng nhân vật |
| Âm thanh/Nhạc | Suno/Stock audio | Nhạc nền + hiệu ứng âm thanh |
| Chỉnh sửa | FFmpeg + custom OpenClaw skill | Ghép cảnh, đồng bộ âm thanh, thêm phụ đề |
| Đăng bài | Genviral Publisher | Đăng với caption teaser câu chuyện |

**Số lượng**: 1–2 video/ngày (cần nhiều công sức sản xuất hơn)
**Thời gian sản xuất mỗi video**: ~10–20 phút (tự động)

## 4. Vòng Phản Hồi Phân Tích

### Chu Kỳ Hàng Ngày (06:00–07:00 UTC)

1. **06:00** — Lấy số liệu ngày hôm qua (lượt xem, lượt thích, chia sẻ, thời gian xem, tỷ lệ xem hết)
2. **06:15** — Phân tích pattern (hook hiệu quả nhất, giờ đăng tốt nhất, phong cách hình ảnh thắng, âm thanh hiệu quả)
3. **06:30** — Điều chỉnh kế hoạch nội dung hôm nay (tăng cường cái hiệu quả, bỏ cái kém, A/B test biến thể mới)
4. **07:00** — Tạo báo cáo hàng ngày (tuỳ chọn: gửi qua Telegram bot)

### Chỉ Số Chính Mỗi Video

| Chỉ Số | Mục Tiêu | Hành Động Nếu Dưới Mục Tiêu |
|---|---|---|
| Tỷ lệ Hook (% xem quá 3 giây) | >70% | Phân tích và thay đổi công thức mở đầu |
| Tỷ lệ Xem Hết | >40% | Rút ngắn video hoặc cải thiện nhịp độ |
| Tỷ lệ Tương Tác | >5% | Thêm CTA mạnh hơn, nội dung dễ đồng cảm hơn |
| Tỷ lệ Chuyển Đổi Follower | >1% | Cải thiện bio, ghim video tốt nhất |

### Chiến Lược Tối Ưu (agent tự động thực hiện)

- Video có Tỷ lệ Xem Hết >60% → tạo thêm biến thể tương tự
- Video có Tỷ lệ Hook <50% → thay đổi công thức hook
- Xác định khung giờ đăng tốt nhất → điều chỉnh lịch
- Theo dõi âm thanh/hashtag nào tương quan với hiệu suất → ưu tiên sử dụng

## 5. Cơ Chế Kiếm Tiền

### Lộ Trình Doanh Thu

| Giai Đoạn | Thời Gian | Nguồn Doanh Thu | Ước Tính Hàng Tháng |
|---|---|---|---|
| Giai đoạn 1 | Tháng 1–2 | Chưa có (xây dựng khán giả) | $0 |
| Giai đoạn 2 | Tháng 2–4 | Tiếp thị liên kết (TikTok Shop) | $200–800 |
| Giai đoạn 3 | Tháng 4–6 | + Chương trình Creator Rewards | $700–2,000 |
| Giai đoạn 4 | Tháng 6+ | + Hợp tác thương hiệu (inbound) | $1,000–5,000+ |

### Điều Kiện Đủ Creator Rewards

Creator Rewards yêu cầu **10.000 người theo dõi** và video **dài hơn 1 phút**. Để đảm bảo đủ điều kiện:
- Tất cả pipeline đều nhắm video 60–90 giây (xem Mục 3)
- Pipeline Quotes sử dụng format "tổng hợp" (3–5 quote mỗi video) để đạt 60 giây+
- Pipeline Psychology sử dụng format kể chuyện (2–3 sự thật mỗi video) để đạt 60 giây+
- AI Storytelling tự nhiên nhắm 60–90 giây
- Mục tiêu tăng trưởng follower: 10K vào tháng 3–4 (tổng cộng hoặc mỗi kênh)

### Chiến Lược Tiếp Thị Liên Kết (agent tự động quản lý)

**Ghép nối sản phẩm theo niche:**
- Quotes → sách self-help, sổ tay, planner, ứng dụng thiền
- Dark Psychology → sách tâm lý, khoá học online, công cụ năng suất
- AI Stories → công cụ AI, phần mềm sáng tạo, thiết bị công nghệ

**Hành vi của agent:**
- Ghép nối sản phẩm với niche từ cơ sở dữ liệu sản phẩm đã chọn lọc
- Xoay vòng link liên kết để A/B test tỷ lệ chuyển đổi
- Theo dõi hoa hồng mỗi sản phẩm → ưu tiên sản phẩm chuyển đổi cao
- Tự động chèn link liên kết phù hợp vào mô tả video

### Sẵn Sàng Hợp Tác Thương Hiệu (Tháng 4+)

- Agent tự động tạo media kit từ dữ liệu phân tích (lưu local, không tự động gửi)
- Rate card riêng theo niche dựa trên chỉ số tương tác
- **Xử lý DM là THỦ CÔNG** — tự động trả lời DM có nguy cơ bị ban cao trên TikTok. Agent gửi thông báo Telegram khi phát hiện DM mới. Chủ sở hữu tự trả lời với mẫu rate card đã chuẩn bị sẵn.

## 6. Chiến Lược Warmup Tài Khoản

TikTok áp dụng "trust score" cho tài khoản mới. Đăng quá nhiều quá sớm sẽ bị shadowban (video bị giới hạn reach nghiêm trọng mà không có thông báo). Mỗi kênh phải tuân thủ lịch warmup sau:

### Lịch Warmup (bắt buộc cho mỗi kênh mới)

| Giai Đoạn | Thời Gian | Hành Vi |
|---|---|---|
| Warmup thụ động | Ngày 1–3 | Chỉ xem video trong niche (5–10 phút/ngày), follow 5–10 tài khoản lớn trong niche, like/comment 3–5 video. **Không đăng bài.** |
| Warmup chủ động | Ngày 4–7 | Đăng 1 video/ngày, tiếp tục tương tác thụ động. Dùng video chất lượng cao nhất (chọn từ template đã chuẩn bị sẵn). |
| Tăng dần | Tuần 2 | Đăng 2 video/ngày, giảm tương tác thụ động. |
| Tốc độ đầy đủ | Tuần 3+ | Đăng 3 video/ngày (hoặc theo pipeline). Chỉ tăng lên tốc độ đầy đủ nếu video tuần 2 có reach bình thường (>200 lượt xem/video). |

### Dấu Hiệu Shadowban

Agent tự động phát hiện và xử lý:
- Video mới liên tiếp <50 lượt xem trong 24 giờ → **tạm dừng đăng 48 giờ**
- Reach giảm >80% so với trung bình 7 ngày → **giảm tần suất xuống 1 video/ngày trong 1 tuần**
- Hashtag không hiển thị trong tìm kiếm → **đổi bộ hashtag, kiểm tra nội dung vi phạm**

## 7. Các Giai Đoạn Triển Khai

### Giai Đoạn 1: Kênh Quotes (Tuần 1–4)

**Mục tiêu**: Xác nhận toàn bộ pipeline hoạt động end-to-end.

- Cài đặt OpenClaw agent trên VPS
- Cài đặt và cấu hình Genviral Skill
- Kết nối tài khoản TikTok cho kênh Quotes
- **Tuần 1–2: Chạy warmup theo lịch Mục 6** (không chạy pipeline đầy đủ)
- Tuần 3: Cấu hình Pipeline A (Quotes), 2 bài/ngày
- Tuần 4: Tăng lên 3 bài/ngày với jitter
- Thiết lập Vòng Phản Hồi Phân Tích
- Thiết lập giám sát (kiểm tra sức khoẻ, cảnh báo Telegram)

**Tiêu chí thành công**: Pipeline chạy không cần can thiệp thủ công trong 14 ngày ở tốc độ đầy đủ, >50% video đạt 500+ lượt xem.

### Giai Đoạn 2: + Kênh Dark Psychology (Tuần 3–6)

**Mục tiêu**: Thêm niche thứ hai, xác nhận quản lý đa kênh.

- Tạo/kết nối tài khoản TikTok cho Dark Psychology
- **Tuần 3–4: Warmup tài khoản Dark Psychology** (song song với Quotes đang chạy pipeline)
- Tuần 5: Cấu hình Pipeline B, 2 bài/ngày
- Tuần 6: Tăng lên 2–3 bài/ngày, thêm vào Bộ Lập Lịch hiện có
- Xác nhận phân tích theo dõi đúng cả hai kênh

**Tiêu chí thành công**: Cả hai kênh chạy ổn định, tỷ lệ tương tác Dark Psychology >5%.

### Giai Đoạn 3: + Kênh AI Storytelling (Tuần 7+)

**Mục tiêu**: Thêm niche premium có tiềm năng doanh thu cao nhất.

- Tạo/kết nối tài khoản TikTok cho AI Storytelling
- **Tuần 7–8: Warmup tài khoản AI Storytelling**
- Tuần 9+: Cấu hình Pipeline C (bao gồm tích hợp Kling/Pika)
- Thiết lập FFmpeg custom skill để chỉnh sửa video
- Thêm vào Bộ Lập Lịch (tần suất thấp hơn: 1–2/ngày)
- Chạy và tối ưu

**Tiêu chí thành công**: Video AI Storytelling trung bình >2K lượt xem, tỷ lệ xem hết trung bình >40%, và pipeline chạy ổn định 2 tuần không cần can thiệp thủ công.

**Lưu ý**: Bắt đầu warmup tài khoản dự phòng cho mỗi niche song song với Giai Đoạn 2–3 (xem Mục 9, hàng "Phục hồi sau khi bị ban").

## 8. Ước Tính Chi Phí

### Chi Phí Vận Hành Hàng Tháng

| Hạng Mục | Giai Đoạn 1 | Giai Đoạn 2 | Hệ Thống Đầy Đủ |
|---|---|---|---|
| VPS (agent 24/7) | $20–30 | $20–30 | $30–40 |
| Genviral API | $22 | $22 | $22 |
| ElevenLabs (TTS) | $11 | $11 | $22 |
| LLM API (Claude/GPT) | $5–10 | $10–20 | $20–30 |
| Kling/Pika (hoạt hình) | — | — | $30–50 |
| Proxy residential (3x) | $5–10 | $10–20 | $15–30 |
| Trình duyệt chống phát hiện | $0–10 | $0–10 | $0–10 |
| **Tổng** | **$63–93** | **$73–113** | **$139–204** |

**Điểm hoà vốn**: ~Tháng 3–4 khi doanh thu liên kết đủ bù chi phí vận hành.

## 9. Giảm Thiểu Rủi Ro

| Rủi Ro | Khả Năng | Giải Pháp |
|---|---|---|
| **Phát hiện nhiều tài khoản cùng IP** | **Cao** | **Mỗi tài khoản TikTok sử dụng proxy residential riêng (vd: Bright Data, Smartproxy ~$5–10/tháng/proxy). Mỗi tài khoản có dấu vân trình duyệt duy nhất qua GoLogin/AdsPower. Các tài khoản không bao giờ tương tác với nhau (không follow, không bình luận). Mẫu đăng nhập lệch nhau.** |
| TikTok ban tài khoản (phát hiện spam) | Trung bình | Giới hạn: tối đa 3 video/ngày/kênh, jitter ngẫu nhiên ±30 phút, thay đổi phong cách và format nội dung |
| Chất lượng nội dung thấp → tương tác kém | Trung bình | Vòng phản hồi phân tích tự động loại bỏ format kém hiệu quả, A/B test liên tục |
| Chi phí API vượt ngân sách | Thấp | Đặt giới hạn chi tiêu cứng cho mỗi API, chuyển sang phương án miễn phí (Coqui TTS thay ElevenLabs) |
| Genviral API ngừng hoạt động | Thấp–Trung bình | Queue cục bộ + retry tự động + fallback đăng thủ công (xem Mục 14) |
| Cạn kiệt ý tưởng nội dung | Trung bình | Content rotation với DB lớn + LLM tạo nội dung gốc + cảnh báo khi DB sắp cạn (xem Mục 12) |
| VPS hết dung lượng đĩa | Thấp | Chính sách dọn dẹp tự động + cảnh báo khi còn <15GB (xem Mục 15) |
| Vi phạm bản quyền | Thấp–Trung bình | Agent kiểm tra tính gốc của nội dung, chỉ sử dụng media miễn phí bản quyền, không dùng nhạc/hình ảnh có bản quyền |
| TikTok thay đổi chính sách | Thấp | Đăng đa nền tảng (Reels, Shorts) qua Genviral làm phương án dự phòng |
| Agent crash/ngừng hoạt động | Thấp | Cron kiểm tra sức khoẻ mỗi 5 phút, tự động khởi động lại qua systemd, cảnh báo Telegram khi ngừng. SQLite state store đảm bảo phục hồi job (xem Mục 2). Dung lượng đĩa được quản lý tự động (xem Mục 15). |
| **Phục hồi sau khi bị ban** | **Thấp–Trung bình** | **Duy trì 1 tài khoản TikTok dự phòng cho mỗi niche (làm nóng bằng các bài đăng thủ công định kỳ). Nếu tài khoản chính bị ban: (1) khiếu nại qua hỗ trợ TikTok, (2) chuyển pipeline sang tài khoản dự phòng trong vòng 24 giờ, (3) phân tích nguyên nhân bị ban, (4) điều chỉnh cài đặt chống phát hiện.** |

## 10. Quy Tắc An Toàn Nội Dung

Tích hợp trong cấu hình của agent:

- **Không dùng tài liệu có bản quyền**: Chỉ dùng nhạc, hình ảnh miễn phí bản quyền và quote gốc/có dẫn nguồn
- **Không tạo thông tin sai lệch**: Sự thật phải có thể xác minh, nội dung tâm lý dựa trên nghiên cứu thực tế
- **Không phát ngôn thù hận hoặc nội dung có hại**: Tuân thủ Nguyên tắc Cộng đồng TikTok
- **Giới hạn tần suất**: Tối đa 3 bài/ngày/tài khoản, cách nhau 2–4 giờ ngẫu nhiên
- **Kích hoạt review thủ công**: Nếu phân tích phát hiện biến động bất thường (tích cực hoặc tiêu cực) → đánh dấu để review thủ công
- **Chống phát hiện**: Jitter ngẫu nhiên khi đăng, thay đổi độ dài caption, xen kẽ format nội dung (slideshow/video/hình ảnh)

## 11. Tóm Tắt Công Nghệ

| Thành Phần | Công Nghệ |
|---|---|
| Framework Agent | OpenClaw (local-first, mở rộng được) |
| Đăng Nội Dung | Genviral Skill (42 lệnh API) |
| Chuyển Văn Bản Thành Giọng Nói | ElevenLabs API |
| LLM (kịch bản, phân tích) | Claude API / GPT API |
| Hoạt Hình AI | Kling / Pika API |
| Chỉnh Sửa Video | FFmpeg (qua custom OpenClaw skill) |
| Âm Thanh/Nhạc | Suno / Thư viện stock audio |
| Hosting | VPS (Ubuntu, 4+ vCPU, 8GB+ RAM, 100GB SSD, băng thông không giới hạn) |
| Kho Trạng Thái | SQLite (local trên VPS) |
| Chống Phát Hiện | Proxy residential + GoLogin/AdsPower browser profiles |
| Giám Sát | Cron kiểm tra sức khoẻ + cảnh báo Telegram Bot |
| Phân Tích | Genviral Analytics API + dashboard tuỳ chỉnh |

## 12. Chiến Lược Chống Lặp Nội Dung (Content Rotation)

Với 210 video/tháng, agent cần cơ chế tránh lặp lại nội dung:

### Cơ Sở Dữ Liệu Nội Dung

| Niche | Kích Thước DB Tối Thiểu | Nguồn Bổ Sung |
|---|---|---|
| Quotes | 2.000 quote (khởi tạo), bổ sung 100/tuần | LLM tạo quote gốc dựa trên xu hướng + nguồn public domain |
| Dark Psychology | 500 sự thật/khái niệm (khởi tạo), bổ sung 30/tuần | LLM tổng hợp từ kiến thức huấn luyện, đối chiếu file JSON đã kiểm chứng |
| AI Stories | Không giới hạn (LLM tạo mới mỗi lần) | Seed từ trending topics + viral patterns |

### Quy Tắc Chống Lặp

- **Tracking đã dùng**: SQLite lưu hash mỗi quote/fact/story đã sử dụng. Agent kiểm tra trước khi dùng lại.
- **Cooldown**: Quote/fact đã dùng phải chờ tối thiểu 90 ngày trước khi được tái sử dụng.
- **Biến thể**: Khi tái sử dụng sau cooldown, agent phải tạo biến thể mới (hình ảnh khác, giọng đọc khác, góc nhìn khác).
- **Cảnh báo cạn kiệt**: Nếu DB còn <200 quote chưa dùng hoặc <50 fact chưa dùng → gửi cảnh báo Telegram để chủ sở hữu bổ sung hoặc agent tự tạo thêm.

## 13. Chiến Lược Hashtag

Mỗi video sử dụng 4–6 hashtag theo công thức sau:

### Công Thức Hashtag

| Loại | Số Lượng | Ví Dụ | Mục Đích |
|---|---|---|---|
| Trending (>1B views) | 1–2 | #fyp, #viral | Tăng khả năng vào FYP |
| Niche lớn (100M–1B) | 1–2 | #motivation, #psychology | Nhắm đúng đối tượng rộng |
| Niche nhỏ (1M–100M) | 1–2 | #darkpsychologyfacts, #motivationaldaily | Nhắm đúng đối tượng cụ thể, ít cạnh tranh |
| Branded (tuỳ chọn) | 0–1 | #[tên kênh] | Xây dựng thương hiệu kênh |

### Hành Vi Agent

- **Xoay vòng**: Không dùng cùng bộ hashtag cho 2 video liên tiếp. Agent duy trì pool 20–30 hashtag cho mỗi niche, xoay vòng ngẫu nhiên.
- **A/B test**: Mỗi tuần, agent thử 2–3 hashtag mới và đo hiệu suất so với hashtag cũ.
- **Loại bỏ**: Hashtag có tương quan tiêu cực với reach (phân tích 2 tuần) bị loại khỏi pool.
- **Trending scan**: Genviral Analytics quét hashtag trending hàng ngày → tự động thêm vào pool nếu liên quan đến niche.

## 14. Xử Lý Sự Cố Genviral API

Genviral là single point of failure cho cả 3 pipeline. Cần cơ chế fallback:

### Khi Genviral API Không Khả Dụng

| Tình Huống | Hành Động |
|---|---|
| API timeout (>30 giây) | Retry 3 lần với exponential backoff (30s → 60s → 120s) |
| API trả lỗi 5xx | Đánh dấu job "queued_for_retry", retry sau 15 phút, tối đa 5 lần |
| API down >1 giờ | Gửi cảnh báo Telegram. Video đã render được lưu local, queue lại để đăng khi API phục hồi |
| API down >24 giờ | Chuyển sang fallback: upload thủ công qua TikTok web (agent gửi danh sách video + caption qua Telegram để chủ sở hữu đăng tay) |

### Queue Cục Bộ

- Video đã render nhưng chưa đăng được lưu trong thư mục `~/tiktokbot/queue/`
- Mỗi file kèm metadata JSON (caption, hashtag, lịch đăng dự kiến)
- Khi Genviral phục hồi, agent xử lý queue theo thứ tự FIFO
- Queue tối đa 50 video (sau đó tạm dừng render để tránh tốn chi phí API khi không đăng được)

## 15. Quản Lý Dung Lượng Đĩa

### Ước Tính Dung Lượng

- Video trung bình: ~50MB (60–90 giây, 1080p)
- 210 video/tháng × 50MB = ~10.5 GB/tháng
- VPS 100GB SSD → đầy sau ~8 tháng nếu không dọn

### Chính Sách Dọn Dẹp (Cron Job Hàng Ngày)

| Loại File | Thời Gian Giữ | Hành Động Sau Khi Hết Hạn |
|---|---|---|
| Video đã đăng thành công | 7 ngày | Xoá file video local (đã có trên TikTok) |
| Video đang chờ trong queue | Không giới hạn | Giữ cho đến khi đăng thành công |
| File tạm (render intermediate) | 24 giờ | Xoá tự động |
| Kịch bản + metadata (JSON/text) | Vĩnh viễn | Giữ lại (kích thước nhỏ, ~1KB/file) — dùng cho phân tích và tránh lặp |
| Log files | 30 ngày | Xoay vòng (rotate) và nén |
| SQLite database | Vĩnh viễn | Backup hàng tuần ra storage ngoài (S3/Backblaze B2, ~$0.005/GB/tháng) |

### Giám Sát

- Cảnh báo Telegram khi dung lượng đĩa còn <15GB
- Cảnh báo khẩn khi còn <5GB → tạm dừng render, chỉ đăng từ queue

## 16. Múi Giờ & Lịch Đăng Bài

### Target Audience Chính: Hoa Kỳ (EST/PST)

Nội dung tiếng Anh → target thị trường Hoa Kỳ (doanh thu CPM cao nhất trên Creator Rewards).

### Giờ Đăng Bài Tối Ưu (theo EST — múi giờ đông Hoa Kỳ)

| Slot | Giờ EST | Giờ UTC | Lý Do |
|---|---|---|---|
| Sáng | 7:00–9:00 AM EST | 12:00–14:00 UTC | Người dùng check điện thoại khi thức dậy/đi làm |
| Trưa | 12:00–1:00 PM EST | 17:00–18:00 UTC | Giờ nghỉ trưa |
| Tối | 7:00–9:00 PM EST | 00:00–02:00 UTC (+1 ngày) | Giờ cao điểm: sau bữa tối, giải trí trước khi ngủ |

### Cấu Hình Agent

- Scheduler sử dụng **giờ UTC** nội bộ, nhưng tính toán slot đăng dựa trên **EST**
- Jitter ±30 phút áp dụng sau khi chọn slot → video không bao giờ đăng cùng lúc
- Analytics Feedback Loop (06:00–07:00 UTC) chạy trước slot đăng đầu tiên (12:00 UTC) → kịp điều chỉnh nội dung hôm nay
- Nếu phân tích cho thấy khung giờ khác hiệu quả hơn → agent tự động dịch chuyển slot (nhưng giữ trong khoảng 7AM–10PM EST)

## 17. Chỉ Số Thành Công (mục tiêu 6 tháng)

| Chỉ Số | Mục Tiêu |
|---|---|
| Tổng follower (3 kênh) | 50K–100K |
| Doanh thu hàng tháng | Tối thiểu $1K, mục tiêu $3K, khả năng $5K |
| Số video sản xuất/tháng | ~210 (Pipeline A: 90 + B: 75 + C: 45) |
| Thời gian hoạt động hệ thống | >99% |
| Tỷ lệ tương tác trung bình | >5% |
| Thời gian con người/tuần | <1 giờ (chỉ review dashboard) |
