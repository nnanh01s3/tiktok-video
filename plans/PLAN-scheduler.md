# Plan 1: Scheduler Tự Động 3 Video/Ngày

**Trạng thái**: Kế hoạch
**Ưu tiên**: Cao
**Ước tính**: 2-3 giờ triển khai

## Hiện Trạng

- `src/index.js` đã có scheduler dùng `node-cron` — 3 slot (7AM, 12PM, 7PM EST) + jitter ±30 phút
- Đang gọi `pipeline-quotes.js` (pipeline cũ, slideshow tĩnh)
- Chưa tích hợp `pipeline-quotes-veo.js` (pipeline Veo, video AI)
- Timezone cứng EST — chưa tối ưu cho khán giả Việt Nam
- Chưa có Docker setup
- Chưa có cơ chế chọn pipeline (Veo vs FFmpeg fallback)
- Chưa có retry khi pipeline fail

## Vấn Đề Cần Giải Quyết

### 1. Timezone & Giờ Đăng Tối Ưu Cho Khán Giả Việt Nam
- Hiện tại: 7AM, 12PM, 7PM EST → tương đương 6PM, 11PM, 6AM ICT
- Cần đổi: **7:00 sáng, 12:00 trưa, 19:00 tối ICT (UTC+7)** — đây là giờ cao điểm TikTok Việt Nam
- Jitter ±30 phút giữ nguyên (chống phát hiện pattern)

### 2. Chọn Pipeline Thông Minh
- **Ưu tiên Veo pipeline** (video AI đẹp hơn, tương tác cao hơn)
- **Fallback sang FFmpeg pipeline** khi Veo quota hết (429 error)
- Logic: thử Veo → nếu 429 → dùng FFmpeg slideshow → vẫn đăng bài
- Đảm bảo luôn có video đăng, không bỏ slot

### 3. Retry & Error Recovery
- Pipeline fail → retry 1 lần sau 5 phút
- Nếu vẫn fail → log error + gửi Telegram alert + skip slot
- Không retry vô hạn (tránh spam API khi có lỗi hệ thống)

### 4. Docker Setup (chạy local thay VPS)
- Dockerfile + docker-compose.yml
- Mount volume cho `./data/` (SQLite DB) và `./queue/` (video files)
- `.env` file mount (không bake vào image)
- Auto-restart on crash
- Health check endpoint

### 5. Chống Trùng Lặp
- Kiểm tra DB trước khi chạy: nếu đã có video posted trong slot hôm nay → skip
- Tránh trường hợp agent restart → chạy lại pipeline đã hoàn thành

## Thay Đổi Code

### `src/index.js` — Sửa đổi

```
Thay đổi:
1. TIMEZONE: "America/New_York" → "Asia/Ho_Chi_Minh"
2. Cron times: 7AM/12PM/7PM EST → 7AM/12PM/7PM ICT
3. Import cả 2 pipeline: pipeline-quotes.js + pipeline-quotes-veo.js
4. Thêm hàm runWithFallback():
   - Thử Veo pipeline trước
   - Catch 429/quota error → fallback FFmpeg pipeline
   - Catch all other errors → retry 1 lần → alert
5. Thêm duplicate check: query DB xem slot hôm nay đã post chưa
6. Thêm daily stats log lúc 23:00 ICT
```

### `Dockerfile` — Tạo mới

```dockerfile
FROM node:22-slim
# Cần FFmpeg cho video rendering
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
CMD ["node", "src/index.js"]
```

### `docker-compose.yml` — Tạo mới

```yaml
services:
  tiktokbot:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data        # SQLite DB persist
      - ./queue:/app/queue      # Video files
      - ./assets:/app/assets    # Fonts, images
    healthcheck:
      test: ["CMD", "node", "-e", "require('./src/db.js').getDb()"]
      interval: 5m
      timeout: 10s
      retries: 3
```

## Thứ Tự Thực Hiện

1. Sửa `src/index.js` (timezone, dual pipeline, retry, duplicate check)
2. Test thủ công: `node src/index.js` — verify 3 cron jobs registered đúng giờ
3. Tạo Dockerfile + docker-compose.yml
4. `docker compose up -d` — verify container chạy ổn
5. Monitor 24h đầu tiên qua Telegram alerts

## Rủi Ro

| Rủi ro | Giải pháp |
|---|---|
| Veo quota hết cả ngày → 3 video slideshow | Chấp nhận — slideshow vẫn ổn, Veo sẽ reset ngày sau |
| Docker container crash loop | `restart: unless-stopped` + healthcheck + Telegram alert |
| SQLite lock khi 2 pipeline chạy song song | Không xảy ra — chỉ 1 pipeline chạy tại 1 thời điểm (sequential) |
| .env không mount đúng | Verify bằng healthcheck ngay khi container start |
