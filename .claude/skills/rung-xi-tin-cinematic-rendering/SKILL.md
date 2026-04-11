---
name: rung-xi-tin-cinematic-rendering
description: Use when rendering scenes for the Rừng Xì Tin animated TikTok series (vung/src/) — multi-sub-shot Veo 3.1 Lite rendering with last-frame chaining, xfade transitions, hybrid Imagen+FFmpeg text, and the v4 one-shot cinematic technique. Applies whenever editing title-card-renderer.mjs, intro-config.mjs, scene-renderer.mjs, or creating new title/intro/outro scenes that need complex multi-beat cinematic motion within Veo's 8s limit.
---

# Rừng Xì Tin Cinematic Scene Rendering (v4)

This skill captures the working architecture for the `vung/` animated series pipeline after multiple iterations. Use it when touching scene rendering, especially for title scenes or any scene that needs multi-beat cinematic motion.

## When to use

- Editing `vung/src/title-card-renderer.mjs` or `vung/src/intro-config.mjs`
- Adding a new intro/outro/title scene to the Rừng Xì Tin pipeline
- A scene in `tap_NN_*.md` has 3+ distinct visual beats that Veo's 8s clip can't handle in one shot
- Debugging why a Veo clip "skips" beats from the prompt
- Any scene where visual text must appear (signs, banners, titles)

## Core architecture: multi-sub-shot with continuity

Veo 3.1 Lite cannot reliably animate 3+ distinct visual beats in a single 8s clip — it simplifies or drops beats. Solution: split the scene into N sub-shots, each a full 8s Veo clip, then concat with smooth transitions.

```
Scene = Sub-shot 1 + Sub-shot 2 + ... + Sub-shot N
Duration = N * 8 - (N-1) * 0.5  (xfade overlap)
Cost = N Imagen (for non-chained) + N Veo ≈ $0.42/sub-shot
```

## The four v4 techniques

### 1. Last-frame chaining (`chainFromPrevious: true`)

**Problem:** Hard cuts between sub-shots break the "one-shot" feel.

**Solution:** Extract the last frame of clip N as a PNG, feed it as Veo's `image:` input for clip N+1. Pixel-level continuity — the new clip literally starts where the old one ended.

```js
// In intro-config.mjs sub-shot definition:
{
  id: "clouds_to_forest",
  chainFromPrevious: true,  // ← use previous clip's last frame instead of Imagen
  motionPrompt: "Camera bursts through clouds revealing forest...",
  // imagenPrompt still kept as fallback if extraction fails
}

// In title-card-renderer.mjs renderTitleScene():
if (sub.chainFromPrevious && i > 0) {
  extractLastFrame(subClipPaths[i - 1], imagePath, log);
} else {
  await generateSubShotImage(sub, imagePath, log);
}
```

**`extractLastFrame` helper:**
```js
// -sseof -0.1 = seek 0.1s before end-of-file (fast, uses index)
// -frames:v 1 = capture exactly one frame
const cmd = `${FFMPEG} -y -sseof -0.1 -i "${videoPath}" -frames:v 1 -q:v 2 "${outputImgPath}"`;
```

**When NOT to chain:** Sub-shots that require a specific new visual element (e.g. wooden sign with carved text, a character appearing, a new location). Veo can't reliably add/render text from a motion prompt — always use fresh Imagen when text is needed. The xfade + matching color palette will disguise the cut.

### 2. xfade crossfade concat

**Problem:** Concat demuxer produces hard cuts even between visually similar clips.

**Solution:** FFmpeg `filter_complex` with `xfade` (video) + `acrossfade` (audio), 0.5s overlap.

```
[0:v]scale+pad+fps[v0n]
[1:v]scale+pad+fps[v1n]
[2:v]scale+pad+fps[v2n]
[v0n][v1n]xfade=transition=fade:duration=0.5:offset=7.5[vx1]
[vx1][v2n]xfade=transition=fade:duration=0.5:offset=15[vout]
[0:a][1:a]acrossfade=d=0.5[ax1]
[ax1][2:a]acrossfade=d=0.5[aout]
```

**Offset math:** `offset_i = (i * clipDur) - (i * xfadeDur) + (clipDur - xfadeDur)` — simpler: start at `clipDur - xfadeDur` (7.5), then add `clipDur - xfadeDur` (7.5) per stage.

**Always normalize first** (`scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:...,fps=30`) because Veo clips may differ slightly in codec params. xfade needs identical pixel format/dimensions.

