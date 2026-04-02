# Phase 1: Kênh Quotes — Implementation Plan

**Ngày tạo**: 2026-03-26
**Thời gian**: Tuần 1–4
**Mục tiêu**: Pipeline Quotes chạy end-to-end tự động, không cần can thiệp thủ công

## Điều Kiện Tiên Quyết (Đã Có)

- [x] OpenClaw đã cài trong máy
- [x] Tài khoản TikTok (nnanh01@gmail.com)
- [ ] Genviral Skill (cần cài)
- [ ] VPS (cần thuê)
- [ ] ElevenLabs account (cần đăng ký)
- [ ] Claude/GPT API key (cần có)
- [ ] Telegram Bot (cần tạo)

---

## Wave 1: Chuẩn Bị Hạ Tầng (Ngày 1–3)

### Plan 1.1 — Thuê VPS & Cài Đặt Môi Trường

**Thời gian**: ~2 giờ

**Bước thực hiện:**

1. **Thuê VPS** — chọn 1 trong các nhà cung cấp sau:
   - Hetzner CPX21 (3 vCPU, 4GB RAM, 80GB SSD) — €7.5/tháng ← khuyên dùng vì giá/hiệu suất tốt nhất
   - DigitalOcean Droplet (4 vCPU, 8GB RAM, 100GB SSD) — $24/tháng
   - Contabo VPS S (4 vCPU, 8GB RAM, 200GB SSD) — €5.99/tháng ← rẻ nhất nhưng hiệu suất thấp hơn

2. **Cài đặt môi trường trên VPS:**
   ```bash
   # Cập nhật hệ thống
   sudo apt update && sudo apt upgrade -y

   # Cài Node.js 20+ (OpenClaw yêu cầu)
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs

   # Cài FFmpeg (cho video editing)
   sudo apt install -y ffmpeg

   # Cài Python 3.11+ (cho một số script phụ trợ)
   sudo apt install -y python3 python3-pip

   # Cài SQLite3
   sudo apt install -y sqlite3

   # Xác nhận versions
   node --version    # >= 20.x
   ffmpeg -version   # >= 5.x
   python3 --version # >= 3.11
   sqlite3 --version
   ```

3. **Cài OpenClaw trên VPS:**
   ```bash
   # Cài OpenClaw (theo docs chính thức)
   npm install -g openclaw

   # Xác nhận
   openclaw --version
   ```

4. **Tạo thư mục dự án:**
   ```bash
   mkdir -p ~/tiktokbot/{config,data,queue,logs,scripts,content-db}
   ```

**Tiêu chí hoàn thành:**
- `node --version` trả về >= 20.x
- `openclaw --version` chạy được
- `ffmpeg -version` chạy được
- Thư mục `~/tiktokbot/` với cấu trúc đầy đủ

---

### Plan 1.2 — Đăng Ký Dịch Vụ & Lấy API Keys

**Thời gian**: ~1 giờ

**Bước thực hiện:**

1. **Genviral** — https://genviral.com
   - Đăng ký plan Starter ($22/tháng)
   - Lấy API key
   - Cài Genviral Skill cho OpenClaw:
     ```bash
     openclaw skill install genviral
     ```

2. **ElevenLabs** — https://elevenlabs.io
   - Đăng ký plan Starter ($11/tháng — 30.000 characters/tháng)
   - Lấy API key
   - Chọn voice ID cho niche Quotes: tìm giọng trầm, truyền cảm hứng trong Voice Library
   - Ghi lại voice_id: `____________`

3. **Claude API** — https://console.anthropic.com
   - Tạo API key (nếu chưa có)
   - Đặt spending limit $20/tháng trong Settings → Billing

4. **Telegram Bot** (cho cảnh báo giám sát):
   - Mở Telegram, tìm @BotFather
   - Gửi `/newbot`, đặt tên: `TikTokBot Monitor`
   - Lưu bot token: `____________`
   - Tạo channel/group riêng, thêm bot vào
   - Lấy chat_id: gửi tin nhắn vào group, truy cập `https://api.telegram.org/bot<TOKEN>/getUpdates`

