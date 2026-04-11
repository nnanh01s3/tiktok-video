# Rừng Xì Tin — Video Pipeline Design

## Context

Kênh TikTok "Khu Rừng Xì Tin" (hiện tên @suutam0405, sẽ đổi sau) sản xuất series hoạt hình ngắn 2 phút/tập. 4 nhân vật 3D Pixar style (Momo khỉ, Tiko rùa, Lala cáo, Bobo gấu) sống trong khu rừng drama. Season 1 có 15 tập, mỗi tập là câu chuyện độc lập.

**Thư mục**: `D:\tiktok\vung`
**Assets có sẵn**: Kịch bản tập 1, character design images (4 nhân vật), 4 bối cảnh, character prompts, style guide.

## Pipeline Overview

```
Kịch bản (.md) → Claude parse scenes → [Imagen scene images → Veo 2.0 animate → TTS dialogue] × N scenes → FFmpeg compose → Video 2 phút → Post TikTok
```

**Cost**: ~$0.52/tập (Imagen $0.45 + TTS $0.02 + Claude $0.05, Veo 2.0 free).

## Step-by-step Pipeline

### Step 1: Parse kịch bản → Scene prompts

**Input**: Kịch bản `.md` (VD: `tap_01_qua_chuoi_bi_an.md`)
**Tool**: Claude Sonnet 4
**Output**: Array of scene objects

Claude đọc kịch bản + `characters.md` + `style_guide.md` → trả JSON:

```json
{
  "title": "Quả Chuối Bí Ẩn",
  "caption": "Khi bạn tưởng mình sắp đổi đời… 🍌",
  "scenes": [
    {
      "sceneId": 1,
      "timeRange": "0:00-0:05",
      "type": "hook",
      "description": "Close-up Momo ôm chuối, camera zoom nhẹ",
      "characters": ["momo"],
      "imagenPrompt": "Close-up shot of Momo the monkey, slim body light brown fur cream face big expressive eyes, hugging a banana with suspicious expression, looking left and right, vibrant forest background, cute 3D cartoon pixar style, soft cinematic lighting, 9:16 vertical",
      "veoPrompt": "The monkey slowly looks around suspiciously while hugging a banana, then quickly runs away. Smooth animation, camera zoom in slightly.",
      "dialogue": [
        { "character": "momo", "text": "Đây chắc chắn là báu vật hiếm nhất khu rừng!", "style": "whispering" }
      ],
      "sfx": ["mysterious_music"],
      "duration": 5
    }
  ]
}
```

**Rules cho Claude**:
- `imagenPrompt` PHẢI chứa character prompt gốc từ `characters.md` (giữ consistency)
- `imagenPrompt` PHẢI kết thúc bằng master style: "cute 3D cartoon pixar style, soft cinematic lighting"
- `veoPrompt` mô tả chuyển ĐỘNG, không mô tả nhân vật (Veo animate từ ảnh)
- Scenes dài >8s phải chia thành nhiều sub-scenes (max 8s/clip cho Veo 2.0)
- Total duration ~120s

### Step 2: Generate scene images (Imagen 4.0)

**Input**: `imagenPrompt` + reference images nhân vật
**Tool**: Imagen 4.0 Fast (`imagen-4.0-fast-generate-001`)
**Output**: 1 scene image PNG per scene (9:16)

Mỗi scene: gửi prompt + nhân vật chính scene đó làm context trong prompt text. Imagen không hỗ trợ reference image trực tiếp, nhưng prompt chứa character description chi tiết → kết quả gần đúng.

**Lưu ý**: Nếu upgrade lên Veo 3.1 sau, có thể dùng `referenceImages` parameter với max 3 ảnh nhân vật → consistency tốt hơn nhiều.

### Step 3: Animate scene images (Veo 2.0)

**Input**: Scene image + `veoPrompt`
**Tool**: Veo 2.0 (`veo-2.0-generate-001`) — free tier
**Output**: 8s video clip MP4 per scene

Gọi `generateVideos` API với:
- `model`: `veo-2.0-generate-001`
- `prompt`: `veoPrompt` (chỉ mô tả motion, không mô tả nhân vật)
- `image`: scene image từ Step 2 (image-to-video mode)
- `config.aspectRatio`: `9:16`

**Rate limit**: 2 uses/model/day cho Veo 2.0 free → cần batch generate hoặc xử lý qua nhiều ngày cho 15 scenes. Workaround: dùng multiple model keys hoặc accept 2-3 ngày/tập.

**Fallback**: Nếu Veo quota hết → dùng Ken Burns/parallax effect trên scene image (giống pipeline quotes hiện tại).

### Step 4: Generate dialogue audio (Gemini TTS)