**Audio:** Use `acrossfade=d=0.5` in parallel. Don't forget `-map "[vout]" -map "[aout]"` at the end — the concat filter outputs are labeled.

### 3. Hybrid Imagen + FFmpeg text (Option C)

**Problem:** FFmpeg drawtext full overlays look pasted-on and ugly. Imagen renders Vietnamese diacritics incorrectly (RỪNG → RỦNG, BÍ ẨN → BỊ ÀN).

**Solution:** Split text by what changes per episode vs what's constant.
- **Constant series title** → hardcoded ASCII ("RUNG XI TIN") baked into Imagen prompt, rendered on an in-scene object (wooden sign, banner, etc.). Imagen renders Latin reliably. Surprisingly, Imagen often adds correct Vietnamese context around ASCII-specified text.
- **Per-episode dynamic text** (episode number, title) → FFmpeg drawtext overlay with Montserrat-SemiBold font for reliable Vietnamese.

Font files:
```js
const FONT_BOLD = "D:/tiktok/assets/fonts/Montserrat-Bold.ttf";
const FONT_SEMI = "D:/tiktok/assets/fonts/Montserrat-SemiBold.ttf";
```

**DO NOT** add a `removeVietnameseDiacritics()` helper — the user rejected this. Series names that are constant should be hardcoded as ASCII in prompts directly.

### 4. Resumable versioning

**Problem:** Debugging requires comparing iterations. Overwriting old files prevents A/B verification.

**Solution:** Bump a `VERSION` constant (`v1`, `v2`, `v3`, `v4`...) and include it in every output filename. Old versions stay on disk for comparison.

```js
const VERSION = "v4";
const finalClipPath = `${outputDir}/scene_${sceneIdPadded}_${VERSION}.mp4`;
const imagePath = `${outputDir}/scene_${sceneIdPadded}_sub${idx}_${VERSION}.png`;
```

Every file function starts with `existsSync(path) && statSync(path).size > threshold` → skip. Never overwrite silently. This makes the whole pipeline resumable: if Veo fails mid-way, the next run skips already-done sub-shots.

**User rule:** *"khi làm bạn đừng xóa đi video cũ, chúng ta cần kiểm chứng từng bước"* — never delete old video files.

## Key implementation patterns

### Three-category key rotation (quota / access / transient)

`withKeyRotation` must handle THREE distinct error categories, each with different treatment:

1. **Exhausted** (429, quota, rate limit) → mark key exhausted, try next
2. **Access denied** (paid plan, permission_denied) → mark key exhausted, try next
3. **Transient** (returned no videos/image/audio, 503, internal error) → **rotate WITHOUT marking exhausted**, small delay, retry

The transient category is critical. Treating it as `isExhausted` would burn through the entire key pool on a single flaky API call.

```js
function isKeyAccessDenied(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("only available on paid") ||
         (msg.includes("invalid_argument") && msg.includes("imagen")) ||
         msg.includes("permission_denied") ||
         msg.includes("failed_precondition");
}

function isTransientApiError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("returned no videos") ||
         msg.includes("returned no image") ||
         msg.includes("returned no audio") ||
         msg.includes("veo timeout") ||
         msg.includes("internal error") ||
         msg.includes("internal server error") ||
         msg.includes("503") ||
         msg.includes("unavailable") ||
         msg.includes("deadline exceeded");
}

async function withKeyRotation(model, fn) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const handle = getClient(model);
    if (!handle) throw new Error(`All keys exhausted for ${model} today.`);
    try {
      return await fn(handle.client);
    } catch (err) {
      if (isExhausted(err) || isKeyAccessDenied(err)) {
        markKeyExhausted(handle.keyId, model);  // permanent for today
        continue;
      }
      if (isTransientApiError(err)) {
        // DO NOT mark exhausted — this is API flakiness, not a key problem
        await sleep(3000);
        continue;
      }
      throw err; // unknown error — bubble up as fatal
    }
  }
}
```

**Observed transient patterns in production:**
- Veo: ~1 in 20 calls returns no videos (random, not deterministic)
- TTS: ultra-short utterances (`…Ủa?`, `Hả?!`, 1-3 chars + punctuation) fail consistently on Gemini TTS. One observation: 14 consecutive retries across all 11 keys before the 15th attempt succeeded. Consider padding short TTS input if this becomes a problem.
- Imagen: rarely transient; usually fails deterministically (prompt issue) or quota.

### Veo motion prompt structure

