# TikTok + Facebook Automation — Codebase Reference

> Cập nhật: 2026-04-06
> Thư mục gốc: `D:\tiktok\`

---

## 1. Tổng quan

Hệ thống tự động tạo và đăng video lên **TikTok** (motivation quotes) và **Facebook** (sản phẩm Shopee + video viral). Chạy hàng ngày bằng 1 lệnh duy nhất:

```bash
cd D:/tiktok && node src/daily.mjs
```

### Kiến trúc tổng thể

```
daily.mjs (orchestrator)
│
├── TikTok Pipeline (song song)
│   └── pipeline-quotes-veo.js
│       ├── db.js          → chọn quotes
│       ├── script-writer.js → Claude script + scene directions
│       ├── gemini-tts.js   → voiceover (Algenib voice)
│       ├── veo.js          → hook video 8s
│       ├── imagen.js       → scene images + Ken Burns
│       └── postfast.js     → upload + schedule TikTok
│
├── Shopee Cache (tuần tự)
│   └── fetch_products.mjs → Chrome visible → API → products_cache.json
│
└── Facebook Scripts (4 song song)
    ├── reup.mjs --page shopee    → Sưu Tầm Hàng Dị
    ├── reup.mjs --page gia_dung  → Đồ Gia Dụng Thông Minh
    ├── reup.mjs --page tech      → Đồ Công Nghệ Giá Tốt
    └── fb_repost.mjs             → Repost video giải trí
