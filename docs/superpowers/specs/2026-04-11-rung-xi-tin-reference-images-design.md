# Rừng Xì Tin — Sinh hình ảnh scene với Reference Image (Phương án A)

**Ngày:** 2026-04-11
**Trạng thái:** Đã duyệt
**Người phụ trách:** Ricky Nguyen
**Liên quan:** `docs/superpowers/specs/2026-04-09-rung-xi-tin-pipeline-design.md` (kiến trúc pipeline gốc)

## Mô tả vấn đề

Pipeline Rừng Xì Tin hiện tại (`vung/src/`) tạo ra `tap_01_final.mp4` mà nhân vật **trông khác nhau ở mỗi scene**: Momo khỉ có tỷ lệ cơ thể khác nhau giữa scene 2 và scene 7, Tiko rùa có mắt xanh ở frame này nhưng mắt nâu ở frame kia, nhân vật bị trùng lặp (2 Bobo, 2 Lala), và watermark Pixar cùng caption tiếng Việt bị lọt từ training data. Mục tiêu: **chạy 1 lần render sạch** cho ra output đạt chất lượng đăng TikTok — không retry lặp lại tốn quota nữa.

### Bằng chứng từ audit frame `tap_01_final.mp4` (121.9s, 10 frame lấy mẫu mỗi 12s)

| Frame | Vấn đề phát hiện |
|---|---|
| Frame 2 (scene 2) | Momo kiểu 1: lông nâu sáng, đuôi mảnh |
| Frame 5 (scene 5) | Momo kiểu 2 (nâu đậm hơn); Lala không mặc đồ; Tiko mắt xanh; **2 con gấu** |
| Frame 8 (scene 11) | Tiko đổi màu mắt; Bobo đổi khuôn mặt |
| Frame 10 (scene 15) | Momo trông như gorilla; **2 con cáo**; **2 con rùa** (mất kính) |
| Frame 4 (scene 5) | **Watermark Pixar** góc trên trái + **caption tiếng Việt** ở dưới ("Lala... hương vừa...") |

### Nguyên nhân gốc (xếp theo mức độ ảnh hưởng)

1. **Không có cơ chế giữ nhất quán nhân vật.** `scene-renderer.mjs:buildScenePrompt()` chỉ đưa mô tả text từ `voices.mjs` cho Imagen 4.0 Fast. Mỗi scene là một mẫu ngẫu nhiên mới — không có gì ràng buộc Momo-scene-2 phải giống Momo-scene-7 về mặt hình ảnh.
2. **`vung/nhan_vat/*.png` chưa bao giờ được sử dụng.** Có 4 file PNG character sheet chuẩn Pixar 3D (`momo.png`, `Tiko.png`, `Lala.png`, `Bobo.png`) nhưng không có đoạn code nào load chúng.
3. **Lọt dữ liệu stock Pixar.** Prompt tiếng Việt chứa "Pixar 3D cartoon" khiến Imagen retrieve từ training data có video TikTok chứa watermark và caption.
4. **Bug nhân vật trùng lặp vẫn còn.** Dù đã fix `dedupeActionText` dùng đại từ tiếng Việt, các scene nhiều nhân vật vẫn render 2 Bobo / 2 Lala vì dedupe đơn thuần không chặn được xu hướng "lặp không gian" của Imagen.
5. **`characters.md` không đồng bộ với `nhan_vat/*.png`.** Mô tả text thiếu chi tiết trang phục mà ảnh PNG thể hiện (Lala mặc quần jean + áo polo, Bobo mặc áo thun xanh).

### Thành công trông như thế nào

Một lần render toàn tập duy nhất mà:

- Tất cả 14 scene truyện (2-15) hiển thị Momo/Tiko/Lala/Bobo với độ trung thực hình ảnh ≥80% so với character sheet `nhan_vat/*.png`
- Không có nhân vật trùng lặp
- Không có watermark, caption, hoặc logo
- Không có hình người hoặc chó
- Tổng chi phí ≤ $7 mỗi lần chạy (kiểm tra budget trước khi thực thi)
- Bậc thang test phát hiện vấn đề ở bước <$0.10 trước khi chạy batch Veo $5.60