Veo 3.1 Lite takes an image + motion prompt. Keep motion prompts to **1-2 dominant actions max**. Use "ending with X" for the final beat as context only — don't list 5 beats with "→" arrows; Veo fits too much and skips.

```js
// GOOD:
"Camera glides forward along a sparkling stream through the magical forest.
 Moving smoothly past colorful flowers and butterflies.
 A wooden signpost appears ahead with 'RUNG XI TIN' carved on it.
 Final shot lingers on the sign."

// BAD:
"Space → atmosphere → clouds → forest → waterfall → bridge → sign → text fade in"
```

### filter_complex requires explicit pad labels

**Critical gotcha:** When using `filter_complex` or `filter_complex_script`, simple filters like `drawbox` and `drawtext` need **explicit `[0:v]` input** and **`[vout]` output labels**. `-vf` does this implicitly, but `filter_complex` does not.

```js
// WRONG — produces "Cannot find an unused video input stream for drawbox":
const filter = `drawbox=...,drawtext=...`;

// RIGHT:
const filterBody = `drawbox=...,drawtext=...`;
const filter = `[0:v]${filterBody}[vout]`;
// Then: -map "[vout]" -map 0:a?
```

### Episode subtitle overlay timing

For N sub-shots × 8s with 0.5s xfade, the last sub-shot becomes fully visible at:
```
overlayStart = (N - 1) * (CLIP_DUR - xfadeDur) + 0.5
```
For N=3, CLIP_DUR=8, xfade=0.5 → `2 * 7.5 + 0.5 = 15.5s`. Start subtitle fade at 16s to let the viewer's eye land on the sign first.

## File map

```
vung/src/
├── title-card-renderer.mjs    # Multi-sub-shot rendering for isTitle scenes
│   ├── extractLastFrame()     # Last-frame chaining helper
│   ├── generateSubShotImage() # Imagen for fresh starting frames
│   ├── generateSubShotClip()  # Veo image-to-video
│   ├── concatSubShotsWithXfade()  # xfade filter_complex concat
│   ├── overlayEpisodeSubtitle()   # Option C FFmpeg drawtext
│   └── renderTitleScene()     # Public API — orchestrates all above
├── intro-config.mjs           # Hardcoded sub-shot templates (INTRO_SUBSHOTS, OUTRO_SUBSHOTS)
├── scene-renderer.mjs         # Non-title scenes (regular Imagen + Veo)
├── scene-parser.mjs           # Parses tap_NN_*.md into ParsedScene objects
├── pipeline.mjs               # CLI orchestrator
├── composer.mjs               # Final episode concat + audio mix
└── gemini-keys.js             # Multi-key rotation (free pool + billed pool)

vung/output/tap_NN/
├── scene_NN_subXX_vN.png      # Imagen OR last-frame PNG
├── scene_NN_subXX_vN.mp4      # Veo clip for that sub-shot
├── scene_NN_vN_concat.mp4     # xfade concat intermediate
├── scene_NN_vN.mp4            # Final with subtitle overlay
└── scene_NN.mp4               # Regular non-title scenes
```

## Sub-shot template (intro-config.mjs)

```js
{
  id: "descriptive_id",            // used in log output + filenames
  durationSec: 8,                  // informational; Veo always outputs 8s
  chainFromPrevious: false,        // true = use prev clip's last frame
  imagenPrompt: [                  // Imagen prompt (ignored if chaining)
    "Detailed visual description",
    "Pixar 3D cartoon style, vibrant saturated colors",
    "NO TEXT, NO LETTERS, NO WRITING",  // unless text is intentional
  ].join(". "),
  motionPrompt: [                  // Veo motion instructions (1-2 beats max)
    "Primary camera movement",
    "Secondary action / ending beat",
    "Pixar 3D cartoon, cinematic motion",
  ].join(". "),
}
```

## Testing workflow

Run scene-specific test with render only (no final compose):
```bash
node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md --only-scenes 1 --skip-compose
```

Verify output:
```bash
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_type,width,height -of default=noprint_wrappers=0 "D:/tiktok/vung/output/tap_01/scene_01_v4.mp4"
```

Expected for 3 sub-shots × 8s with 0.5s xfade: **duration ≈ 23.0s**, 1080x1920, h264 + aac.

## Red flags during rendering