5. **Proxy Residential** (cho tài khoản TikTok):
   - Đăng ký Smartproxy hoặc Bright Data
   - Mua 1 residential proxy (dùng cho kênh Quotes) — ~$5–10/tháng
   - Lấy proxy connection string: `____________`

6. **Lưu tất cả credentials vào file config:**
   ```bash
   cat > ~/tiktokbot/config/.env << 'EOF'
   # Genviral
   GENVIRAL_API_KEY=gv_xxxxxxxxxxxxx

   # ElevenLabs
   ELEVENLABS_API_KEY=el_xxxxxxxxxxxxx
   ELEVENLABS_VOICE_ID=xxxxxxxxxxxxx

   # Claude API
   ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx

   # Telegram
   TELEGRAM_BOT_TOKEN=xxxxxxxxxxxxx
   TELEGRAM_CHAT_ID=xxxxxxxxxxxxx

   # Proxy
   PROXY_QUOTES=socks5://user:pass@host:port

   # TikTok (kênh Quotes)
   TIKTOK_ACCOUNT_QUOTES=nnanh01@gmail.com
   EOF

   chmod 600 ~/tiktokbot/config/.env
   ```

**Tiêu chí hoàn thành:**
- File `~/tiktokbot/config/.env` tồn tại với tất cả keys
- `openclaw skill list` hiển thị genviral
- Telegram bot gửi được tin nhắn test: `curl -s "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=Test"`

---

### Plan 1.3 — Tạo Quote Database (Khởi Tạo)

**Thời gian**: ~1 giờ (phần lớn là AI tạo tự động)

**Bước thực hiện:**

1. **Tạo script seed database:**

   File `~/tiktokbot/scripts/seed-quotes.py`:
   ```python
   """
   Tạo 2000 quotes ban đầu cho niche Motivation.
   Nguồn: public domain quotes + LLM-generated originals.
   Output: SQLite database ~/tiktokbot/data/content.db
   """
   import sqlite3
   import json
   import os
   from anthropic import Anthropic

   DB_PATH = os.path.expanduser("~/tiktokbot/data/content.db")

   def init_db():
       conn = sqlite3.connect(DB_PATH)
       c = conn.cursor()
       c.execute("""
           CREATE TABLE IF NOT EXISTS quotes (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               text TEXT NOT NULL UNIQUE,
               author TEXT DEFAULT 'Unknown',
               category TEXT NOT NULL,
               hash TEXT NOT NULL UNIQUE,
               used_count INTEGER DEFAULT 0,
               last_used_at TEXT,
               created_at TEXT DEFAULT CURRENT_TIMESTAMP,
               source TEXT DEFAULT 'seed'
           )
       """)
       c.execute("""
           CREATE TABLE IF NOT EXISTS videos (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               job_id TEXT NOT NULL UNIQUE,
               status TEXT NOT NULL DEFAULT 'pending',
               niche TEXT NOT NULL,
               content_ids TEXT,  -- JSON array of quote/fact IDs used
               script TEXT,
               video_path TEXT,
               tiktok_post_id TEXT,
               caption TEXT,
               hashtags TEXT,
               scheduled_at TEXT,
               posted_at TEXT,
               views INTEGER DEFAULT 0,
               likes INTEGER DEFAULT 0,
               shares INTEGER DEFAULT 0,
               completion_rate REAL DEFAULT 0,
               created_at TEXT DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT DEFAULT CURRENT_TIMESTAMP
           )
       """)
       c.execute("""
           CREATE INDEX IF NOT EXISTS idx_quotes_category
           ON quotes(category)
       """)
       c.execute("""
           CREATE INDEX IF NOT EXISTS idx_quotes_used
           ON quotes(used_count, last_used_at)
       """)
       c.execute("""
           CREATE INDEX IF NOT EXISTS idx_videos_status
           ON videos(status)
       """)
       conn.commit()
       return conn

   def generate_quotes_batch(client, category, count=50):
       """Generate a batch of original quotes using Claude."""
       response = client.messages.create(
           model="claude-sonnet-4-5-20250514",
           max_tokens=4096,
           messages=[{
               "role": "user",
               "content": f"""Generate {count} original motivational quotes about {category}.

   Rules:
   - Each quote must be 10-25 words
   - Mix styles: philosophical, direct, poetic, provocative
   - No clichés like "believe in yourself" or "follow your dreams"
   - Each quote should stand alone (no context needed)
   - Return as JSON array: [{{"text": "...", "author": "Original"}}]

   Return ONLY the JSON array, no other text."""
           }]
       )
       return json.loads(response.content[0].text)

   # Categories cho niche Motivation
   CATEGORIES = [
       "success and ambition",
       "discipline and habits",
       "mental strength",
       "overcoming failure",
       "self-improvement",
       "stoic philosophy",
       "wealth mindset",
       "leadership",
       "time management",
       "emotional intelligence",
   ]

   if __name__ == "__main__":
       import hashlib

       conn = init_db()
       client = Anthropic()
       total = 0

       for category in CATEGORIES:
           # 4 batches of 50 = 200 quotes per category = 2000 total
           for batch in range(4):
               quotes = generate_quotes_batch(client, category)
               for q in quotes:
                   text_hash = hashlib.sha256(
                       q["text"].lower().strip().encode()
                   ).hexdigest()[:16]
                   try:
                       conn.execute(
                           """INSERT INTO quotes
                              (text, author, category, hash)
                              VALUES (?, ?, ?, ?)""",
                           (q["text"], q.get("author", "Original"),
                            category, text_hash)
                       )
                       total += 1
                   except sqlite3.IntegrityError:
                       pass  # duplicate
               conn.commit()
               print(f"  {category} batch {batch+1}/4 done ({total} total)")

       print(f"\nSeeded {total} quotes into {DB_PATH}")
       conn.close()
   ```