## Mục tiêu

- M1. Cho `generateSceneImage()` sử dụng `nhan_vat/*.png` làm reference đa phương thức để nhân vật nhất quán.
- M2. Loại bỏ watermark/caption leak bằng negative prompt rõ ràng.
- M3. Kiểm tra chất lượng từng bước trước khi cam kết toàn bộ ngân sách render.
- M4. Giữ phạm vi thay đổi nhỏ — chỉ sửa phần sinh hình ảnh, giữ nguyên Veo/TTS/compose.
- M5. Cung cấp đường rollback qua env flag về Imagen 4.0 Fast hiện tại nếu model mới không đạt yêu cầu.

## Không làm

- Render lại title scene (scene 1) — `scene_01_v4.mp4` hiện tại (15.5s intro) đã ổn và không chứa nhân vật.
- Refactor `characters.md` để khớp trang phục `nhan_vat/*.png` — ảnh reference được inject trực tiếp nên không cần.
- Chuẩn hóa format script tap_01 v1 / tap_02 — ngoài phạm vi; `tap_01_qua_chuoi_bi_an_v2.md` là nguồn chuẩn cho tập 1.
- Xây module quản lý nhân vật mới. YAGNI — `scene-renderer.mjs` + hardcoded reference map là đủ.

## Kiến trúc

Flow tổng thể (giữ nguyên, chỉ swap 1 function):

```
parseEpisode() → validateEpisode() → kiểm tra quota
    ↓
for each scene trong [2..15]:
    renderScene(scene, outputDir)
        ├── generateSceneImage(scene)              ← THAY ĐỔI
        │     ├── loadCharacterReference(charKey)  ← MỚI (có cache)
        │     ├── buildScenePromptWithReference()  ← MỚI
        │     └── gemini-2.5-flash-image qua generateContent({parts: [text, ...refs]})
        ├── generateSceneClip(scene, imagePath)    ← giữ nguyên (Veo 3.1 Lite)
        ├── generateDialogueAudio(scene)           ← giữ nguyên (Gemini TTS + padding cho câu ngắn)
        └── overlayTextOnClip() nếu CTA            ← giữ nguyên
    ↓
composeVideo() → tap_01_final.mp4
```

Scene 1 (title) tiếp tục dùng `title-card-renderer.mjs` với `scene_01_v4.mp4` đã cache — không đổi, bỏ qua khi render.

### Ranh giới thành phần

| Thành phần | Trách nhiệm | Đầu vào | Đầu ra |
|---|---|---|---|
| `loadCharacterReference(charKey)` | Đọc và cache 1 file PNG reference từ `vung/nhan_vat/` | `"momo" \| "tiko" \| "lala" \| "bobo"` | chuỗi base64 (hoặc `null` nếu thiếu) |
| `buildScenePromptWithReference(scene, refChars)` | Tạo prompt đặt style Pixar lên đầu, chỉ rõ reference nào là nhân vật nào, kèm action text | `ParsedScene`, mảng char key có ref | chuỗi prompt |
| `generateSceneImage(scene, outputPath)` | Điều phối load reference + build prompt + gọi API đa phương thức; resumable qua `existsSync` | `ParsedScene`, đường dẫn file | đường dẫn file (ghi vào disk) |
| `generateSceneImageLegacy(scene, outputPath)` | Đường `imagen-4.0-fast-generate-001` hiện tại, giữ làm fallback | giống trên | giống trên |
| Flag `--skip-veo` trong CLI (pipeline.mjs) | Return sau `generateSceneImage()` mà không chạy Veo — cho phép test image rẻ | — | — |

Mỗi unit có thể test riêng biệt: load reference chỉ là IO đĩa, build prompt là logic chuỗi thuần, API call có bề mặt lỗi rõ qua `withKeyRotation`.

## Thiết kế chi tiết

### Hằng số và cache

