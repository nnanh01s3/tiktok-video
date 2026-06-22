# Rừng Xì Tin — Reference Image Scene Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho pipeline `vung/src/` sinh hình ảnh scene với character reference images từ `vung/nhan_vat/canonical/`, đảm bảo nhân vật nhất quán xuyên suốt 14 scene của tập 1.

**Architecture:** Swap duy nhất `generateSceneImage()` trong `scene-renderer.mjs` sang dùng `gemini-2.5-flash-image` multi-modal (text prompt + 1-4 character PNG references). Giữ nguyên Veo / TTS / compose. Feature flag `VUNG_USE_REFS` cho rollback. Bước 0 render 4 canonical character sheet mới thống nhất style.

**Tech Stack:** Node.js ESM, `@google/genai` SDK (đã cài), Gemini 2.5 Flash Image, FFmpeg (đã có)

**Spec:** `docs/superpowers/specs/2026-04-11-rung-xi-tin-reference-images-design.md`

---

## File Structure

| File | Hành động | Trách nhiệm |
|---|---|---|
| `vung/src/scene-renderer.mjs` | **Sửa** | Thêm reference loader + prompt builder mới + image generator mới + feature flag dispatcher |
| `vung/src/pipeline.mjs` | **Sửa** | Thêm `--skip-veo` flag + truyền qua `renderScene()` |
| `vung/src/intro-config.mjs` | **Sửa** | Xóa `OUTRO_SUBSHOTS` dead code |
| `vung/src/composer.mjs` | **Sửa** | Xóa `includeDialogue` dead branch |
| `vung/src/gen-character-sheets.mjs` | **Tạo mới** | Script 1 lần sinh 4 canonical character PNGs |
| `vung/src/test-gemini-image.mjs` | **Tạo mới** | Smoke test model availability |
| `vung/nhan_vat/canonical/` | **Tạo mới** | 4 canonical character PNGs (output bước 0) |

---

### Task 1: Backup assets hiện tại

**Files:**
- Thao tác: `vung/output/tap_01/` → move files

- [ ] **Step 1: Tạo backup folder và move scene 2-15 + final video**

```bash
BACKUP="D:/tiktok/vung/output/tap_01/backup_20260412_before_references"
mkdir -p "$BACKUP"
cd D:/tiktok/vung/output/tap_01

# Move scene 2-15 canonical PNG + MP4 (giữ _v1 files)
for n in 02 03 04 05 06 07 08 09 10 11 12 13 14 15; do
  [ -f "scene_${n}.png" ] && mv "scene_${n}.png" "$BACKUP/"
  [ -f "scene_${n}.mp4" ] && mv "scene_${n}.mp4" "$BACKUP/"
done

# Move overlay + final
[ -f "scene_15_overlay.mp4" ] && mv "scene_15_overlay.mp4" "$BACKUP/"
[ -f "tap_01_final.mp4" ] && mv "tap_01_final.mp4" "$BACKUP/"

echo "Backed up $(ls "$BACKUP" | wc -l) files"
```

Kỳ vọng: ~30 files moved. Scene 01 v4 files + _v1 files + voice files KHÔNG bị di chuyển.

- [ ] **Step 2: Xác nhận scene 01 v4 vẫn nguyên**

```bash
ls -la D:/tiktok/vung/output/tap_01/scene_01_v4.mp4
```

Kỳ vọng: file ~15MB vẫn tồn tại.

---

### Task 2: Render canonical character sheets (Bước 0)

**Files:**
- Tạo: `vung/src/gen-character-sheets.mjs`
- Tạo: `vung/nhan_vat/canonical/` (4 PNG outputs)

- [ ] **Step 1: Viết script sinh character sheets**

Tạo `vung/src/gen-character-sheets.mjs`:

```js
/**
 * One-time script: generate 4 canonical Pixar 3D character sheets.
 * Output: vung/nhan_vat/canonical/{momo,tiko,lala,bobo}.png
 *
 * Usage: node vung/src/gen-character-sheets.mjs
 *        node vung/src/gen-character-sheets.mjs --only momo
 */
import "../../src/env.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { getClient, markKeyExhausted } from "./gemini-keys.js";

const MODEL = "gemini-2.5-flash-image";
const OUTPUT_DIR = "D:/tiktok/vung/nhan_vat/canonical";

const CHARACTER_PROMPTS = {
  momo: {
    name: "Momo",
    prompt: [
      "A full-body character design sheet of Momo, a mischievous monkey character.",
      "Slim body, light brown fur, cream-colored belly and face area.",
      "Big round expressive brown eyes, large rounded ears.",
      "Long curved tail with a slight curl at the tip.",
      "Playful mischievous smile showing teeth.",
      "Standing in a confident energetic pose, arms slightly out.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, dark, aggressive, humans, people.",
    ].join(" "),
  },
  tiko: {
    name: "Tiko",
    prompt: [
      "A full-body character design sheet of Tiko, a wise turtle character.",
      "Green shell with hexagonal pattern, slightly darker green on top.",
      "Wearing round reddish-brown glasses.",
      "Calm gentle expression, small wise smile.",
      "Light green skin, slightly slow posture.",
      "Standing upright in a composed thoughtful pose.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, dark, humans, broken shell.",
    ].join(" "),
  },
  lala: {
    name: "Lala",
    prompt: [
      "A full-body character design sheet of Lala, a stylish female fox character.",
      "Orange fur with white chest, white tail tip, big fluffy tail.",
      "Wearing a turquoise-green button-up blouse and blue denim jeans with a brown belt.",
      "Confident sassy expression, slightly feminine elegant pose.",
      "Big expressive brown eyes with long eyelashes, pointed ears with dark tips.",
      "Standing with one hand on hip.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, dark, aggressive, humans, people.",
    ].join(" "),
  },
  bobo: {
    name: "Bobo",
    prompt: [
      "A full-body character design sheet of Bobo, a chubby friendly bear character.",
      "Brown fur, big round belly with lighter cream belly patch.",
      "Wearing a blue polo shirt with a small yellow logo patch and blue denim shorts.",
      "Round face, small eyes, big black nose, friendly silly grin.",
      "Standing in a slightly clumsy but lovable pose.",
      "White clean background, centered in frame.",
      "Cute 3D Pixar cartoon style, vibrant colors, high detail, smooth texture.",
      "9:16 vertical aspect ratio.",
      "NO TEXT, NO LETTERS, NO WATERMARKS, NO LOGOS.",
      "Negative: realistic, scary, angry, dark, humans, people, dogs.",
    ].join(" "),
  },
};

// CLI: --only momo (optional, defaults to all)
const onlyArg = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const targets = onlyArg
  ? { [onlyArg]: CHARACTER_PROMPTS[onlyArg] }
  : CHARACTER_PROMPTS;

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

async function generateSheet(charKey, { name, prompt }) {
  const outPath = `${OUTPUT_DIR}/${charKey}.png`;
  if (existsSync(outPath)) {
    console.log(`[CharSheet] ${name} đã tồn tại, bỏ qua. Xóa file để render lại.`);
    return;
  }

  console.log(`[CharSheet] Đang sinh ${name}...`);
  console.log(`[CharSheet] Prompt: "${prompt.slice(0, 100)}..."`);

  const maxAttempts = 15;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = getClient("imagen");
    if (!handle) throw new Error("Hết key cho imagen");
    try {
      const res = await handle.client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseModalities: ["IMAGE"] },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part?.inlineData?.data) {
        throw new Error("Model trả về không có hình");
      }
      const buffer = Buffer.from(part.inlineData.data, "base64");
      writeFileSync(outPath, buffer);
      console.log(`[CharSheet] ✅ ${name} saved: ${outPath} (${(buffer.length / 1024).toFixed(0)}KB)`);
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "").toLowerCase();
      if (err?.status === 429 || msg.includes("quota") || msg.includes("resource_exhausted")) {
        markKeyExhausted(handle.keyId, "imagen");
        console.log(`[CharSheet] Key ${handle.keyId} hết quota, thử key khác...`);
        continue;
      }
      if (msg.includes("returned no") || msg.includes("503") || msg.includes("unavailable")) {
        console.log(`[CharSheet] Lỗi tạm (${msg.slice(0, 60)}), retry...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`Không thể sinh ${name} sau ${maxAttempts} lần`);
}

