# Plan 3: Fix ElevenLabs — Giọng Đọc Premium

**Trạng thái**: Kế hoạch
**Ưu tiên**: Cao
**Ước tính**: 1-2 giờ triển khai

## Hiện Trạng

- ElevenLabs đã subscribe Starter ($12.10/tháng) → **30.000 characters/tháng**
- API key đang trả lỗi **401 Unauthorized** — key chưa được cập nhật trong `.env`
- Fallback Edge TTS (vi-VN-NamMinhNeural) đang hoạt động nhưng chất lượng thấp hơn
- Model đang dùng: `eleven_multilingual_v2` — hỗ trợ tiếng Việt
- Voice ID mặc định: `pNInz6obpgDQGcFmaJgB` (Adam — giọng tiếng Anh) → **KHÔNG phù hợp tiếng Việt**

## Vấn Đề Cần Giải Quyết

### 1. Fix API Key 401
- **Nguyên nhân có thể**: Key cũ/sai trong `.env`, hoặc key chưa được tạo lại sau khi subscribe
- **Hành động**: Lấy key mới từ https://elevenlabs.io/app/settings/api-keys → cập nhật `.env`
- **Verify**: Chạy `node -e "import './src/env.js'; ..."` test API call

### 2. Chọn Voice Phù Hợp Tiếng Việt
- Voice `pNInz6obpgDQGcFmaJgB` (Adam) là giọng tiếng Anh → phát âm tiếng Việt kém
- Cần tìm voice phù hợp qua `listVoices()` API hoặc ElevenLabs Voice Library
- **Tiêu chí**: Giọng nam, trầm, rõ ràng, phát âm tiếng Việt tốt (model multilingual_v2)
- **Phương án**:
  - Option A: Dùng voice có sẵn trong ElevenLabs library (miễn phí)
  - Option B: Clone voice từ sample audio (cần subscribe Creator plan $22/tháng)
  - **Khuyến nghị**: Option A trước — test vài voice multilingual, chọn voice phát âm Việt tốt nhất

### 3. Quản Lý Quota Thông Minh (30K chars/tháng)
- Mỗi script ~900 ký tự → **~33 video/tháng** với ElevenLabs
- Cần 90 video/tháng (3/ngày × 30 ngày)
- **Chiến lược phân bổ**:

| Loại video | Số lượng/tháng | TTS Engine | Lý do |
|---|---|---|---|
| Video giờ tối (19h) | 30 | ElevenLabs | Giờ cao điểm, cần chất lượng cao nhất |
| Video giờ sáng (7h) | 30 | Edge TTS | Giờ vừa, Edge TTS đủ tốt |
| Video giờ trưa (12h) | 30 | Edge TTS | Giờ thấp nhất, tiết kiệm quota |

- **Logic trong scheduler**: Slot `evening` → force ElevenLabs, slot `morning`/`noon` → force Edge TTS
- Khi quota ElevenLabs <5000 chars → tự động chuyển tất cả sang Edge TTS + Telegram alert

### 4. Cải Thiện Edge TTS Fallback
- Edge TTS hiện dùng `vi-VN-NamMinhNeural` — giọng cứng, robotic
- **Cải thiện**:
  - Thử `vi-VN-HoaiMyNeural` (nữ) — có thể tự nhiên hơn cho một số chủ đề
  - Thêm SSML tags để điều chỉnh tốc độ, ngắt nghỉ: `<break time="500ms"/>` sau mỗi quote
  - Giảm tốc độ đọc 5-10% cho giọng trầm hơn
- **Lưu ý**: `msedge-tts` package có thể không hỗ trợ đầy đủ SSML → test trước

## Thay Đổi Code

### `src/tts.js` — Sửa đổi

```
Thay đổi:
1. Thêm hàm getElevenLabsUsage() — check remaining quota qua API
2. Thêm hàm pickProvider(slot) — chọn ElevenLabs/Edge dựa trên slot + quota
3. Sửa generateVoiceover() nhận param `slot` để quyết định provider
4. Thêm SSML support cho Edge TTS (rate, breaks)
5. Cập nhật EDGE_VOICES: thêm option vi_female
```

### `src/index.js` — Sửa nhỏ

```
Thay đổi:
1. Truyền slot name ('morning'/'noon'/'evening') vào pipeline
2. Pipeline truyền slot vào generateVoiceover()
```

### `.env` — Cập nhật

```
Thay đổi:
1. ELEVENLABS_API_KEY=<key mới>
2. ELEVENLABS_VOICE_ID=<voice ID phù hợp tiếng Việt>
```

## Thứ Tự Thực Hiện

| # | Việc | Thời gian |
|---|---|---|
| 1 | Lấy API key mới → cập nhật .env | 5 phút (cần user) |
| 2 | Test API key: list voices + generate sample | 10 phút |
| 3 | Chọn voice phù hợp tiếng Việt (test 3-5 voices) | 20 phút |
| 4 | Cập nhật ELEVENLABS_VOICE_ID trong .env | 2 phút |
| 5 | Thêm quota management (getUsage + pickProvider) | 30 phút |
| 6 | Thêm slot-based provider selection | 20 phút |
| 7 | Cải thiện Edge TTS (rate, SSML nếu supported) | 30 phút |
| 8 | Test full: ElevenLabs evening + Edge morning/noon | 15 phút |

## Dependency

- **Bước 1 cần user action**: Lấy key mới từ ElevenLabs dashboard
- Sau bước 1, tất cả các bước còn lại tự động

## Rủi Ro

| Rủi ro | Giải pháp |
|---|---|
| Không có voice ElevenLabs phát âm Việt tốt | Dùng multilingual_v2 model + voice "Rachel" hoặc "Charlie" (đã test tốt với non-English) |
| Quota hết giữa tháng | Auto-fallback Edge TTS + Telegram alert |
| SSML không work với msedge-tts | Bỏ SSML, dùng plain text + điều chỉnh rate qua API param |
| ElevenLabs tăng giá | Có thể downgrade về free tier (10K chars) và dùng chỉ cho 11 video tối/tháng |

## Chi Phí Tối Ưu

| Scenario | ElevenLabs | Edge TTS | Tổng chi phí TTS |
|---|---|---|---|
| Hiện tại (tất cả Edge) | 0 video | 90 video | $0/tháng |
| Sau fix (tối 30 + Edge 60) | 30 video | 60 video | $12/tháng |
| Upgrade Creator (tất cả EL) | 90 video | 0 video | $22/tháng |

**Khuyến nghị**: Giữ Starter $12/tháng, dùng ElevenLabs cho video tối (cao điểm), Edge TTS cho còn lại. ROI tốt nhất.