```js
// vung/src/scene-renderer.mjs (hằng số mới gần đầu file)
const IMAGE_MODEL_WITH_REFS = "gemini-2.5-flash-image";
const IMAGE_MODEL_LEGACY = "imagen-4.0-fast-generate-001";  // hiện tại
const USE_REFERENCE_IMAGES = process.env.VUNG_USE_REFS !== "0";  // mặc định BẬT

const REFERENCE_DIR = "D:/tiktok/vung/nhan_vat";
const REFERENCE_MAP = {
  momo: "momo.png",    // đã xác minh Pixar 3D canonical
  tiko: "Tiko.png",
  lala: "Lala.png",
  bobo: "Bobo.png",
};

const _referenceCache = new Map();  // charKey → base64 (load 1 lần mỗi run)
```

### Bộ tải reference

```js
function loadCharacterReference(charKey) {
  if (_referenceCache.has(charKey)) return _referenceCache.get(charKey);
  const filename = REFERENCE_MAP[charKey];
  if (!filename) {
    _referenceCache.set(charKey, null);
    return null;
  }
  const path = `${REFERENCE_DIR}/${filename}`;
  if (!existsSync(path)) {
    console.log(`[Render] ⚠ Thiếu reference PNG cho ${charKey}: ${path}`);
    _referenceCache.set(charKey, null);
    return null;
  }
  const base64 = readFileSync(path).toString("base64");
  _referenceCache.set(charKey, base64);
  return base64;
}
```

### Bộ tạo prompt

```js
function buildScenePromptWithReference(scene, refChars) {
  const action = dedupeActionText(
    scene.visualDescription || scene.goal || "",
    scene.characters
  );

  const header =
    "Generate a single cinematic still frame for a cute 3D Pixar cartoon animated short. " +
    "Anthropomorphic animal characters only, no humans in the scene. " +
    "9:16 vertical aspect ratio, vibrant magical forest environment, soft cinematic lighting.";

  const referenceCallout = refChars.length > 0
    ? "Keep character appearance IDENTICAL to the provided reference images. " +
      refChars.map((c, i) => `Reference image ${i + 1} is ${c.charAt(0).toUpperCase() + c.slice(1)}`).join(". ") + "."
    : "";

  const uniquenessConstraint = scene.characters.length > 0
    ? scene.characters
        .map(c => `ONLY ONE ${c.charAt(0).toUpperCase() + c.slice(1)}`)
        .join(", ") + " in the scene"
    : "";

  const negative =
    "Avoid: humans, people, human hands, human faces, photorealism, real animals, " +
    "dogs, cats, horses, duplicate characters, multiple instances of the same character, " +
    "watermarks, logos, text, captions, subtitles, Pixar watermark, TikTok caption, " +
    "Vietnamese text overlay, stock footage artifacts";

  return [
    header,
    referenceCallout,
    `Scene action: ${action}`,
    uniquenessConstraint,
    "NO TEXT, NO LETTERS, NO WRITING, NO CAPTIONS, NO WATERMARKS in the image",
    negative,
  ].filter(Boolean).join(" ");
}
```

### Bộ sinh hình ảnh mới

```js
async function generateSceneImageWithRefs(scene, outputPath) {
  if (existsSync(outputPath) && statSync(outputPath).size > 1000) {
    console.log(`[Render] Scene ${scene.id} hình đã có, bỏ qua`);
    return outputPath;
  }
  ensureDir(outputPath);

  const refParts = [];
  const refChars = [];
  for (const charKey of scene.characters) {
    if (charKey === "narrator") continue;
    const base64 = loadCharacterReference(charKey);
    if (base64) {
      refParts.push({ inlineData: { data: base64, mimeType: "image/png" } });
      refChars.push(charKey);
    }
  }

  const prompt = buildScenePromptWithReference(scene, refChars);
  console.log(
    `[Render] Scene ${scene.id} → Gemini Image (${refParts.length} refs): ` +
    `"${prompt.slice(0, 80)}..."`
  );

  const buffer = await withKeyRotation("imagen", async (client) => {
    const res = await client.models.generateContent({
      model: IMAGE_MODEL_WITH_REFS,
      contents: [{
        role: "user",
        parts: [{ text: prompt }, ...refParts],
      }],
      config: { responseModalities: ["IMAGE"] },
    });
    const part = res.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!part?.inlineData?.data) throw new Error("Image model returned no image");
    return Buffer.from(part.inlineData.data, "base64");
  });

  writeFileSync(outputPath, buffer);
  console.log(`[Render] Scene ${scene.id} hình đã lưu: ${(buffer.length / 1024).toFixed(0)}KB`);
  return outputPath;
}

// Feature-flag dispatcher thay thế call site generateSceneImage hiện tại
async function generateSceneImage(scene, outputPath) {
  if (USE_REFERENCE_IMAGES) return generateSceneImageWithRefs(scene, outputPath);
  return generateSceneImageLegacy(scene, outputPath);
}
```