| Symptom | Root cause | Fix |
|---|---|---|
| Veo clip only shows first beat of prompt | Prompt has 3+ beats | Split into sub-shots, one beat each |
| Text on sign comes out as "RỦNG" not "RỪNG" | Imagen rendering Vietnamese diacritics | Hardcode ASCII ("RUNG XI TIN") in prompt |
| Hard cut between sub-shots feels jerky | Plain concat demuxer | Use xfade crossfade concat |
| Sub-shot 2 doesn't match sub-shot 1 visually | No chaining | Set `chainFromPrevious: true` |
| FFmpeg error "Cannot find unused video input for drawbox" | filter_complex missing pad labels | Prefix `[0:v]`, suffix `[vout]`, map `[vout]` |
| Scene has no audio after concat | `-an` flag or missing audio codec | Use `-c:a aac -b:a 128k -ar 44100` |
| Some Imagen keys fail with permission_denied | Keys lack Imagen paid access | Add `isKeyAccessDenied` check to `withKeyRotation` |
| "All keys exhausted for veo today" | Billed pool depleted | Wait for daily reset OR add more billed keys to `GEMINI_VEO_KEY_INDICES` |
| "Veo returned no videos" mid-batch | Transient API glitch | `isTransientApiError` retry (rotate key WITHOUT marking exhausted) |
| "TTS returned no audio" on short utterance | Gemini TTS doesn't like `…Ủa?` or `Hả?!` (too few phonemes) | Retry via `isTransientApiError` — eventually succeeds; or pad short lines |
| TTS retries burn through all keys | Treating transient error as `isExhausted` | Separate transient path that does NOT call `markKeyExhausted` |
| Last scene (CTA) drops its dialogue | `isLastScene && looksLikeCTA` → title renderer | Only scene 1 is `isTitle`; all other scenes render from breakdown |
| Final audio "quá nhỏ" despite individual scenes sounding fine | FFmpeg `amix` default `normalize=1` divides by N inputs — with 20+ inputs each gets 1/N ≈ 5% volume | Use `amix=...:normalize=0` + set scene audio volume=1.0 + `includeDialogue=false` to rely on native Veo audio |
| Imagen renders 2 Momos (or 2 of any character) in one scene | Breakdown text mentions "Momo" multiple times → Imagen tokenizes each as separate subject | `dedupeActionText()` replaces 2nd+ mentions with "they" + explicit "ONLY ONE X" constraint + negative "multiple instances of same character" |
| Want to remove a sub-shot from title scene without deleting the file | User rule: "không xóa file cũ" | Add `excludeFromConcat: true` flag in intro-config — render loop still iterates (cached→$0) but concat skips it |

## Audio mixing (CRITICAL: amix normalize gotcha)

**The "quá nhỏ" bug** — FFmpeg's `amix` filter has a sneaky default: `normalize=1` means each input is divided by N (number of inputs) to prevent clipping. With 1 scene audio + 19 dialogue TTS lines + 1 bgm = 21 inputs, the scene audio was reduced to 1/21 ≈ 4.8% of original volume. Result: final episode audio was ~25dB quieter than individual scenes.

**Fix**: Pass `normalize=0` to every `amix` call:
```js
`${mixInputs.join("")}amix=inputs=${mixInputs.length}:` +
  `duration=longest:dropout_transition=0:normalize=0[aout]`
```

**Audio strategy (post-fix)** — Rely on native Veo audio, skip dialogue mixing by default:
1. Scene audio volume: **1.0** (was 0.4 in the old "dialogue-dominant" design)
2. Dialogue TTS mixing: **disabled by default** (`includeDialogue: false`)
   - The TTS files are still generated and cached for future use (e.g. subtitles, alternate edit)
   - But the composer does NOT mix them into the final audio track
   - User feedback was that native Veo scene audio "rất tốt" (very good)
3. Background music: optional, mixed with `normalize=0` if present
4. Short-circuit: if only 1 mix input (scene audio, no dialogue, no bgm), use `anull` instead of `amix` to avoid unnecessary processing

**Single-input short-circuit** — When `mixInputs.length === 1`:
```js
filterParts.push(`[sceneaudio]anull[aout]`);  // passthrough, no amix
```
Otherwise use `amix=...:normalize=0`. This avoids any chance of amix touching the audio when it's not needed.

**Measuring audio levels** to verify the fix:
```bash
ffmpeg -i tap_01_final.mp4 -af volumedetect -f null - 2>&1 | grep volume
```
Expected: `max_volume: -0.8 dB` (near peak) for properly mixed output. If you see `-15 dB` or lower, the amix normalize bug is back.

## Character duplicate prevention (buildScenePrompt)

