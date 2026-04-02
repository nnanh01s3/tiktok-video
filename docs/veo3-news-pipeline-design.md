# Veo3 News Video Pipeline — Design Spec

## Status: APPROVED (2026-03-31)

## 1. Mục tiêu

Tự động hóa quy trình tạo video bản tin có nhân vật cố định bằng Veo3, từ kịch bản markdown đến video hoàn chỉnh. Dựa trên SOP nội bộ 7 bước, tự động hóa bước 3-7.

**Scope:** Kịch bản có sẵn -> Video final. Không bao gồm chọn chủ đề, viết kịch bản, đăng bài.

## 2. Yêu cầu đã xác nhận

| Yếu tố | Quyết định |
|---------|-----------|
| Input | File markdown, kịch bản chia sẵn theo cảnh |
| Nhân vật | Ảnh cố định, mô tả cố định |
| Prompt sinh | Bot tự sinh theo cấu trúc SOP mục 7 (Claude AI) |
| Render | Veo 3.1 API qua Google AI Studio, 1 bản/cảnh, reference image |
| Voice | RVC voice conversion post-render để đồng nhất giọng |
| Hậu kỳ | FFmpeg (tự động hoàn toàn) |
| Output | Video hoàn chỉnh, tỷ lệ tùy kịch bản (9:16 hoặc 16:9) |
| Điểm dừng | Video xong, không đăng bài |

## 3. Pipeline Flow

```
┌─────────────┐
│  Input:      │
│  script.md   │  <- Kịch bản markdown (cảnh + lời thoại + chỉ dẫn)
│  avatar.png  │  <- Ảnh nhân vật cố định
│  config.yml  │  <- Mô tả nhân vật, voice target, aspect ratio...
└──────┬──────┘
       ▼
┌──────────────────┐
│ Step 1: Parse     │  Parse markdown -> array of scenes
│ Markdown          │  [{scene_id, dialogue, action, background, duration_hint}]
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Step 2: Generate  │  Claude AI sinh prompt Veo3 cho từng cảnh
│ Veo3 Prompts      │  Theo cấu trúc SOP mục 7:
│                    │  Nhân vật + Hành động + Bối cảnh + Camera +
│                    │  Phong cách + Âm thanh + Lời thoại + Negative
│                    │  + Voice Lock prompt (SOP mục 15)
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Step 3: Render    │  Gọi Veo 3.1 API lần lượt từng cảnh
│ Veo3 Clips        │  model: veo-3.1-generate-preview
│                    │  reference_image = avatar.png
│                    │  1 clip/cảnh, retry nếu API error
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Step 4: Voice     │  Tách audio từ mỗi clip (ffmpeg)
│ Conversion (RVC)  │  RVC convert -> voice target cố định (.pth model)
│                    │  Ghép audio mới lại vào clip (ffmpeg)
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Step 5: Compose   │  FFmpeg filter_complex:
│ Final Video       │  - xfade transitions giữa các cảnh
│ (FFmpeg)          │  - Cân âm lượng (loudnorm)
│                    │  - Nhạc nền optional
│                    │  - Output: final_video.mp4
└──────────────────┘
```

## 4. Input Format — script.md

```markdown
---
title: Bản tin tài chính 31/03/2026
aspect_ratio: 9:16
character: mc-finance
background_music: soft-news
---

## Cảnh 1
- Bối cảnh: Studio bản tin, màn hình LED hiển thị biểu đồ chứng khoán
- Hành động: Nói trực diện vào camera, biểu cảm nghiêm túc

> Xin chào quý vị, hôm nay thị trường chứng khoán Việt Nam đã có phiên
> giao dịch khá biến động. VN-Index đóng cửa giảm 12 điểm, xuống mức
> 1.285 điểm, với thanh khoản đạt hơn 18 nghìn tỷ đồng.

## Cảnh 2
- Bối cảnh: Studio, màn hình hiển thị top cổ phiếu tăng/giảm
- Hành động: Nhìn sang màn hình rồi quay lại camera, cử chỉ tay nhẹ

> Trong nhóm VN30, các mã ngân hàng như VCB, BID, CTG đồng loạt giảm
> điểm. Tuy nhiên, nhóm công nghệ và bất động sản khu công nghiệp lại
> ghi nhận sự khởi sắc đáng chú ý.
```