`generateSceneImageLegacy` là function hiện tại được đổi tên — không thay đổi hành vi.

### Thêm flag CLI cho pipeline

```js
// vung/src/pipeline.mjs
const skipVeo = flag("--skip-veo");  // MỚI
// ...
const result = await renderScene(scene, outputDir, { skipVeo });
```

```js
// vung/src/scene-renderer.mjs
export async function renderScene(scene, outputDir, opts = {}) {
  // ... bước image hiện tại
  if (opts.skipVeo) {
    return { imagePath, clipPath: null, dialogue: [] };
  }
  // ... bước veo + tts + overlay hiện tại
}
```

`composer.mjs` đã tolerate clip bị thiếu qua validation — nhưng ta chỉ dùng `--skip-veo` với `--skip-compose`, nên không bao giờ tới compose.

### Dọn dead code

- Xóa `intro-config.OUTRO_SUBSHOTS` (không được reference, mâu thuẫn với rule "bám sát kịch bản").
- Xóa nhánh `composer.includeDialogue` (đã disabled mặc định, dead branch trong `composeVideo()`).

### Backup trước khi test

Trước khi chạy test nào, move `scene_{02..15}.{png,mp4}` và `tap_01_final.mp4` hiện tại vào `vung/output/tap_01/backup_20260411_before_references/`. Thư mục `backup_20260411_before_rerender/` cũ giữ nguyên. Không xóa gì.

## Chiến lược test (cổng kiểm soát quan trọng)

4 test chạy theo thứ tự. Mỗi test có tiêu chí đạt/không đạt rõ ràng. Không chạy test sau nếu test trước chưa đạt.

### Test 1 — Kiểm tra model có sẵn (~$0 chi phí)

Script: `vung/src/test-gemini-image.mjs`

```bash
node vung/src/test-gemini-image.mjs
```

Gửi 1 prompt text đơn giản ("a cute cartoon bear in a forest, pixar style") tới `gemini-2.5-flash-image` qua key pool hiện có. Lưu kết quả ra `vung/output/_test/smoke.png`.

**Đạt:** file PNG tồn tại, size > 10KB, không lỗi API.
**Hành động khi không đạt:** Kiểm tra model cần endpoint hoặc key tier khác. Nếu `gemini-2.5-flash-image` không truy cập được, thử `gemini-2.5-flash` với `responseModalities: ["IMAGE"]` hoặc fallback sang `gemini-3.1-flash-image-preview`.

### Test 2 — Inject reference 1 nhân vật (~$0.04 chi phí)

```bash
rm vung/output/tap_01/scene_02.png vung/output/tap_01/scene_02.mp4
node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 2 \
  --skip-veo \
  --skip-compose
```

Scene 2 chỉ có Momo — trường hợp đơn giản nhất. Kiểm tra reference injection cho 1 nhân vật.

**Tiêu chí đạt (kiểm tra visual bằng mắt — user quyết định cuối cùng nếu không chắc):**
- Hình là Pixar 3D cartoon (không realistic, không người, không chó)
- Khỉ trông giống `nhan_vat/momo.png`: cùng màu lông (nâu sáng), cùng hình dạng đuôi (dài + cong), cùng tỷ lệ đầu/thân, cùng kiểu mắt
- Không watermark, không caption, không logo Pixar, không UI TikTok
- Size ≥ 500KB (chứng tỏ nội dung thật, không placeholder)