**The "2 Momos" bug** — Scene breakdowns often repeat the character name across beats:
```
Momo nhìn quanh. Momo đào đất. Momo đặt chuối. Momo phủ đất.
```
Imagen tokenizes each "Momo" as a separate subject → generates 2-4 Momos in the same image. Not deterministic (sometimes renders correctly), but common for scenes with 3+ mentions of the same character.

**Fix 1: dedupe the action text** — replace 2nd+ mentions with "they":
```js
function dedupeActionText(action, characters) {
  let result = action;
  for (const charKey of characters) {
    const capitalized = charKey.charAt(0).toUpperCase() + charKey.slice(1);
    let count = 0;
    result = result.replace(new RegExp(`\\b${capitalized}\\b`, "g"), (m) => {
      count++;
      return count === 1 ? m : "they";
    });
  }
  return result;
}
```

**Fix 2: explicit "ONLY ONE" constraint**:
```js
const uniquenessConstraint = scene.characters
  .map((c) => `ONLY ONE ${c.charAt(0).toUpperCase() + c.slice(1)}`)
  .join(", ") + " in the scene";
```

**Fix 3: duplicate-character negative prompt**:
```js
"Avoid: multiple instances of the same character, duplicate characters, " +
"twin characters, cloned characters, two of the same animal"
```

**Apply dedupe to BOTH Imagen and Veo prompts** — Imagen generates the starting frame (primary defense), Veo animates it (secondary defense). If Imagen produces a single-Momo image but Veo's motion prompt says "Momo X. Then Momo Y", Veo may still introduce a phantom second Momo during animation. Dedupe both prompts.

## Composer inter-scene transitions (composer.mjs)

The final episode stitches 15 scenes together. **Hard cuts between scenes feel jerky** — same lesson as within title scenes. Apply the same techniques at episode level:

**Key techniques in `composeVideo()`:**
1. **xfade chain between scenes** — 0.4s fade transition between every adjacent pair
2. **acrossfade audio chain** — scene ambient audio acrossfades in parallel
3. **Dialogue timing math MUST account for xfade overlap** — each scene's visible start shifts by `(clipDur - xfadeDur)`, not just `clipDur`. Forgetting this causes cumulative drift (e.g. 5.6s off by scene 15 with 0.4s xfade × 14 transitions).
4. **Scene audio volume reduction** — Veo ambient audio at 0.4 volume so dialogue TTS (at 1.3 boost) dominates
5. **Episode fadein/fadeout** — `fade=in:st=0:d=0.5` + `fade=out:st=T-0.5:d=0.5` on the concat output for smooth from-black start and to-black end
6. **Background music optional** — `bgMusic` in composer options; `amix` with `dropout_transition=0` to avoid cutoffs

**Duration formula for an episode:**
```
total = sum(sceneClipDurations) - (N-1) * xfadeDur
     = 23 (scene 1 v4) + 14 * 8 - 14 * 0.4  // Rừng Xì Tin tập 1
     = 23 + 112 - 5.6
     = 129.4s
```

**composer.mjs must probe clip durations at runtime** — don't hardcode 8s. Scene 1 is 23s (title v4), regular scenes are 8s. Use `ffprobe -v error -show_entries format=duration` for each clip, cache as `r.clipDur`.

## Cost per scene (Veo 3.1 Lite, $0.05/s @ 720p)

| Scene type | Imagen | Veo | Total |
|---|---|---|---|
| Regular (1 Imagen + 1 Veo) | $0.02 | $0.42 | $0.44 |
| Title v4 (2 Imagen + 3 Veo, 1 chained) | $0.04 | $1.26 | $1.30 |
| Full episode (13 regular + 2 title) | $0.26 | $8.04 | **~$8.30** |

## Version history (lessons learned)

- **v1** — FFmpeg drawtext full overlay. Ugly, text looks pasted on video.
- **v2** — Vietnamese diacritics passed to Imagen. Diacritics rendered wrong (RỦNG, BỊ ÀN).
- **v3** — Hardcoded ASCII "RUNG XI TIN" in Imagen + plain concat demuxer. Text OK but jerky hard cuts + prompts too generic (missing script elements).
- **v4** — On-script detailed prompts (waterfall, bridge, butterflies, stream) + last-frame chaining + xfade transitions + hybrid text (Imagen sign + FFmpeg episode subtitle). **Current production version for scene 1 (intro).**

## CTA text overlay + voice-over (scene 15 pattern)

