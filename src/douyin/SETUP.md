# Douyin Repurpose Pipeline — Setup & Usage

Pipeline tự động lấy video viral từ Douyin → OCR phụ đề CN → dịch sang VN → burn-in → repost lên TikTok/FB/YT.

## Cấu trúc

```
src/douyin/
├── config.mjs          # keywords, channels, OCR/subtitle/output params
├── state.mjs           # state.json read/write (status enum + corruption recovery)
├── discover.mjs        # Chrome CDP search/creator scrape
├── download.mjs        # yt-dlp + ffprobe verify
├── ocr-paddle.mjs      # Node ↔ Python PaddleOCR subprocess
├── extract-subs.mjs    # frame sampling + OCR dedup → CN SRT
├── fallback-asr.mjs    # Gemini multimodal ASR (when OCR below threshold)
├── translate.mjs       # Claude Haiku CN→VN, batch with cổ trang vocab
├── compose.mjs         # FFmpeg crop watermark + libass burn-in VN sub
├── publish.mjs         # multi-channel via social-poster.js (PostForMe)
├── repurpose.mjs       # orchestrator CLI
├── login-export.mjs    # one-time Chrome login + cookies.txt export
├── state.json          # processed video registry (auto-created)
└── utils/
    ├── log.mjs          # shared logger
    ├── srt.mjs          # parse / serialize / validate
    ├── parseViewCount.mjs  # "2.3w" → 23000
    ├── jaccard.mjs      # text similarity for OCR dedup
    ├── cdp.mjs          # Chrome CDP helper (persistent profile)
    └── is-cli.mjs       # ESM "is main module" check (Windows-safe)

scripts/paddle_ocr_batch.py    # Python OCR entry (stdin/stdout JSON)
```

Artifacts at `D:/tiktok/douyin/{modal_id}/` — gitignored, shared across worktrees.

## First-time setup (one-time)

### 1. Verify external deps

Already installed and verified:
- `yt-dlp 2026.03.17`
- `ffmpeg / ffprobe 8.1`
- `Python 3.12.10`
- `PaddleOCR` (Chinese model)
- `Node 22.19.0` + `ws` package

### 2. Login Douyin (manual, one-time)

Pipeline cần cookies + user-agent từ một browser session đã visit Douyin. Chạy lệnh sau **trong terminal trên máy của bạn** (không phải qua Claude — vì cần thấy cửa sổ Chrome):

```bash
cd D:/tiktok
node src/douyin/login-export.mjs --wait 60
```

Sẽ mở Chrome window (profile riêng tại `C:/Users/nnanh01/AppData/Local/douyin-cdp-profile/`).

- Login Douyin trong cửa sổ đó (nếu chưa)
- Hoặc chỉ cần browse vài video để cookies hydrate
- Sau 60s tự động dump:
  - `D:/tiktok/douyin/cookies.txt` (Netscape format cho yt-dlp)
  - `D:/tiktok/douyin/ua.txt` (User-Agent string)

**Nếu pipeline báo "Fresh cookies needed" sau này** → rerun lệnh này.

### 3. Cấu hình channels (khi tạo page)

Edit `src/douyin/config.mjs`, mở channels:

```js
channels: {
  tiktok:    { enabled: true,  pfmTtId: "<PostForMe TikTok account id>", provider: "postforme" },
  fb_reels:  { enabled: true,  pfmId:   "<PostForMe FB account id>",    provider: "postforme" },
  fb_page:   { enabled: false, pfmId:   null,                             provider: "postforme" },
  yt_shorts: { enabled: false, pfmYtId: null,                             provider: "postforme" },
},
```

YT Shorts hiện inactive vì `social-poster.js` chưa có method `scheduleYouTube` — publish.mjs sẽ tự động skip nếu enable.

## Routine usage

### Auto scan + repurpose (default)

```bash
node src/douyin/repurpose.mjs --keyword "百岁觉醒" --max 2
```

Pipeline tự động:
1. Chrome CDP → search keyword, scrape top 2 videos by view count
2. yt-dlp download mỗi video → `D:/tiktok/douyin/{modal_id}/original.mp4`
3. ffmpeg sample frames mỗi 300ms → PaddleOCR → dedup → `subs_cn.srt`
4. Nếu OCR <5 cues hoặc conf <0.6 → Gemini ASR fallback
5. Claude Haiku dịch sang VN với cổ trang vocab → `subs_vn.srt`
6. FFmpeg crop watermark + libass burn-in → `composed.mp4`
7. Generate VN caption + #trendingvideo #trend → upload qua PostForMe lên enabled channels

### Single video (đã có URL)