**Hành động khi không đạt:** Chỉnh prompt — thử đặt ảnh reference TRƯỚC text, điều chỉnh reference callout, thêm "match the provided character" rõ ràng hơn. Chi phí mỗi lần retry: $0.04.

### Test 3 — Inject reference nhiều nhân vật (~$0.04 chi phí)

```bash
rm vung/output/tap_01/scene_10.png
node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 10 \
  --skip-veo \
  --skip-compose
```

Scene 10 có đủ 4 nhân vật — trường hợp khó nhất. Kiểm tra reference injection có scale với prompt đa nhân vật hay không.

**Tiêu chí đạt:**
- Đúng 1 Momo, 1 Tiko, 1 Lala, 1 Bobo — không trùng lặp
- Mỗi nhân vật khớp với PNG reference tương ứng
- Hành động scene nhận diện được (nhóm nhìn vào ụ đất)

**Hành động khi không đạt:** Nếu trùng lặp, thêm negative mạnh hơn; nếu nhân vật bị lẫn (thân Momo gắn đầu Tiko), đơn giản hóa prompt.

### Test 4 — Nhất quán nhân vật xuyên scene (~$0.12 chi phí)

```bash
for n in 02 05 10; do rm vung/output/tap_01/scene_${n}.png; done
node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 2,5,10 \
  --skip-veo \
  --skip-compose
```

Ba scene đều chứa Momo. Kiểm tra 3 bản Momo trông như **cùng 1 nhân vật**.

**Tiêu chí đạt:**
- Cả ba Momo có cùng màu lông, hình đuôi, cỡ mắt, tỷ lệ cơ thể
- Khác biệt chỉ ở tư thế và biểu cảm (theo câu chuyện), không phải thiết kế

**Hành động khi không đạt:** Nếu Momo vẫn khác nhau, model không tôn trọng reference đủ mạnh — có thể cần chuyển sang Phương án B (sinh canonical scene trước) làm fallback.

### Test 5 — Render toàn bộ (~$6 chi phí)

Chỉ chạy khi Test 1-4 đều đạt.

```bash
node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 2-15 \
  --skip-compose
node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --skip-render
```

**Tiêu chí đạt:**
- `tap_01_final.mp4` được tạo
- `ffprobe` duration ≈ 121.9s (±1s)
- `ffmpeg volumedetect` max_volume ≥ -5 dB
- Kiểm tra mắt 5 frame (mỗi 24s) thấy nhân vật nhất quán + không watermark

Nếu Test 5 fail sau render, assets đã backup nên lần chạy thứ 2 tốn thêm $6 — mức budget chấp nhận được cho 1 lần retry.

## Chiến lược xử lý lỗi

`withKeyRotation` hiện tại xử lý 3 loại lỗi (exhausted, access denied, transient). Giữ nguyên. Thêm 2 điểm:

1. **Pattern lỗi transient mới.** `gemini-2.5-flash-image` có thể trả lỗi kiểu "image model returned no image" khi model từ chối sinh (content policy). Xử lý như transient — retry 1 lần với key khác, nếu lặp lại thì throw. Check `isTransientApiError` hiện có đã cover `"returned no image"`.

2. **Fallback khi hết quota.** Nếu tất cả key đều hết quota cho model image mới trong ngày, tự động fallback về `generateSceneImageLegacy` thay vì fail cả tập. Log rõ ràng để user biết fallback đã xảy ra.

```js
async function generateSceneImage(scene, outputPath) {
  if (!USE_REFERENCE_IMAGES) return generateSceneImageLegacy(scene, outputPath);
  try {
    return await generateSceneImageWithRefs(scene, outputPath);
  } catch (err) {
    if (err.message?.includes("All keys exhausted")) {
      console.log("[Render] ⚠ Model reference hết quota, fallback sang Imagen legacy");
      return generateSceneImageLegacy(scene, outputPath);
    }
    throw err;
  }
}
```

## Rủi ro và giảm thiểu

