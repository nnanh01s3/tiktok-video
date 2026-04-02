# Plan 2: Cải Thiện Visual — Từ "Đơn Điệu" Thành "Cinematic"

**Trạng thái**: Kế hoạch
**Ưu tiên**: Cao
**Ước tính**: 4-6 giờ triển khai

## Hiện Trạng

### Pipeline Veo (pipeline-quotes-veo.js)
- Veo tạo 8s clip/quote → FFmpeg ghép + text overlay + voiceover
- **Vấn đề**: Veo 2.0 free tier cho video 720x1280 → scale lên 1080x1920 bị mờ
- **Vấn đề**: Slow-mo `setpts=PTS/0.x` khi clip ngắn hơn segment → video giật
- **Vấn đề**: Text overlay chỉ có 1 kiểu (Montserrat Bold trắng + shadow đen)
- **Vấn đề**: Transitions chỉ có fade in/out — quá đơn giản
- **Vấn đề**: Khoảng nghỉ giữa slides là black screen thuần — nhàm chán

### Pipeline FFmpeg (pipeline-quotes.js — fallback)
- Slideshow tĩnh từ ảnh stock/Imagen
- Chưa review code chi tiết nhưng cùng vấn đề: đơn điệu, thiếu biến thể

## Mục Tiêu

Video output phải đạt mức **"không nhận ra là AI tạo"** — người xem nghĩ đây là video do creator thật edit.

## Các Cải Tiến

### A. Đa Dạng Text Style (5 template thay vì 1)

Hiện tại chỉ có 1 style: text trắng + shadow đen trên dark overlay.

**5 template mới** — pipeline random chọn 1 cho mỗi video:

| # | Tên | Mô tả |
|---|---|---|
| 1 | **Classic** | Giữ nguyên hiện tại (trắng trên dark overlay) — baseline |
| 2 | **Typewriter** | Text xuất hiện từng chữ (drawtext + enable='between(t,...)') |
| 3 | **Gradient Bar** | Text trên thanh gradient ngang (đen sang trong suốt) ở giữa |
| 4 | **Bottom Third** | Text ở 1/3 dưới màn hình (kiểu tin tức/phim tài liệu) |
| 5 | **Minimal** | Không overlay tối — text trắng với viền đen dày (stroke), để Veo video hiện rõ |

**Cách triển khai**: Tạo module `src/text-templates.js` export array template FFmpeg filter functions. `composeVideo()` gọi `pickTemplate()` để random.

### B. Transitions Đa Dạng (thay fade đơn thuần)

Hiện tại: chỉ `fade=t=in` + `fade=t=out` giữa mọi slide.

**Transitions mới** qua FFmpeg `xfade` filter:

| Transition | FFmpeg filter | Khi nào dùng |
|---|---|---|
| Fade (giữ) | `fade=t=in/out` | Default, 40% thời gian |
| Dissolve | `xfade=transition=dissolve` | Chuyển cảnh mượt, 20% |
| Slide left | `xfade=transition=slideleft` | Chuyển chủ đề, 15% |
| Wipe down | `xfade=transition=wipedown` | Reveal hiệu ứng, 15% |
| Fade black | `xfade=transition=fadeblack` | Ending/dramatic, 10% |

**Lưu ý**: `xfade` yêu cầu 2 video input overlap → cần sửa concat logic. Phức tạp hơn fade đơn. Có thể bắt đầu với dissolve/fadeblack trước (đơn giản nhất).

### C. Khoảng Nghỉ Có Nội Dung (thay black screen)

Hiện tại: `color=c=black:s=1080x1920:d=1.5` — 1.5s màn hình đen.

**Cải tiến**: Khoảng nghỉ vẫn 1.5s nhưng có nội dung:

| Option | Mô tả |
|---|---|
| **Blur transition** | Frame cuối của slide trước bị blur mạnh (boxblur) + fade |
| **Quote number** | Số thứ tự quote tiếp theo hiện lên (vd: "2/4") trên nền tối |
| **Breathing text** | Hiệu ứng text nhỏ "..." hoặc "💭" trên nền gradient |

**Khuyến nghị**: Dùng **blur transition** — tái sử dụng frame cuối của Veo clip, không cần tạo nội dung mới, trông chuyên nghiệp nhất.

### D. Cải Thiện Chất Lượng Veo Clip

**Vấn đề**: Veo 2.0 free tier → 720p → upscale mờ.

**Giải pháp theo thứ tự ưu tiên**:

1. **FFmpeg upscale tốt hơn**: Thay `scale=1080:1920:flags=lanczos` bằng `scale=1080:1920:flags=lanczos,unsharp=5:5:0.5:5:5:0.3` (sharpen sau upscale)
2. **Chờ Veo quota reset** → dùng `veo-3.0-fast-generate-001` (paid tier, native 1080p)
3. **Nếu có budget**: Upgrade Gemini billing → Veo 3.1 (1080p native + ambient audio)

### E. Intro/Outro Sequence

Hiện tại: Outro chỉ là "Trí Tuệ Mỗi Ngày" text trên black 1.5s.

**Cải tiến**:
- **Intro (2s)**: Channel logo + tên kênh fade in trên nền gradient tối → set expectation cho viewer
- **Outro (3s)**: Recap quote hay nhất (1 dòng) + channel name + "Follow để nhận thêm mỗi ngày" (nhẹ nhàng, không spam)

**Tổng thời gian thêm**: ~5s → video từ 66s lên ~71s (vẫn trong range tốt).

**Cần asset**: Logo kênh PNG (đã có tại `assets/branding/avatar.png`).

## Thứ Tự Thực Hiện (từ dễ → khó, impact cao trước)

| Wave | Việc | Impact | Effort |
|---|---|---|---|
| 1 | Sharpen upscale (FFmpeg flag) | Trung bình | 5 phút |
| 1 | Blur transition thay black gap | Cao | 30 phút |
| 2 | 5 text templates + random pick | Cao | 2 giờ |
| 2 | Intro/Outro sequence | Trung bình | 1 giờ |
| 3 | xfade transitions (dissolve, fadeblack) | Trung bình | 2 giờ |
| 3 | Typewriter effect template | Thấp | 1 giờ |

**Wave 1** (làm ngay, impact/effort tốt nhất): sharpen + blur gap = ~35 phút, cải thiện đáng kể.

## Thay Đổi Code

### Files cần sửa:
- `src/pipeline-quotes-veo.js` — hàm `composeVideo()`: sharpen, blur gap, intro/outro, template system
- `src/text-templates.js` — **TẠO MỚI**: 5 text overlay templates

### Files không đổi:
- `src/veo.js` — giữ nguyên, chỉ đổi model khi có billing
- `src/script-writer.js` — giữ nguyên
- `src/postfast.js` — giữ nguyên

## Rủi Ro

| Rủi ro | Giải pháp |
|---|---|
| FFmpeg filter quá phức tạp → render fail | Test từng template riêng trước khi tích hợp |
| xfade không hoạt động với concat nhiều stream | Bắt đầu với dissolve (đơn giản nhất), fallback fade nếu fail |
| Typewriter effect lag trên video dài | Giới hạn chỉ dùng cho slide đầu tiên (hook) |
| Intro/Outro làm video dài quá | Giữ tổng ≤90s, giảm segment duration nếu cần |