2. **Chạy script:**
   ```bash
   cd ~/tiktokbot
   source config/.env
   python3 scripts/seed-quotes.py
   ```

3. **Xác nhận:**
   ```bash
   sqlite3 ~/tiktokbot/data/content.db "SELECT category, COUNT(*) FROM quotes GROUP BY category"
   # Kỳ vọng: ~200 quotes mỗi category, tổng ~2000
   ```

**Tiêu chí hoàn thành:**
- File `~/tiktokbot/data/content.db` tồn tại
- Query `SELECT COUNT(*) FROM quotes` trả về >= 1500
- Mỗi category có >= 100 quotes

---

## Wave 2: Warmup Tài Khoản TikTok (Ngày 1–14)

> **Chạy song song với Wave 1** — bắt đầu warmup ngay ngày 1, không cần đợi hạ tầng xong.

### Plan 2.1 — Warmup Thụ Động (Ngày 1–3)

**Thời gian**: 15 phút/ngày, THỦ CÔNG

**Quan trọng**: Warmup **phải làm tay** vì TikTok rất nhạy với hành vi bot trên tài khoản mới. Dùng điện thoại thật hoặc trình duyệt qua proxy residential.

**Bước thực hiện (mỗi ngày):**

1. Đăng nhập TikTok qua proxy residential (hoặc điện thoại)
2. Xem 5–10 video trong niche motivation/quotes (cuộn FYP, tìm kiếm #motivationalquotes)
3. Like 3–5 video (chỉ video thực sự hay)
4. Comment 1–2 video (comment có ý nghĩa, không spam: "This really resonated with me", "Needed to hear this today")
5. Follow 5–10 tài khoản lớn trong niche:
   - @motivationmafia
   - @mindsetmentors
   - @successquotes
   - @dailymotivation
   - @thinkgrowprosper
   - (tìm thêm trong search)
6. **KHÔNG đăng bài gì**

**Ghi chép**: Ghi lại mỗi ngày đã xem bao nhiêu video, like bao nhiêu, comment gì → dùng để đánh giá warmup.

---

### Plan 2.2 — Warmup Chủ Động (Ngày 4–7)

**Thời gian**: 30 phút/ngày

**Bước thực hiện:**

1. Tiếp tục tương tác thụ động (như Plan 2.1, giảm xuống 5 phút/ngày)

2. **Đăng 1 video/ngày** (tổng 4 video trong tuần):
   - Dùng video chất lượng cao nhất từ pipeline thủ công (chưa dùng automation)
   - Tạo video đơn giản: 1 quote + background đẹp + nhạc trending (dùng CapCut/Canva)
   - Đăng ở khung giờ US evening (7–9 PM EST = 00:00–02:00 UTC)
   - Caption ngắn (1–2 câu) + 4–5 hashtag theo công thức Mục 13
   - **Mục đích**: Cho TikTok thấy đây là tài khoản thật, có nội dung

3. **Theo dõi reach mỗi video**:
   - Nếu video đạt >200 views trong 24h → warmup bình thường, tiếp tục
   - Nếu video <50 views → có thể bị shadowban, tạm dừng đăng 48h

4. **Hoàn thiện hồ sơ kênh:**
   - Avatar: hình ảnh professional liên quan đến motivation
   - Bio: ngắn gọn, có CTA ("Daily motivation | Follow for more")
   - Link: để trống (chưa có affiliate)

---

### Plan 2.3 — Tăng Dần (Ngày 8–14)

**Thời gian**: 20 phút/ngày

**Bước thực hiện:**

1. Đăng **2 video/ngày** (sáng + tối EST)
2. Video vẫn làm thủ công hoặc bán tự động (chạy pipeline test)
3. Giảm tương tác thụ động xuống tối thiểu (like 1–2 video/ngày)
4. Theo dõi metrics:
   - Views trung bình > 200/video → OK
   - Ít nhất 1 video đạt >1000 views → tín hiệu tốt
   - Followers tăng > 50/tuần → warmup thành công

**Tiêu chí hoàn thành warmup (cuối ngày 14):**
- Đã đăng >= 10 video (4 tuần 1 + 8 tuần 2)
- Views trung bình >= 200/video
- Không có dấu hiệu shadowban
- Followers >= 30

---

## Wave 3: Xây Dựng Pipeline Tự Động (Ngày 4–14)

> **Chạy song song với Wave 2** — build automation trong khi warmup đang diễn ra.

### Plan 3.1 — OpenClaw Agent Core

**Thời gian**: ~4 giờ

**Mô tả**: Tạo OpenClaw agent "TikTokBot" với scheduler, state management, và Telegram alerts.

**File cần tạo:**

1. `~/tiktokbot/config/agent.yaml` — Cấu hình agent chính:
   ```yaml
   name: TikTokBot
   version: "1.0.0"
   description: "Automated TikTok content pipeline for Quotes niche"

   skills:
     - genviral

   env_file: ./config/.env

   schedule:
     # Slot sáng (7-9 AM EST = 12:00-14:00 UTC)
     morning_post:
       cron: "0 12 * * *"
       jitter_minutes: 30
       action: create_and_post
       niche: quotes

     # Slot trưa (12-1 PM EST = 17:00-18:00 UTC)
     noon_post:
       cron: "0 17 * * *"
       jitter_minutes: 30
       action: create_and_post
       niche: quotes

     # Slot tối (7-9 PM EST = 00:00-02:00 UTC)
     evening_post:
       cron: "0 0 * * *"
       jitter_minutes: 30
       action: create_and_post
       niche: quotes

     # Analytics feedback loop
     daily_analytics:
       cron: "0 6 * * *"
       action: analyze_and_adjust

     # Disk cleanup
     daily_cleanup:
       cron: "0 5 * * *"
       action: cleanup_old_files

     # Health check (mỗi 5 phút)
     health_check:
       cron: "*/5 * * * *"
       action: health_ping
   ```

2. `~/tiktokbot/scripts/pipeline-quotes.js` — Pipeline chính cho niche Quotes:
   ```
   Luồng xử lý:
   1. Chọn 3-5 quotes chưa dùng từ DB (ưu tiên category đang trending)
   2. Gọi Claude API để viết script (sắp xếp quotes, thêm transitions)
   3. Gọi ElevenLabs API để tạo voiceover từ script
   4. Gọi Genviral Slideshow API để tạo hình ảnh cho mỗi quote
   5. Gọi Genviral để render video (slideshow + voiceover + nhạc trending)
   6. Chọn caption + hashtags (từ pool, xoay vòng)
   7. Gọi Genviral Publisher để đăng lên TikTok
   8. Cập nhật DB: đánh dấu quotes đã dùng, lưu video metadata
   ```

3. `~/tiktokbot/scripts/analytics.js` — Vòng phản hồi phân tích:
   ```
   Luồng xử lý:
   1. Gọi Genviral Analytics API lấy metrics ngày hôm qua
   2. Cập nhật bảng videos trong DB
   3. Phân tích: hook rate, completion rate, engagement rate
   4. So sánh với thresholds (Mục 4 trong spec)
   5. Điều chỉnh: thay đổi category weights, giờ đăng, hashtag pool
   6. Gửi báo cáo qua Telegram
   ```

4. `~/tiktokbot/scripts/health-check.js` — Giám sát sức khoẻ:
   ```
   Kiểm tra:
   - Agent process đang chạy
   - SQLite DB accessible
   - Dung lượng đĩa (cảnh báo <15GB)
   - Genviral API responsive
   - Số video đã đăng hôm nay
   - Gửi alert Telegram nếu có vấn đề
   ```

5. `~/tiktokbot/scripts/cleanup.js` — Dọn dẹp dung lượng:
   ```
   - Xoá video đã đăng >7 ngày
   - Xoá file tạm >24 giờ
   - Rotate + nén log >30 ngày
   - Backup SQLite lên Backblaze B2 (hàng tuần)
   ```

**Tiêu chí hoàn thành:**
- `openclaw agent start ~/tiktokbot/config/agent.yaml` chạy được
- Agent tạo được 1 video test (không đăng)
- Health check gửi được tin nhắn Telegram
- Cron jobs được đăng ký đúng

---

### Plan 3.2 — Pipeline Quotes End-to-End Test

**Thời gian**: ~2 giờ

**Bước thực hiện:**

1. **Test từng bước riêng lẻ (unit test):**
   ```bash
   # Test 1: Chọn quotes từ DB
   node scripts/pipeline-quotes.js --step=select-quotes --dry-run
   # Kỳ vọng: 3-5 quotes được chọn, in ra console

   # Test 2: Tạo script từ quotes
   node scripts/pipeline-quotes.js --step=generate-script --dry-run
   # Kỳ vọng: Script 60-90 giây được in ra

   # Test 3: Tạo voiceover
   node scripts/pipeline-quotes.js --step=voiceover --dry-run
   # Kỳ vọng: File audio .mp3 được tạo trong ~/tiktokbot/queue/

   # Test 4: Tạo slideshow
   node scripts/pipeline-quotes.js --step=slideshow --dry-run
   # Kỳ vọng: File video .mp4 được tạo

   # Test 5: Render video hoàn chỉnh
   node scripts/pipeline-quotes.js --step=render --dry-run
   # Kỳ vọng: Video 60-90 giây với voiceover + slideshow + nhạc

   # Test 6: Kiểm tra video output
   ffprobe ~/tiktokbot/queue/latest.mp4
   # Kỳ vọng: Duration 60-90s, 1080x1920 (vertical), có audio
   ```

2. **Test full pipeline (không đăng):**
   ```bash
   node scripts/pipeline-quotes.js --full --no-publish
   # Kỳ vọng: Video hoàn chỉnh trong ~/tiktokbot/queue/ kèm metadata JSON
   ```

3. **Test đăng bài (1 video test):**
   ```bash
   node scripts/pipeline-quotes.js --full --publish
   # Kiểm tra trên TikTok: video hiển thị đúng
   ```

4. **Test recovery:**
   ```bash
   # Giả lập crash giữa pipeline
   node scripts/pipeline-quotes.js --full --crash-at=render
   # Restart
   node scripts/pipeline-quotes.js --resume
   # Kỳ vọng: Pipeline tiếp tục từ bước render, không tạo lại từ đầu
   ```

**Tiêu chí hoàn thành:**
- Video test được đăng thành công lên TikTok
- Video đúng 60–90 giây, vertical (1080x1920)
- Voiceover đồng bộ với slideshow
- Caption + hashtags đúng format
- Recovery hoạt động sau crash giả lập

---

### Plan 3.3 — Thiết Lập Systemd Service

**Thời gian**: ~30 phút

**Bước thực hiện:**

1. **Tạo systemd service file:**
   ```bash
   sudo cat > /etc/systemd/system/tiktokbot.service << 'EOF'
   [Unit]
   Description=TikTokBot OpenClaw Agent
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/tiktokbot
   EnvironmentFile=/home/ubuntu/tiktokbot/config/.env
   ExecStart=/usr/bin/openclaw agent start /home/ubuntu/tiktokbot/config/agent.yaml
   Restart=always
   RestartSec=30
   StandardOutput=append:/home/ubuntu/tiktokbot/logs/agent.log
   StandardError=append:/home/ubuntu/tiktokbot/logs/agent-error.log

   [Install]
   WantedBy=multi-user.target
   EOF
   ```

2. **Kích hoạt service:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable tiktokbot
   sudo systemctl start tiktokbot
   sudo systemctl status tiktokbot
   ```

3. **Tạo health check cron (backup cho systemd):**
   ```bash
   # Cron kiểm tra agent mỗi 5 phút, restart nếu chết
   (crontab -l 2>/dev/null; echo "*/5 * * * * systemctl is-active tiktokbot || systemctl restart tiktokbot") | crontab -
   ```

**Tiêu chí hoàn thành:**
- `systemctl status tiktokbot` hiện "active (running)"
- Agent tự khởi động lại sau `sudo systemctl stop tiktokbot && sleep 35 && systemctl status tiktokbot`
- Log file `~/tiktokbot/logs/agent.log` ghi nhận hoạt động

---

## Wave 4: Chạy Pipeline Đầy Đủ (Ngày 15–28)

> **Bắt đầu sau khi warmup hoàn thành** (Wave 2 done).

### Plan 4.1 — Bật Pipeline Tự Động (Tuần 3)

**Thời gian**: 30 phút setup + theo dõi hàng ngày

**Bước thực hiện:**

1. **Bật schedule 2 bài/ngày** (sáng + tối, bỏ slot trưa):
   ```bash
   # Sửa agent.yaml: comment out noon_post
   # Hoặc config override
   openclaw agent config set schedule.noon_post.enabled false
   ```

2. **Theo dõi 3 ngày đầu (ngày 15–17):**
   - Kiểm tra Telegram alerts mỗi sáng
   - Xem video đã đăng trên TikTok (đúng nội dung, đúng format?)
   - Kiểm tra DB: quotes được đánh dấu đã dùng?
   - Kiểm tra logs: có lỗi gì không?

3. **Nếu ổn định, tăng lên 3 bài/ngày (ngày 18+):**
   ```bash
   openclaw agent config set schedule.noon_post.enabled true
   ```

4. **Kiểm tra analytics feedback loop:**
   - Ngày 18+: báo cáo Telegram hàng ngày có hiển thị metrics?
   - Agent có điều chỉnh hashtag/category weights không?

---

### Plan 4.2 — Monitoring & Tối Ưu (Tuần 3–4)

**Thời gian**: <1 giờ/tuần (review dashboard)

**Checklist hàng ngày (tự động qua Telegram):**
- [ ] Số video đăng hôm nay: ___ /3
- [ ] Lỗi pipeline: có/không
- [ ] Dung lượng đĩa còn: ___GB
- [ ] Views trung bình hôm qua: ___

**Checklist hàng tuần (review thủ công):**
- [ ] Tổng views tuần này vs tuần trước
- [ ] Video nào hiệu suất cao nhất? Tại sao?
- [ ] Video nào hiệu suất thấp nhất? Tại sao?
- [ ] Followers tăng bao nhiêu?
- [ ] Chi phí API tuần này: $___
- [ ] Quote DB còn bao nhiêu chưa dùng?
- [ ] Cần điều chỉnh gì?

**Hành động dựa trên metrics (agent tự thực hiện):**
- Completion Rate >60% → tạo thêm biến thể video tương tự
- Hook Rate <50% → đổi công thức mở đầu (thử hook khác)
- Engagement <3% → thêm CTA mạnh hơn trong script

---

### Plan 4.3 — Tiêu Chí Kết Thúc Phase 1

**Đánh giá vào cuối Tuần 4 (Ngày 28):**

| Tiêu Chí | Ngưỡng Đạt | Ngưỡng Chưa Đạt |
|---|---|---|
| Pipeline chạy tự động không lỗi | >= 12/14 ngày | < 10/14 ngày |
| Video đăng đúng lịch | >= 90% (38/42 video) | < 80% |
| Views trung bình/video | >= 500 | < 200 |
| Followers cuối Phase 1 | >= 200 | < 50 |
| Chi phí/tháng thực tế | <= $100 | > $150 |
| Thời gian con người/tuần | <= 2 giờ | > 5 giờ |

**Nếu ĐẠT → Chuyển sang Phase 2** (thêm kênh Dark Psychology):
- Bắt đầu warmup tài khoản mới
- Cài proxy residential thứ 2
- Cấu hình Pipeline B

**Nếu CHƯA ĐẠT → Điều chỉnh Phase 1:**
- Phân tích nguyên nhân (nội dung kém? lỗi kỹ thuật? shadowban?)
- Kéo dài Phase 1 thêm 2 tuần
- Điều chỉnh pipeline/nội dung theo kết quả phân tích

---

## Tổng Hợp Timeline

```
Ngày 1─────────────────────────────────Ngày 28
│                                        │
│ Wave 1: Hạ tầng (Ngày 1-3)            │
│ ████░░░░░░░░░░░░░░░░░░░░░░░░          │
│                                        │
│ Wave 2: Warmup TikTok (Ngày 1-14)     │
│ ████████████████░░░░░░░░░░░░          │
│  └ Thụ động(1-3) Chủ động(4-7) Tăng(8-14)
│                                        │
│ Wave 3: Build Pipeline (Ngày 4-14)    │
│ ░░░█████████████░░░░░░░░░░░░          │
│                                        │
│ Wave 4: Chạy Pipeline (Ngày 15-28)    │
│ ░░░░░░░░░░░░░░░██████████████         │
│  └ 2/ngày(15-17) 3/ngày(18-28)        │
│                                        │
Ngày 1─────────────────────────────────Ngày 28
```

## Chi Phí Phase 1

| Hạng Mục | Chi Phí/Tháng |
|---|---|
| VPS (Hetzner CPX21) | ~$8 |
| Genviral | $22 |
| ElevenLabs Starter | $11 |
| Claude API (capped) | ~$10 |
| Proxy residential (1x) | ~$7 |
| **Tổng Phase 1** | **~$58/tháng** |

Thấp hơn ước tính trong spec ($63–93) vì Phase 1 chỉ chạy 1 kênh.