| Rủi ro | Khả năng | Tác động | Giảm thiểu |
|---|---|---|---|
| `gemini-2.5-flash-image` không khả dụng trên key tier hiện tại | Trung bình | Cao — phương án bị chặn | Test 1 phát hiện ở $0 chi phí; fallback sang `gemini-3.1-flash-image-preview` hoặc legacy |
| Model không bám reference đủ mạnh | Trung bình | Cao — nhân vật vẫn không nhất quán | Test 4 phát hiện; chuyển sang Phương án B (sinh canonical scene trước) |
| Inject reference làm chậm sinh hình (4 PNG mỗi request) | Thấp | Trung bình — pipeline chậm hơn | Cache reference trong bộ nhớ; chấp nhận chậm hơn wall-clock time |
| Model mới có quota khác Imagen 4 | Trung bình | Trung bình — bất ngờ về budget | Kiểm tra quota trong output Test 1; điều chỉnh `DAILY_QUOTAS.imagen` nếu cần |
| Payload base64 quá lớn cho API request | Thấp | Trung bình — API từ chối | Nén PNG xuống < 500KB mỗi file nếu cần (hiện đang dưới 1MB) |
| Đường fallback bị bitrot | Trung bình | Thấp — chỉ kích hoạt khi hết quota | Thêm 1 integration test chạy với `VUNG_USE_REFS=0` mỗi release |

## Bước 0: Render canonical character sheets

### Vấn đề với nhan_vat/ hiện tại

Thư mục `vung/nhan_vat/` chứa ảnh hỗn hợp từ nhiều nguồn:
- `momo.png` — Pixar 3D, white background, full body ✓ (nhưng style "naked monkey", không có chi tiết nhất quán)
- `Tiko.png` — Pixar 3D, đẹp ✓ (rùa đeo kính đỏ)
- `Lala.png` — Pixar 3D ✓ (cáo mặc áo + quần jean)
- `Bobo.png` — Pixar 3D ✓ (gấu mặc áo polo xanh + quần jean)
- `nhanvat_momo01/02/03.png` — 2D cartoon từ pngtree, có watermark, style khác hẳn
- `lala.jpg`, `bobo.jpg` — style anime/illustrator, không Pixar
- `boi_canh01/03/04.jpg` — background references

**Vấn đề**: 4 file canonical PNG hiện có (`momo.png`, `Tiko.png`, `Lala.png`, `Bobo.png`) style KHÔNG thống nhất — Momo là naked monkey trong khi Lala+Bobo mặc quần áo. Nếu inject cả 4 vào scene, Imagen sẽ thấy 2 style khác nhau → kết quả không nhất quán.

### Giải pháp: render 4 canonical character sheets mới

Dùng Gemini 2.5 Flash Image (hoặc Imagen 4.0 Fast) để sinh **4 ảnh nhân vật chuẩn mới**, cùng 1 style, white background, full body, 9:16. Prompt dựa trên `characters.md` + bổ sung chi tiết trang phục từ `nhan_vat/*.png` hiện có.

**Mỗi character sheet cần thỏa mãn:**
- Pixar 3D cartoon style nhất quán 4 ảnh
- Full body pose (đứng thẳng hoặc pose đặc trưng)
- White/transparent background (để Imagen dễ tách subject khi inject vào scene)
- Chi tiết species rõ ràng (khỉ/rùa/cáo/gấu)
- Chi tiết trang phục nếu có (Lala áo + quần, Bobo áo polo + quần)
- Không watermark, không text

**Prompt template cho mỗi nhân vật:**
```
A full-body character design sheet of [CHARACTER DESCRIPTION from characters.md].
Standing pose, white background, Pixar 3D cartoon style.
Cute, expressive, vibrant colors, high detail, consistent design.
9:16 vertical aspect ratio.
NO TEXT, NO LETTERS, NO WATERMARKS.
```