Scenes with CTA content (typically the last scene) have a specific markdown format in the breakdown. The parser extracts two things: `textOverlays` (FFmpeg drawtext) and narrator dialogue lines (TTS).

**Script format (scene 15 of tap_01):**
```markdown
* **Giây 7–8:** Text hiện lên + voice over:

  👉 Text:
  "👉 ĐÓN XEM TẬP 2: WIFI RỪNG BỊ LAG!"

  👉 Voice (giọng vui):
  "Đừng bỏ lỡ tập tiếp theo nhé!"
```

**Parser behavior** (`parseCtaFromBreakdown` in scene-parser.mjs):
- Iterates breakdown lines looking for **standalone** marker lines: `^(?:👉\s*)?Text\s*:?\s*$` or `^(?:👉\s*)?Voice(?:\s*\(direction\))?\s*:?\s*$`
- Takes the **next non-empty line** as the value (within 5 lines)
- Strips surrounding quotes (smart quotes + ASCII)
- `Voice` lines become narrator dialogue with `character: "narrator"` (Charon voice)
- Appends narrator lines to `scene.dialogue` so existing TTS loop handles them
- **Does NOT match inline 👉** (scene 1's format `Text/Logo: 👉 "..."` has the pointer on the same line as the description, so it's ignored here — scene 1 uses template text instead)

**Renderer behavior** (`overlayTextOnClip` in scene-renderer.mjs):
- After Veo clip generation, if `scene.textOverlays.length > 0`, bake FFmpeg drawtext overlay onto the raw clip → `scene_NN_overlay.mp4`
- Preserves raw `scene_NN.mp4` for debugging and A/B comparison
- Overlay timing: fades in at t=6.0s (last 2s of 8s clip), 0.5s fade
- Uses Montserrat-Bold for main text, Montserrat-SemiBold for subtitle
- Colors: `#FFE08A` (gold) main, `#FFFFFF` (white) secondary, dark band `black@0.55` behind
- Strips emoji glyphs that Montserrat lacks (using `stripUnsupportedGlyphs`)
- filter_complex with `[0:v]...[vout]` labels (see gotcha below)

**Pipeline `--skip-render` clip resolution priority:**
1. Title scenes → `scene_NN_v4.mp4` (multi-sub-shot intro)
2. Scenes with `textOverlays.length > 0` → `scene_NN_overlay.mp4` (CTA overlay)
3. Regular scenes → `scene_NN.mp4` (raw Veo clip)

**Narrator character** is pre-defined in `voices.mjs` with voice `Charon` (informative storytelling tone), `visualPrompt: null` so it doesn't pollute Imagen character prompts. Adding narrator lines to dialogue via `parseCtaFromBreakdown` automatically flows through the existing TTS + audio mix pipeline — no special casing required.

**Dialogue timing when narrator appears last:** the composer's `planDialogueTimingWithXfade` distributes dialogue evenly with head/tail padding. For scene 15 with 3 lines (Tiko, Momo, narrator), narrator lands at ~5.17s — close enough to the CTA overlay start at 6.0s. If more precise timing is needed, add a per-line `startSec` override to the dialogue schema.

## Full episode workflow (produced tập 1 successfully)

```bash
# 1. Dry run to verify script parses correctly
node vung/src/pipeline.mjs --episode tap_NN_*.md --dry-run

# 2. Render title scene first (test v4 quality before committing budget)
node vung/src/pipeline.mjs --episode tap_NN_*.md --only-scenes 1 --skip-compose

# 3. Render remaining scenes in batches (fits under Bash 10-min timeout,
#    catches errors early before spending full budget)
node vung/src/pipeline.mjs --episode tap_NN_*.md --only-scenes 2-9 --skip-compose
node vung/src/pipeline.mjs --episode tap_NN_*.md --only-scenes 10-15 --skip-compose

# 4. Final compose (uses cached clips)
node vung/src/pipeline.mjs --episode tap_NN_*.md --skip-render

# 5. Verify output duration matches math
ffprobe -v error -show_entries format=duration -of csv=p=0 vung/output/tap_NN/tap_NN_final.mp4
# Expected: 23 (scene 1 v4) + (N_regular * 8) - ((N_total-1) * xfadeDur)
# For 15-scene episode with 0.4s xfade: 23 + 112 - 5.6 = 129.4s
```

**Resumability is automatic** — every generator function checks `existsSync(path) && statSync(path).size > threshold` before calling the API. Re-running a failed batch skips already-cached scenes. Never delete output files to "force regeneration" — bump the VERSION constant instead.