async function main() {
  console.log(`\n🎨 Sinh canonical character sheets → ${OUTPUT_DIR}\n`);
  for (const [key, config] of Object.entries(targets)) {
    if (!config) {
      console.error(`Nhân vật "${key}" không tồn tại. Có: ${Object.keys(CHARACTER_PROMPTS).join(", ")}`);
      process.exit(1);
    }
    await generateSheet(key, config);
  }
  console.log("\n✅ Xong! Hãy kiểm tra mắt 4 ảnh trong vung/nhan_vat/canonical/ trước khi tiếp.");
}

main().catch((err) => {
  console.error("❌ Lỗi:", err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Chạy script sinh character sheets**

```bash
cd D:/tiktok && node vung/src/gen-character-sheets.mjs
```

Kỳ vọng: 4 file PNG trong `vung/nhan_vat/canonical/`: `momo.png`, `tiko.png`, `lala.png`, `bobo.png`. Mỗi file > 500KB.

- [ ] **Step 3: User kiểm tra mắt 4 ảnh**

Mở từng file, so sánh với mô tả `characters.md`:
- `momo.png`: Pixar 3D, khỉ nâu sáng, tai tròn, đuôi dài cong, mắt to, nền trắng
- `tiko.png`: Pixar 3D, rùa xanh đeo kính đỏ, vỏ hex, nền trắng
- `lala.png`: Pixar 3D, cáo cam mặc áo xanh + quần jean + thắt lưng, đuôi xù, nền trắng
- `bobo.png`: Pixar 3D, gấu mập mặc áo polo xanh + quần jean, nền trắng

Nếu ảnh nào không đạt, xóa file đó rồi retry riêng:

```bash
rm D:/tiktok/vung/nhan_vat/canonical/momo.png
node vung/src/gen-character-sheets.mjs --only momo
```

**GATE: Chỉ tiếp Task 3 khi cả 4 ảnh đều được user approve.**

- [ ] **Step 4: Commit character sheets**

```bash
cd D:/tiktok
git add vung/nhan_vat/canonical/ vung/src/gen-character-sheets.mjs
git commit -m "feat(vung): generate canonical character sheets for reference injection

4 Pixar 3D character sheets (momo, tiko, lala, bobo) in consistent style
with white background, stored in vung/nhan_vat/canonical/.
Script vung/src/gen-character-sheets.mjs for one-time generation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Smoke test model availability (Test 1)

**Files:**
- Tạo: `vung/src/test-gemini-image.mjs`

- [ ] **Step 1: Viết smoke test script**

Tạo `vung/src/test-gemini-image.mjs`:

```js
/**
 * Smoke test: verify gemini-2.5-flash-image accessible qua key pool.
 * Usage: node vung/src/test-gemini-image.mjs
 */
import "../../src/env.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { getClient } from "./gemini-keys.js";

const MODEL = "gemini-2.5-flash-image";
const OUTPUT_DIR = "D:/tiktok/vung/output/_test";
const OUTPUT_PATH = `${OUTPUT_DIR}/smoke.png`;

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

async function main() {
  console.log(`[Test] Kiểm tra model ${MODEL} qua key pool...`);
  const handle = getClient("imagen");
  if (!handle) {
    console.error("[Test] ❌ Không có key nào khả dụng cho imagen");
    process.exit(1);
  }

  try {
    const res = await handle.client.models.generateContent({
      model: MODEL,
      contents: [{
        role: "user",
        parts: [{ text: "A cute cartoon bear in a forest, pixar 3D style, vibrant colors, 9:16 vertical. NO TEXT." }],
      }],
      config: { responseModalities: ["IMAGE"] },
    });

    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData?.data) {
      console.error("[Test] ❌ Model trả về không có hình ảnh");
      process.exit(1);
    }

    const buffer = Buffer.from(part.inlineData.data, "base64");
    writeFileSync(OUTPUT_PATH, buffer);
    console.log(`[Test] ✅ Thành công! ${OUTPUT_PATH} (${(buffer.length / 1024).toFixed(0)}KB)`);
    console.log(`[Test] Key dùng: ${handle.keyId}`);
  } catch (err) {
    console.error(`[Test] ❌ API lỗi: ${err.message}`);
    console.error("[Test] Thử đổi model sang gemini-2.5-flash hoặc gemini-3.1-flash-image-preview");
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Chạy smoke test**

```bash
cd D:/tiktok && node vung/src/test-gemini-image.mjs
```

Kỳ vọng: `✅ Thành công!`, file `vung/output/_test/smoke.png` > 10KB.

Nếu lỗi "model not found", sửa `MODEL` trong test script thành `"gemini-2.5-flash"` hoặc `"gemini-3.1-flash-image-preview"` rồi retry. Cần nhớ model nào work để dùng ở Task 4.

**GATE: Test 1 phải pass trước khi tiếp.**

---

### Task 4: Thêm reference image generation vào scene-renderer.mjs

**Files:**
- Sửa: `vung/src/scene-renderer.mjs` (phần constants, thêm functions mới, đổi tên function cũ)

- [ ] **Step 1: Thêm constants và cache vào đầu file**

Trong `vung/src/scene-renderer.mjs`, sau dòng `const TTS_MODEL = "gemini-2.5-flash-preview-tts";` (dòng 27), thêm:

```js
// ── Reference image generation (Phương án A) ──────────────────────────
// Dùng gemini-2.5-flash-image multi-modal thay vì text-only Imagen 4.0
// để inject character reference PNGs → nhân vật nhất quán xuyên scene.
// Rollback: set VUNG_USE_REFS=0 trong env để dùng legacy Imagen.
const IMAGE_MODEL_WITH_REFS = "gemini-2.5-flash-image";
const IMAGE_MODEL_LEGACY = IMAGEN_MODEL;
const USE_REFERENCE_IMAGES = process.env.VUNG_USE_REFS !== "0";

const REFERENCE_DIR = "D:/tiktok/vung/nhan_vat/canonical";
const REFERENCE_MAP = {
  momo: "momo.png",
  tiko: "tiko.png",
  lala: "lala.png",
  bobo: "bobo.png",
};

const _referenceCache = new Map();
```

- [ ] **Step 2: Thêm loadCharacterReference**

Ngay sau block constants vừa thêm:

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
  console.log(`[Render] Loaded reference ${charKey}: ${(base64.length * 0.75 / 1024).toFixed(0)}KB`);
  return base64;
}
```

- [ ] **Step 3: Thêm buildScenePromptWithReference**

Ngay sau `loadCharacterReference`:

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
      refChars.map((c, i) =>
        `Reference image ${i + 1} is ${c.charAt(0).toUpperCase() + c.slice(1)}`
      ).join(". ") + "."
    : "";

  const uniquenessConstraint = scene.characters.length > 0
    ? scene.characters
        .map((c) => `ONLY ONE ${c.charAt(0).toUpperCase() + c.slice(1)}`)
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

- [ ] **Step 4: Thêm generateSceneImageWithRefs**

Ngay sau `buildScenePromptWithReference`:

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
    `"${prompt.slice(0, 100)}..."`
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
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData?.data) throw new Error("Image model returned no image");
    return Buffer.from(part.inlineData.data, "base64");
  });

  writeFileSync(outputPath, buffer);
  console.log(`[Render] Scene ${scene.id} hình đã lưu: ${(buffer.length / 1024).toFixed(0)}KB`);
  return outputPath;
}
```

- [ ] **Step 5: Đổi tên generateSceneImage hiện tại → generateSceneImageLegacy, thêm dispatcher**

Tìm function `generateSceneImage` hiện có (bắt đầu bằng `async function generateSceneImage(scene, outputPath)`). Đổi tên thành `generateSceneImageLegacy`. Thêm dispatcher mới:

```js
async function generateSceneImageLegacy(scene, outputPath) {
  // ... giữ nguyên nội dung cũ của generateSceneImage ...
}

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

- [ ] **Step 6: Commit thay đổi scene-renderer.mjs**

```bash
cd D:/tiktok
git add vung/src/scene-renderer.mjs vung/src/test-gemini-image.mjs
git commit -m "feat(vung): add reference image injection to scene-renderer

- loadCharacterReference(): cache + load canonical PNGs from vung/nhan_vat/canonical/
- buildScenePromptWithReference(): front-load Pixar style + reference callout + anti-watermark negatives
- generateSceneImageWithRefs(): multi-modal API call with text + reference images
- Feature flag VUNG_USE_REFS (default ON), fallback to legacy Imagen on quota exhaust
- Legacy path preserved as generateSceneImageLegacy()

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Thêm --skip-veo flag vào pipeline

**Files:**
- Sửa: `vung/src/pipeline.mjs` (1 dòng CLI + 1 dòng truyền options)
- Sửa: `vung/src/scene-renderer.mjs` (thêm `opts` parameter cho `renderScene`)

- [ ] **Step 1: Thêm flag vào pipeline.mjs**

Trong `vung/src/pipeline.mjs`, sau dòng `const onlyScenes = arg("--only-scenes");` (dòng 41), thêm:

```js
const skipVeo = flag("--skip-veo");
```

Và update usage string (dòng 46-51) thêm:

```js
"  --skip-veo        Skip Veo video generation (image-only, for testing)\n" +
```

- [ ] **Step 2: Truyền skipVeo qua renderScene**

Trong `vung/src/pipeline.mjs`, tìm dòng `const result = await renderScene(scene, outputDir);` (dòng 153). Đổi thành:

```js
const result = await renderScene(scene, outputDir, { skipVeo });
```

- [ ] **Step 3: Nhận opts trong renderScene**

Trong `vung/src/scene-renderer.mjs`, tìm `export async function renderScene(scene, outputDir)` (dòng 632). Đổi signature thành:

```js
export async function renderScene(scene, outputDir, opts = {}) {
```

Sau bước Imagen (dòng 649 `await generateSceneImage(scene, imagePath);`), thêm:

```js
  if (opts.skipVeo) {
    console.log(`[Render] Scene ${scene.id} --skip-veo: chỉ sinh hình, bỏ qua Veo + TTS`);
    return { imagePath, clipPath: null, dialogue: [] };
  }
```

- [ ] **Step 4: Commit**

```bash
cd D:/tiktok
git add vung/src/pipeline.mjs vung/src/scene-renderer.mjs
git commit -m "feat(vung): add --skip-veo flag for image-only testing

Enables cheap scene image testing without burning Veo quota.
renderScene() now accepts opts.skipVeo, returns early after image step.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Dọn dead code

**Files:**
- Sửa: `vung/src/intro-config.mjs` (xóa `OUTRO_SUBSHOTS` + update `getSubShotsForTitleScene`)
- Sửa: `vung/src/composer.mjs` (xóa `includeDialogue` branch)

- [ ] **Step 1: Xóa OUTRO_SUBSHOTS khỏi intro-config.mjs**

Trong `vung/src/intro-config.mjs`:

1. Xóa toàn bộ block `export const OUTRO_SUBSHOTS = [...]` (dòng 136-155).
2. Trong `getSubShotsForTitleScene` (dòng 163-168), xóa dòng `if (scene.isLastScene) return OUTRO_SUBSHOTS;`. Giữ fallback:

```js
export function getSubShotsForTitleScene(scene) {
  if (scene.isFirstScene) return INTRO_SUBSHOTS;
  return INTRO_SUBSHOTS.slice(0, 1);
}
```

- [ ] **Step 2: Xóa includeDialogue branch khỏi composer.mjs**

Trong `vung/src/composer.mjs`:

1. Xóa `includeDialogue` khỏi options destructuring (dòng 191):

```js
// Trước:
const { bgMusic, musicVolume = 0.15, xfadeDur = DEFAULT_XFADE, includeDialogue = false } = options;
// Sau:
const { bgMusic, musicVolume = 0.15, xfadeDur = DEFAULT_XFADE } = options;
```

2. Xóa khối `if (includeDialogue)` (dòng 255-265).

3. Xóa `const dialogueCount = includeDialogue ? dialogueTiming.length : 0;` (dòng 213), thay bằng:

```js
const dialogueCount = 0;
```

4. Xóa constants `DIALOGUE_HEAD` và `DIALOGUE_TAIL` (dòng 38-39).

5. Xóa function `planDialogueTimingWithXfade` hoàn toàn (dòng 71-101) — không còn caller.

6. Cập nhật dòng compute `dialogueTiming`:

```js
// Trước:
const { timed: dialogueTiming, totalDuration } = planDialogueTimingWithXfade(rendered, xfadeDur);
// Sau (compute totalDuration trực tiếp):
let totalDuration = 0;
for (let i = 0; i < rendered.length; i++) {
  totalDuration += rendered[i].clipDur;
  if (i < rendered.length - 1) totalDuration -= xfadeDur;
}
```

- [ ] **Step 3: Commit**

```bash
cd D:/tiktok
git add vung/src/intro-config.mjs vung/src/composer.mjs
git commit -m "chore(vung): remove dead code (OUTRO_SUBSHOTS + includeDialogue)

- OUTRO_SUBSHOTS never referenced, contradicts 'bám sát kịch bản' rule
- includeDialogue was permanently disabled (native Veo audio preferred)
- planDialogueTimingWithXfade removed (no callers)
- totalDuration now computed inline

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Test 2 — Single-character reference (scene 2, Momo solo)

**Files:**
- Thao tác: chạy pipeline với `--only-scenes 2 --skip-veo --skip-compose`

- [ ] **Step 1: Xóa scene_02.png nếu còn sót**

```bash
rm -f D:/tiktok/vung/output/tap_01/scene_02.png
```

- [ ] **Step 2: Chạy pipeline chỉ scene 2, chỉ image**

```bash
cd D:/tiktok && node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 2 \
  --skip-veo \
  --skip-compose
```

Kỳ vọng: `scene_02.png` tạo ra, log `Gemini Image (1 refs)`, không lỗi.

- [ ] **Step 3: User kiểm tra scene_02.png**

Mở `vung/output/tap_01/scene_02.png`:
- Pixar 3D cartoon ✓
- Khỉ giống `vung/nhan_vat/canonical/momo.png` (cùng style, cùng proportions) ✓
- Không watermark, không caption ✓
- Size > 500KB ✓

**GATE: Nếu không đạt → chỉnh prompt trong `buildScenePromptWithReference`, retry Step 2. Chi phí mỗi retry: ~$0.04.**

---

### Task 8: Test 3 — Multi-character reference (scene 10, 4 nhân vật)

- [ ] **Step 1: Xóa scene_10.png**

```bash
rm -f D:/tiktok/vung/output/tap_01/scene_10.png
```

- [ ] **Step 2: Chạy pipeline scene 10**

```bash
cd D:/tiktok && node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 10 \
  --skip-veo \
  --skip-compose
```

Kỳ vọng: `scene_10.png` với 4 nhân vật, mỗi con 1, đúng reference.

- [ ] **Step 3: User kiểm tra scene_10.png**

- Đúng 1 Momo, 1 Tiko, 1 Lala, 1 Bobo — không duplicate ✓
- Mỗi nhân vật khớp canonical sheet ✓
- Hành động scene nhận diện được ✓

**GATE: Nếu duplicate hoặc sai nhân vật → chỉnh prompt, retry.**

---

### Task 9: Test 4 — Cross-scene consistency (scenes 2, 5, 10)

- [ ] **Step 1: Xóa 3 scene images**

```bash
rm -f D:/tiktok/vung/output/tap_01/scene_{02,05,10}.png
```

- [ ] **Step 2: Chạy pipeline 3 scene**

```bash
cd D:/tiktok && node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 2,5,10 \
  --skip-veo \
  --skip-compose
```

- [ ] **Step 3: So sánh 3 bản Momo xuyên scene**

Mở cả 3 PNG, so sánh:
- Cùng màu lông ✓
- Cùng hình đuôi ✓
- Cùng tỷ lệ cơ thể ✓
- Khác biệt chỉ ở tư thế/biểu cảm ✓

**GATE: Nếu Momo vẫn khác nhau quá nhiều → DỪNG, báo user, xem xét chuyển sang Phương án B.**

---

### Task 10: Test 5 — Full render (scene 2-15 + compose)

- [ ] **Step 1: Xóa tất cả scene 2-15 images đã test**

```bash
cd D:/tiktok/vung/output/tap_01
for n in 02 03 04 05 06 07 08 09 10 11 12 13 14 15; do
  rm -f "scene_${n}.png" "scene_${n}.mp4"
done
rm -f scene_15_overlay.mp4 tap_01_final.mp4
```

- [ ] **Step 2: Render scene 2-8**

```bash
cd D:/tiktok && node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 2-8 \
  --skip-compose
```

Kỳ vọng: 7 scenes × (image + Veo clip + TTS), khoảng 10-15 phút.

- [ ] **Step 3: Render scene 9-15**

```bash
cd D:/tiktok && node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --only-scenes 9-15 \
  --skip-compose
```

Kỳ vọng: 7 scenes, bao gồm scene 15 CTA overlay.

- [ ] **Step 4: Compose final video**

```bash
cd D:/tiktok && node vung/src/pipeline.mjs \
  --episode tap_01_qua_chuoi_bi_an_v2.md \
  --skip-render
```

Kỳ vọng: `tap_01_final.mp4`, ~121.9s, 1080x1920.

- [ ] **Step 5: Verify output**

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 \
  D:/tiktok/vung/output/tap_01/tap_01_final.mp4

ffmpeg -i D:/tiktok/vung/output/tap_01/tap_01_final.mp4 \
  -af volumedetect -f null - 2>&1 | grep -E "max_volume"
```

Kỳ vọng:
- Duration: 121.x s (±1s)
- max_volume: ≥ -5 dB

- [ ] **Step 6: Visual spot-check 5 frames**

```bash
mkdir -p D:/tiktok/vung/output/tap_01/_audit
ffmpeg -y -i D:/tiktok/vung/output/tap_01/tap_01_final.mp4 \
  -vf "fps=1/24" D:/tiktok/vung/output/tap_01/_audit/frame_%02d.png
```

User mở 5 frame (mỗi 24s), kiểm tra:
- Nhân vật nhất quán xuyên frame ✓
- Không watermark ✓
- Không duplicate ✓
- Không hình người/chó ✓

- [ ] **Step 7: Commit final**

```bash
cd D:/tiktok
git add vung/src/
git commit -m "feat(vung): complete reference-image pipeline (Approach A)

Scene-renderer now uses gemini-2.5-flash-image with canonical character
PNGs as multi-modal references. Characters stay consistent across all
14 story scenes.

Changes:
- scene-renderer: reference loader + prompt builder + feature flag
- pipeline: --skip-veo flag for cheap image testing
- intro-config: removed dead OUTRO_SUBSHOTS
- composer: removed dead includeDialogue branch
- gen-character-sheets: one-time canonical PNG generator
- test-gemini-image: smoke test for model availability

Tested: tap_01_final.mp4 produced, 121.9s, characters consistent.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Tổng kết chi phí ước tính

| Bước | Hành động | Chi phí |
|---|---|---|
| Task 2 | 4 canonical character sheets | ~$0.16 |
| Task 3 | Smoke test | ~$0.04 |
| Task 7 | Test 2 (scene 2) | ~$0.04 |
| Task 8 | Test 3 (scene 10) | ~$0.04 |
| Task 9 | Test 4 (scenes 2,5,10) | ~$0.12 |
| Task 10 | Full render 14 scenes (Imagen + Veo) | ~$6.16 |
| **Tổng** | | **~$6.56** |

Dưới ngưỡng $7 từ spec.