**Flow:**
1. Sinh 4 ảnh, mỗi nhân vật 1 ảnh (~$0.16 cho 4 ảnh)
2. User visual audit: mỗi ảnh có đúng nhân vật, đúng style, đúng chi tiết không?
3. Nếu ảnh nào không đạt, retry riêng ảnh đó (~$0.04/retry)
4. Khi 4 ảnh đều đạt → lưu vào `vung/nhan_vat/canonical/` (thư mục mới, tách khỏi ảnh cũ)
5. Cập nhật `REFERENCE_MAP` trỏ tới `canonical/momo.png`, `canonical/tiko.png`...
6. Ảnh cũ trong `vung/nhan_vat/` giữ nguyên (không xóa — chỉ dùng thư mục canonical/ cho pipeline)

**Đây là bước chỉ cần làm 1 LẦN** — 4 canonical sheets này sẽ được dùng cho TẤT CẢ các tập (tập 1, 2, 3...), không cần render lại. Đầu tư ~$0.20 một lần, tiết kiệm consistency cho toàn bộ series.

### Cập nhật REFERENCE_MAP

```js
const REFERENCE_DIR = "D:/tiktok/vung/nhan_vat/canonical";
const REFERENCE_MAP = {
  momo: "momo.png",
  tiko: "tiko.png",
  lala: "lala.png",
  bobo: "bobo.png",
};
```

## Thứ tự triển khai

1. **Render canonical character sheets** (Bước 0): sinh 4 ảnh nhân vật chuẩn → `vung/nhan_vat/canonical/` → user duyệt từng ảnh.
2. Tạo `vung/output/tap_01/backup_20260411_before_references/`, move scene 2-15 PNG/MP4 và `tap_01_final.mp4` hiện tại vào đó.
3. Viết `vung/src/test-gemini-image.mjs` smoke test; chạy Test 1; xác nhận model + key pool hoạt động.
3. Thêm `USE_REFERENCE_IMAGES`, `REFERENCE_MAP`, `_referenceCache`, `loadCharacterReference`, `buildScenePromptWithReference`, `generateSceneImageWithRefs` vào `scene-renderer.mjs`.
4. Đổi tên `generateSceneImage` hiện tại thành `generateSceneImageLegacy`; thêm dispatcher với fallback.
5. Thêm flag `--skip-veo` vào `pipeline.mjs` và truyền qua `renderScene()` options. Đảm bảo nhánh `--skip-render` hiện tại vẫn resolve đường dẫn scene đúng khi `--skip-veo` đã được dùng ở lần chạy trước (sẽ không có clip file cho scene chỉ-image).
6. Xóa `OUTRO_SUBSHOTS` khỏi `intro-config.mjs` và nhánh `composeVideo.includeDialogue` khỏi `composer.mjs`.
7. Chạy Test 2 (scene 2). Chỉnh prompt nếu cần.
8. Chạy Test 3 (scene 10). Chỉnh prompt nếu cần.
9. Chạy Test 4 (scenes 2, 5, 10). Nếu consistency fail, DỪNG và báo user.
10. Chạy Test 5 (render toàn bộ). Tạo `tap_01_final.mp4` cuối cùng.
11. Commit thay đổi thành 1 commit tập trung.

## Câu hỏi mở

Không có — brainstorming đã giải quyết ưu tiên, tiêu chuẩn chất lượng (100% hoàn hảo), phương pháp consistency (inject PNG qua Gemini 2.5 Flash Image), và chính sách tái sử dụng asset (giữ scene 1 + voice files).

## Tiêu chí nghiệm thu

- `tap_01_final.mp4` được render với pipeline mới
- Tất cả 14 scene truyện hiển thị nhân vật khớp character sheet `nhan_vat/*.png`
- Kiểm tra mắt 5 frame mẫu: không watermark, không trùng lặp nhân vật, không hình người/chó
- `ffprobe` xác nhận duration ≈ 121.9s, 1080x1920, h264 + aac
- `ffmpeg volumedetect` xác nhận max_volume ≥ -5 dB
- Tổng chi phí ≤ $7 cho toàn bộ tests và lần chạy cuối
- Đường rollback (`VUNG_USE_REFS=0`) xác nhận vẫn tạo được tập hợp lệ