```

**Script chạy riêng (không trong daily.mjs):**
```
trending_repost.mjs → Quét video viral TikTok + FB → reup Sưu Tầm Hàng Dị
```

---

## 2. Các kênh đăng bài

| Platform | Kênh | Script | PostFast ID |
|----------|------|--------|-------------|
| TikTok | @trituemoingay.vn | pipeline-quotes-veo.js | `cc7c3ff7-3697-4f2f-aec1-7a044daae4b6` |
| Facebook | Sưu Tầm Hàng Dị | reup --page shopee + fb_repost + trending_repost | `f195f36e-ebec-4589-a05c-ac5ddfd15b24` |
| Facebook | Đồ Gia Dụng Thông Minh | reup --page gia_dung | `ba5a4459-287b-4a5e-8369-d481b2593b5c` |
| Facebook | Đồ Công Nghệ Giá Tốt | reup --page tech | `0368057a-f4af-4e0f-93da-fd6826ffbc56` |

---

## 3. Chi tiết từng script

### 3.1 `src/daily.mjs` — Orchestrator

Chạy toàn bộ pipeline TikTok + FB bằng 1 lệnh.

**Options:** `--fb-only`, `--tt-only`, `--skip-cache`

**Flow:**
1. TikTok Veo pipeline chạy song song với FB
2. Check cache age, refresh nếu >4h (fetch_products → kill Chrome)
3. 4 FB scripts chạy song song (delay lệch: 0/10/20/30 phút)
4. Tổng kết kết quả

---

### 3.2 `src/pipeline-quotes-veo.js` — TikTok Video Pipeline

Tạo video motivation quotes AI hoàn chỉnh, 7 bước:

| Bước | Mô tả | Tool |
|------|-------|------|
| 1. Quotes | Chọn 4 quotes cùng category từ SQLite | db.js |
| 2. Script | Narration ~120s + hook prompt + scene directions | Claude Sonnet 4 |
| 3. Voiceover | Giọng Algenib (deep, gravelly), fallback Edge TTS | Gemini TTS |
| 4a. Hook | Video cinematic 8s (bỏ qua nếu quota hết) | Veo 3.1 |
| 4b. Scenes | Mỗi quote → ảnh AI → Ken Burns animation | Imagen 4.0 |
| 5. Compose | Title 1.5s → Hook 8s → 4 slides → xfade transitions | FFmpeg |
| 6. Upload | Caption + hashtags → schedule TikTok | PostFast |
| 7. Cleanup | Mark quotes used, delete temp files | db.js |

**Chi phí:** ~$1.32/video (Veo fast + Imagen)
**Duration:** ~110-135s per video
**Categories:** 10 niches (triết lý sống, tư duy tài chính, tình yêu...)

**CLI:** `node src/pipeline-quotes-veo.js [--dry-run] [--category="..."] [--veo=fast|standard]`

---

### 3.3 `src/shopee/reup.mjs` — Shopee Product Video Reup

Download video sản phẩm Shopee → FFmpeg crop 9:16 + watermark → AI caption → đăng FB.

**Flow:**
1. Tìm sản phẩm từ cache (affiliate.mjs đọc products_cache.json)
2. Download MP4 từ Shopee CDN
3. FFmpeg: crop 9:16, text overlay (tên + giá), badge watermark
4. AI caption (Claude Haiku) — 2-3 câu ngắn + hashtags
5. Shorten affiliate link (is.gd)
6. PostFast upload + schedule FB Reel
7. Auto comment link mua hàng sau 60 phút (page shopee)

**CLI:** `node src/shopee/reup.mjs --page <shopee|gia_dung|tech> [--delay N]`

**Dedup:** `used_shopee_ids` trong state.json (500 item gần nhất)
**Limits:** MAX_PER_DAY=12, MAX_PER_RUN=2, POST_INTERVAL=5 phút
**TikTok posting:** TẠM TẮT (commented out)

---

### 3.4 `src/shopee/fb_repost.mjs` — FB Video Repost

Scrape video từ 5 FB page nguồn → download → repost lên Sưu Tầm Hàng Dị.

**Source pages:** dathangtrungquoc01, suutamdohay, dosinhton01 + 2 profile
**Flow:** Chrome CDP scrape → yt-dlp download → template caption → PostFast FB Reel
**Dedup:** processed.json (video IDs)
**CLI:** `node src/shopee/fb_repost.mjs [--source N] [--max N] [--delay N]`

---

### 3.5 `src/shopee/trending_repost.mjs` — Trending Video Repost (KHÔNG nằm trong daily)

Tự tìm video viral từ TikTok + Facebook bằng keyword search → reup lên Sưu Tầm Hàng Dị.

**Discovery:**
- TikTok: Chrome CDP (profile `chrome_tiktok`) → search keywords → extract video links + view counts
- Facebook: Chrome CDP headless → search FB videos → extract links

**Keywords (rotate mỗi lần):**
- TikTok: "hàng độc lạ", "đồ gia dụng thông minh", "phát minh hay"...
- Facebook: "đồ công nghệ", "review shopee", "phát minh sáng tạo"...

**Download:** yt-dlp (FB) + Chrome CDP fallback (TikTok, vì yt-dlp bị block)
**Schedule:** Golden hours VN [7h, 11h, 17h, 20h], cách nhau 30 phút/video
**Limits:** maxPerDay=5, maxPerRun=3
**Sort:** Videos sort theo view count (cao nhất trước)

**CLI:** `node src/shopee/trending_repost.mjs [--source tiktok|facebook|both] [--max N] [--dry-run]`

**TikTok page:** Chưa tạo, khi tạo set `TRENDING_CONFIG.tiktokId` trong config.mjs → auto dual-post

---

### 3.6 `src/shopee/fetch_products.mjs` — Shopee Product Cache

Chrome visible (off-screen, bypass TLS fingerprinting) → fetch bestsellers + 11 categories → save products_cache.json.

**Tại sao dùng Chrome visible:** Shopee block Node fetch, curl, headless Chrome (TLS fingerprinting). Chỉ Chrome visible window mới bypass.

**CLI:** `node src/shopee/fetch_products.mjs [--cats 100637,100640]`
**QUAN TRỌNG:** Phải kill Chrome sau khi chạy xong (tránh xung đột port)

---

## 4. Modules hỗ trợ

| File | Mô tả |
|------|-------|
| `src/env.js` | Load .env từ config/.env, import trước mọi module khác |
| `src/shopee/config.mjs` | Cấu hình pages, categories, PostFast IDs, paths, TRENDING_CONFIG |
| `src/shopee/caption.mjs` | AI caption (Claude Haiku) — 2-3 câu + hashtags, fallback template |
| `src/shopee/affiliate.mjs` | Shopee Affiliate API qua Chrome CDP, class ShopeeAffiliate |
| `src/shopee/shorten_url.mjs` | Rút gọn URL qua is.gd, fallback shopee.vn/product/... |
| `src/script-writer.js` | Claude Sonnet 4 — narration script + Veo scene directions |
| `src/tts.js` | TTS: Gemini (Algenib) → Edge TTS fallback |
| `src/gemini-tts.js` | Google Gemini TTS, 30 voices, WAV output |
| `src/veo.js` | Veo 3.1 video generation (8s, 9:16), 3 model tiers |
| `src/imagen.js` | Imagen 4.0 Fast image generation, fallback Gemini Flash |
| `src/postfast.js` | PostFast API: upload S3, schedule, analytics, delete |
| `src/db.js` | SQLite: quotes, videos, hashtags, analytics |

---

## 5. Data & State

```
D:/tiktok/data/
├── content.db                     # SQLite: quotes, videos, hashtags
├── shopee/
│   ├── products_cache.json        # Cache sản phẩm (maxAge 4h)
│   ├── chrome_aff/                # Chrome profile cho Affiliate API
│   ├── chrome_fetch/              # Chrome profile cho fetch_products
│   ├── chrome_tiktok/             # Chrome profile cho TikTok search
│   ├── shopee/state.json          # Dedup + daily tracking (page shopee)
│   ├── gia_dung/state.json        # Page gia_dung
│   ├── tech/state.json            # Page tech
│   ├── fb-repost/processed.json   # FB repost dedup
│   └── trending-repost/state.json # Trending repost dedup + daily count
│
D:/tiktok/config/
├── .env                           # API keys (ANTHROPIC, GEMINI, POSTFAST...)
└── shopee_cookie.txt              # Shopee affiliate cookies
│
D:/tiktok/queue/                   # Video queue (temp files)
```

---

## 6. Environment Variables (config/.env)

```
ANTHROPIC_API_KEY=sk-ant-...       # Claude API (caption, script)
GEMINI_API_KEY=...                 # Google Gemini/Veo/Imagen/TTS
POSTFA_API_KEY=...                 # PostFast scheduling
TELEGRAM_BOT_TOKEN=...            # Telegram health alerts
TELEGRAM_CHAT_ID=...              # Telegram chat
SHOPEE_AFF_COOKIE=...             # Shopee affiliate cookies (hoặc dùng file)
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
FONT_PATH=C:/Windows/Fonts/arial.ttf
DB_PATH=./data/content.db
QUEUE_DIR=./queue
```

---

## 7. Dependencies

**npm packages:** @anthropic-ai/sdk, @google/genai, better-sqlite3, dotenv, msedge-tts, luxon, node-cron, ws

**System:** FFmpeg, FFprobe, Chrome, yt-dlp, Node.js 18+

---

## 8. Fallback Strategy

| Component | Primary | Fallback |
|-----------|---------|----------|
| TTS | Gemini TTS (Algenib) | Edge TTS (NamMinhNeural) |
| Video | Veo 3.1 (8s) | Imagen + Ken Burns |
| Shopee API | Chrome CDP | products_cache.json |
| URL Shortener | is.gd | shopee.vn/product/... |
| TikTok Download | yt-dlp | Chrome CDP extract video src |
| AI Caption | Claude Haiku | Template fallback |
| FFmpeg | preset fast | preset ultrafast |

---

## 9. Lưu ý quan trọng

1. **Pipeline TikTok đúng:** Luôn dùng `pipeline-quotes-veo.js` (file `pipeline-quotes.js` đã bị xóa)
2. **TTS:** Gemini TTS giọng Algenib (deep, gravelly). ElevenLabs đã bị remove
3. **Shopee cookies:** Hết hạn → login lại Chrome → copy cookie mới vào config
4. **Chrome conflicts:** daily.mjs tự kill Chrome giữa các step. fetch_products PHẢI kill Chrome sau khi xong
5. **TikTok posting trên FB scripts:** TẠM TẮT (commented out), chỉ post FB
6. **Video interval:** 5 phút giữa các video cùng page
7. **trending_repost.mjs:** Chạy riêng, KHÔNG nằm trong daily.mjs
8. **Dedup:** Mỗi page có state riêng, trending cross-check với fb_repost
9. **Caption mới:** 2-3 câu ngắn gọn + hashtags, không CTA/follow/link trong caption (link append tự động)

---

## 10. Commands nhanh

```bash
# Chạy tất cả (TikTok + FB)
cd D:/tiktok && node src/daily.mjs

# Chỉ FB
node src/daily.mjs --fb-only

# Chỉ TikTok
node src/daily.mjs --tt-only

# Chạy riêng từng script
node src/pipeline-quotes-veo.js                          # 1 video TikTok
node src/shopee/fetch_products.mjs                       # Refresh cache
node src/shopee/reup.mjs --page shopee --delay 0         # FB Sưu Tầm Hàng Dị
node src/shopee/reup.mjs --page gia_dung --delay 10      # FB Gia Dụng
node src/shopee/reup.mjs --page tech --delay 20          # FB Công Nghệ
node src/shopee/fb_repost.mjs --max 2 --delay 30         # FB Repost
node src/shopee/trending_repost.mjs --max 3              # Trending (riêng)
node src/shopee/trending_repost.mjs --source tiktok      # Trending TikTok only
node src/shopee/trending_repost.mjs --dry-run            # Test không post
```