**Input**: Dialogue text + character voice mapping
**Tool**: Gemini 2.5 Flash TTS
**Output**: 1 audio file per dialogue line

Voice mapping (Gemini TTS voices):

| Character | Voice | Style instruction |
|-----------|-------|-------------------|
| Momo | Puck | "Speak fast, mischievous, playful. Vietnamese." |
| Tiko | Sadaltager | "Speak slow, calm, wise. Vietnamese." |
| Lala | Aoede | "Speak dramatic, high-pitched, sassy. Vietnamese." |
| Bobo | Fenrir | "Speak slow, silly, warm, a bit confused. Vietnamese." |
| Narrator | Charon | "Speak clear, storytelling tone. Vietnamese." |

Mỗi dialogue line → 1 audio file. Timestamp alignment dựa trên scene duration.

### Step 5: Compose final video (FFmpeg)

**Input**: Scene clips + dialogue audio + SFX + background music
**Tool**: FFmpeg
**Output**: 1 video MP4 (9:16, ~120s)

Composition layers:
1. **Video track**: Concat scene clips theo thứ tự, xfade transitions (dissolve/fade 0.5s)
2. **Dialogue track**: Mix dialogue audio tại đúng timestamp mỗi scene
3. **SFX track**: Sound effects (pop, boing, whoosh) tại các moment key
4. **Music track**: Nhạc nền vui nhộn (volume 15%, loop)
5. **Subtitle track**: Dialogue text overlay (font bold trắng, viền đen)

### Step 6: Post to TikTok

**Tool**: `tiktok-direct.mjs` (Chrome CDP)
**Target**: @suutam0405 (Khu Rừng Xì Tin)

Caption format:
```
{title} {emoji}
{caption từ kịch bản}
#RungXiTin #hoathinh #comedy #animation #viral #fyp
```

## File Structure

```
D:/tiktok/vung/
├── inputs/
│   ├── characters.md          # Character prompts (có sẵn)
│   ├── series_rung_xi_tin.md  # Series bible (có sẵn)
│   └── style_guide.md         # Visual style (có sẵn)
├── nhan_vat/                   # Reference images (có sẵn)
│   ├── Momo.png, Tiko.png, Lala.png, Bobo.png
│   └── boi_canh01-04.jpg
├── tap_01_qua_chuoi_bi_an.md  # Kịch bản (có sẵn)
│
├── src/                        # Pipeline code (TẠO MỚI)
│   ├── pipeline.mjs           # Main orchestrator
│   ├── scene-parser.mjs       # Claude parse kịch bản → scene JSON
│   ├── scene-renderer.mjs     # Imagen + Veo per scene
│   ├── voice-generator.mjs    # Gemini TTS multi-voice
│   └── composer.mjs           # FFmpeg final composition
│
├── assets/                     # SFX + music (TẠO MỚI)
│   ├── sfx/                   # pop.mp3, boing.mp3, whoosh.mp3...
│   └── music/                 # background tracks
│
├── output/                     # Generated output (auto)
│   └── tap_01/
│       ├── scenes.json        # Parsed scene data
│       ├── scene_01.png       # Imagen image
│       ├── scene_01.mp4       # Veo clip
│       ├── voice_01_momo.mp3  # TTS audio
│       └── tap_01_final.mp4   # Final video
```

## CLI Usage

```bash
# Generate 1 tập
node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md

# Dry run (chỉ parse scenes, không generate)
node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md --dry-run

# Generate từ step cụ thể (nếu đã có scenes.json)
node vung/src/pipeline.mjs --episode tap_01 --step render
node vung/src/pipeline.mjs --episode tap_01 --step compose
```

## Constraints & Limitations

| Constraint | Impact | Mitigation |
|-----------|--------|-----------|
| Veo 2.0 max 8s/clip | 15+ clips cho 2 phút | Chia scenes ≤8s, FFmpeg ghép |
| Veo 2.0 free: 2 uses/model/day | Chỉ 2 clips/ngày | Batch across days, hoặc dùng Ken Burns fallback |
| Không reference image (Veo 2.0) | Character drift | Imagen tạo keyframe trước → Veo animate từ ảnh |
| Imagen không reference image | Character gần đúng ~80% | Prompt chứa full character description |
| Gemini TTS tiếng Việt | Chất lượng vừa | Dùng style instruction chi tiết, fallback Edge TTS |

## Upgrade Path

Khi cần chất lượng cao hơn:
1. **Veo 3.1** ($1.20/clip): reference images cho character consistency 95%+
2. **Kling 3.0**: Element Binding cho multi-shot consistency, video 2 phút 1 lần
3. **SFX library**: Mua/tạo SFX pack chuyên cho hoạt hình
4. **Voice actors**: Thuê voice Vietnamese chuyên nghiệp thay AI TTS