```bash
node src/douyin/repurpose.mjs --url "https://www.douyin.com/video/7626368910716608741"
```

### Resume (rerun từ artifacts đã có)

```bash
node src/douyin/repurpose.mjs --resume 7626368910716608741
```

Pipeline detect step nào đã có output, skip step đó. Useful khi crash giữa chừng.

### Retry failed

```bash
node src/douyin/repurpose.mjs --retry-failed
```

Scan state.json cho mọi video có status `*_failed` → rerun pipeline.

### Force rerun 1 step (vd dịch lại)

```bash
node src/douyin/repurpose.mjs --resume 7626... --force-step translate
```

Sẽ xóa `subs_vn.srt` cũ và gọi lại Claude. Useful khi không hài lòng với bản dịch.

### Discover only (xem candidates trước khi download)

```bash
node src/douyin/repurpose.mjs --keyword "百岁觉醒" --max 5 --dry-run
```

In ra JSON candidates, không download.

### Compose only (skip publish)

```bash
node src/douyin/repurpose.mjs --resume 7626... --skip-publish
```

### Dry-run publish (xem caption trước khi post)

```bash
node src/douyin/repurpose.mjs --resume 7626... --dry-run-publish
```

## Test pipeline

26 unit tests (pure functions):

```bash
npm run test:douyin
```

Smoke test compose riêng:
```bash
node src/douyin/compose.mjs <modal_id>   # requires subs_vn.srt + original.mp4
```

Smoke test translate riêng:
```bash
node src/douyin/translate.mjs <path_to_cn.srt> [vn.srt]
```

## State management

```bash
cat D:/tiktok/douyin/state.json
```

Schema:
```json
{
  "schema_version": 1,
  "videos": {
    "7626...": {
      "status": "published",         // discovered|downloaded|subs_extracted|translated|composed|published|*_failed
      "title_cn": "百岁觉醒 第一章",
      "subs_source": "ocr",          // or "asr"
      "cue_count": 24,
      "avg_confidence": 0.92,
      "char_ratio": 1.32,
      "channels_posted": ["fb_reels"],
      "channels_failed": [],
      "updated_at": "2026-05-25T..."
    }
  }
}
```

State auto-backup khi parse fail: `state.json.bak.{timestamp}`.

## Troubleshooting

| Vấn đề | Cách fix |
|---|---|
| yt-dlp "Fresh cookies needed" | Rerun `node src/douyin/login-export.mjs --wait 60` |
| Discover trả 0 candidates | Check `D:/tiktok/douyin/discover-empty-*.json`. DOM có thể đã đổi — selector trong discover.mjs cần update |
| PaddleOCR confidence thấp | Auto-fallback Gemini ASR. Nếu cả 2 đều fail, check `subs_meta.json` |
| Translate timing mismatch | Auto-retry 1× stricter prompt. Nếu vẫn fail → state.json status=`translate_failed`, dùng `--retry-failed` |
| Compose VN diacritics missing | Be Vietnam Pro chưa cài → fallback Arial Unicode MS (auto). Cài Be Vietnam Pro từ Google Fonts để đẹp hơn. |
| Compose crash với "Invalid argument" | Path issue — đã fix bằng cwd workaround. Nếu vẫn lỗi: report stderr 1500 chars cuối |
| Chrome lockfile error | Kill Chrome, xóa `C:/Users/nnanh01/AppData/Local/douyin-cdp-profile/lockfile`, rerun |
| `[Douyin] Failed to parse JSON` | Cookies stale — rerun login-export với `--url <video_url>` để warm cookies trên video cụ thể |

## Architecture notes

- **Disk artifacts pipeline**: mỗi module ghi output ra `{modal_id}/` folder. Crash giữa chừng → `--resume` skip steps đã xong, không tốn quota redo.
- **State.json status enum**: track failure point chính xác → `--retry-failed` chỉ rerun video gãy.
- **Subagent-friendly**: file nhỏ (60-200 dòng mỗi cái), tách concern rõ → dễ sửa khi Douyin đổi DOM hoặc cần thêm dub mode.
- **Reuse legos**: yt-dlp + Chrome CDP + Gemini + Claude + social-poster.js đều từ pipeline có sẵn (fb_repost / Rừng Xì Tin / shopee).

## Future work (out of scope v1)

- Dubbing (lồng tiếng VN TTS) — sẽ thêm `dub.mjs` module
- YouTube Shorts publish — cần thêm `scheduleYouTube` vào social-poster.js
- FB Reels vs FB Page differentiation (REEL vs POST content type)
- SQLite migration cho state.json khi volume tăng
- Scheduler integration vào `src/index.js` cho auto run hàng ngày