## 5. Config — config.yml

```yaml
characters:
  mc-finance:
    avatar: ./assets/mc-finance.png
    description: >
      Nữ MC người Việt, khoảng 28 tuổi, khuôn mặt trái xoan,
      tóc đen dài ngang vai, blazer xanh navy, áo sơ mi trắng,
      phong thái chuyên nghiệp, bình tĩnh.
    voice_lock: >
      nữ, giọng miền Nam Việt Nam tự nhiên, trẻ, mềm, ấm,
      rõ chữ, bình tĩnh, thân mật

voice:
  rvc_model: ./models/mc-finance-voice.pth
  rvc_index: ./models/mc-finance-voice.index
  pitch_shift: 0

defaults:
  aspect_ratio: "9:16"
  camera: "medium shot, eye-level, static shot"
  style: "realistic, cinematic, clean broadcast look, high detail"
  negative_prompt: >
    méo mặt, đổi tóc, đổi trang phục, thêm người, tay lỗi,
    rung máy mạnh, nền lộn xộn, khẩu hình lệch

ffmpeg:
  transition: dissolve
  transition_duration: 0.5
  audio_normalize: true
```

## 6. Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js (ESM) |
| Script parsing | Markdown-it + custom parser |
| Prompt generation | Claude API (Anthropic SDK) |
| Video rendering | Veo 3.1 API (Gemini SDK) |
| Voice conversion | RVC (Python, gọi qua child_process) |
| Post-production | FFmpeg (filter_complex) |
| Config | YAML (js-yaml) |

## 7. Vấn đề Voice Consistency

**Vấn đề gốc:** Veo3 không có voice ID — mỗi clip render độc lập sinh giọng khác nhau dù cùng prompt Voice Lock. Kết quả: nhiều giọng Bắc khác nhau giữa các cảnh.

**Giải pháp:** RVC voice conversion post-render
1. FFmpeg tách audio từ mỗi clip Veo3
2. RVC convert audio sang voice target cố định (1 model .pth train từ giọng mẫu)
3. FFmpeg ghép audio mới vào video (giữ nguyên lip sync từ Veo3)

**Trade-off:** Lip sync có thể không khớp 100% vì audio đã bị biến đổi, nhưng RVC giữ timing và prosody nên sai lệch rất nhỏ.

## 8. Phương án đã xem xét và loại bỏ

| Phương án | Lý do loại |
|-----------|-----------|
| CapCut API | Không có public API cho server-side rendering |
| JSON2Video | Tốn phí, phụ thuộc service ngoài |
| Hybrid FFmpeg + CapCut manual | Không 100% tự động |
| ElevenLabs TTS thay voice | Lip sync không khớp vì Veo3 render miệng theo audio riêng |

## 9. SOP Reference

Thiết kế dựa trên SOP nội bộ:
- **Mục 7**: Cấu trúc prompt chuẩn
- **Mục 8**: Quy chuẩn viết prompt (nhân vật cố định, background hạn chế)
- **Mục 15**: Voice Lock prompt (giữ 1 giọng duy nhất xuyên suốt)

## 10. Next Steps

- [ ] Train RVC model từ giọng mẫu mong muốn
- [ ] Implement script parser (markdown -> scenes)
- [ ] Implement prompt generator (Claude API)
- [ ] Implement Veo 3.1 render step
- [ ] Implement RVC voice conversion step
- [ ] Implement FFmpeg compose step
- [ ] Integration test end-to-end
