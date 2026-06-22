/**
 * VEO HOOK — image-to-video pipeline for Shopee bestsellers without source video.
 *
 * Pipeline:
 *   1. Download up to 6 product images from Shopee CDN.
 *   2. Resize each to 1080x1920 (9:16) with blurred-background padding via FFmpeg.
 *   3. (Task 7) Claude generates veoHookPrompt + voiceoverScript.
 *   4. (Task 8) Veo generates 8s cinematic clip from image-1.
 *   5. (Task 9) Gemini TTS renders the voiceover.
 *   6. (Task 10) FFmpeg composes the final 60-70s video.
 *
 * Public entry: generateVeoHookVideo(product, outputPath, opts)
 *   product: parsed Shopee product (must have product.images[] = array of CDN paths)
 *   opts.style: "urgent" | "elegant" | "playful"
 *   opts.targetDuration: seconds (default 60)
 *   opts.workDir: scratch directory (default: derived from outputPath)
 *   opts.log: logger function (default console.log)
 *   opts.mockVeo: if true, use a placeholder 8s clip instead of calling Veo (for tests)
 */
import { spawnSync } from "child_process";
import {
  writeFileSync, readFileSync, mkdirSync,
  existsSync, statSync, unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { FFMPEG, FONT } from "./config.mjs";
import { generateVideo, pickAvailableModel } from "../veo.js";
import { generateGeminiTTS } from "../gemini-tts.js";

const IMAGE_CDN = "https://down-vn.img.susercontent.com/file/";
const MAX_IMAGES = 6;

function run(cmd, timeout = 60_000) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", timeout });
}

/**
 * Download up to MAX_IMAGES images for a product, resize each to 1080x1920
 * with blurred-background padding.
 *
 * Reads paths from `product.images` (array of CDN-relative paths). If absent,
 * falls back to [product.image] which always exists for parsed products.
 *
 * @param {Object} product
 * @param {string} workDir - directory to write img_N.jpg files
 * @param {Function} log
 * @returns {Promise<string[]>} - array of absolute paths to padded 1080x1920 JPGs
 */
export async function prepareImages(product, workDir, log = console.log) {
  mkdirSync(workDir, { recursive: true });

  // Collect candidate CDN paths. parseProduct() does not currently expose
  // images[]; we read from the original cache item if attached, otherwise
  // fall back to the single product.image URL.
  const cdnPaths = collectCdnPaths(product);
  if (cdnPaths.length === 0) {
    throw new Error(`No images for product ${product.itemId}`);
  }

  const padded = [];
  for (let i = 0; i < Math.min(cdnPaths.length, MAX_IMAGES); i++) {
    const url = cdnPaths[i].startsWith("http") ? cdnPaths[i] : IMAGE_CDN + cdnPaths[i];
    const rawPath = join(workDir, `raw_${i}.jpg`);
    const outPath = join(workDir, `img_${i}.jpg`);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://shopee.vn/" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) { log(`   [veo-hook] img ${i} HTTP ${res.status}, skip`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(rawPath, buf);
    } catch (e) {
      log(`   [veo-hook] img ${i} download fail: ${e.message?.slice(0, 60)}`);
      continue;
    }

    // Pad to 1080x1920 with blurred background of itself.
    const cmd =
      `"${FFMPEG}" -y -i "${rawPath}" -filter_complex ` +
      `"[0:v]split[a][b];` +
      `[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:30[bg];` +
      `[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p" ` +
      `-frames:v 1 -q:v 2 "${outPath}"`;
    const r = run(cmd, 30_000);
    if (existsSync(outPath) && statSync(outPath).size > 5_000) {
      padded.push(outPath);
      try { unlinkSync(rawPath); } catch {}
    } else {
      log(`   [veo-hook] img ${i} ffmpeg pad fail: ${(r.stderr || "").slice(-120)}`);
    }
  }

  if (padded.length === 0) throw new Error(`All image preparations failed for ${product.itemId}`);
  log(`   [veo-hook] prepared ${padded.length} image(s) at 1080x1920`);
  return padded;
}

/**
 * Collect CDN image paths from a product. Tries multiple shapes because the
 * cache stores raw API objects while parseProduct() only retains product.image
 * (the cover). When called from reup.mjs we attach product._raw to expose the
 * full images[] array.
 */
function collectCdnPaths(product) {
  const out = [];
  if (Array.isArray(product._raw?.batch_item_for_item_card_full?.images)) {
    out.push(...product._raw.batch_item_for_item_card_full.images);
  }
  if (out.length === 0 && product.image) {
    // product.image is already a full URL (IMAGE_CDN + path)
    out.push(product.image);
  }
  return out;
}

const STYLE_DESCRIPTORS = {
  urgent:  "fast cuts, neon accents, energetic music feel, punchy, attention-grabbing",
  elegant: "soft pastel tones, slow motion, luxurious, calm, premium feel",
  playful: "warm bright tones, family-friendly, cheerful, approachable",
};

/**
 * Ask Claude Haiku for a Veo cinematic prompt + a 60–65s Vietnamese voiceover
 * script tailored to the product and page style.
 *
 * Returns { veoHookPrompt: string, voiceoverScript: string }. On API failure,
 * returns a template fallback so the caller can continue.
 */
export async function generateScripts(product, style = "urgent", log = console.log) {
  const styleDesc = STYLE_DESCRIPTORS[style] || STYLE_DESCRIPTORS.urgent;
  const productName = (product.name || "Sản phẩm Shopee").slice(0, 100);
  const price = product.price ? `${product.price.toLocaleString("vi")}đ` : "giá tốt";

  const prompt = `Bạn là creative director cho video bán hàng Shopee. Pipeline:
- 0-8s: AI Veo 3.1 Lite render MC (woman) đọc hookLine với native lip-sync. Veo nhận ảnh sản phẩm thật làm reference.
- 8s+: Slideshow ảnh sản phẩm với Gemini TTS đọc extendedScript.
- Tổng video target ~35-40s (loop nếu cần).

Sản phẩm: "${productName}"
Giá: ${price}
Style: ${styleDesc}

Tạo 3 thứ (JSON):

1. veoHookPrompt — prompt tiếng Anh (350-650 ký tự) cho Veo 3.1 Lite render 8s, 9:16. PHẢI:
   - MC: "Young attractive Vietnamese woman (early 20s), stylish modern outfit (crop top + jeans / form-fitting casual), confident charming smile, slightly flirty energy, well-groomed hair and makeup, cheerful young female voice"
   - Setting: bright modern apartment với soft warm lighting
   - QUAN TRỌNG: Visual phải match the product in the reference image — sản phẩm đúng đó, không hư cấu. Phrase: "exactly matching the product shown in reference image"
   - Action: cô ấy holding/demonstrating sản phẩm, dynamic poses, eye contact với camera
   - Speech: "She speaks directly to camera with energetic cheerful tone:" + QUOTE hookLine trong dấu nháy kép. Veo sẽ lip-sync.
   - Camera: smooth handheld, quick zoom-ins on product, modern color grading
   - 9:16 vertical, 8 seconds, no overlay text/logo

2. hookLine — câu Việt ≤ 25 TỪ (Veo lip-sync trong 8s đầu). Hài hước, nhồi tên SP. Ví dụ: "Nhà bạn bụi bẩn quá hả? Máy Hút TAMASHIO 6 đầu — cứu tinh đây nha!"

3. extendedScript — script Việt 50-80 từ (Gemini TTS đọc 20-30s) cho slideshow. KHÔNG lặp lại hookLine. Gồm: 2-3 đặc điểm cụ thể (số liệu, tính năng) + giá ${price} + CTA "Link mua ngay bên dưới". Tone duyên dáng có chút hài.

Trả về JSON đúng format:
{"veoHookPrompt":"...","hookLine":"...","extendedScript":"..."}

Chỉ JSON, không giải thích.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() || "";
    // Strip code fences if Claude wraps the JSON
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!parsed.veoHookPrompt || !parsed.hookLine || !parsed.extendedScript) {
      // Backward compat: old voiceoverScript field as fallback for both
      if (parsed.voiceoverScript && !parsed.hookLine) {
        parsed.hookLine = parsed.voiceoverScript.split(/[.!?]/)[0].slice(0, 100);
        parsed.extendedScript = parsed.voiceoverScript;
      } else {
        throw new Error("missing fields");
      }
    }
    log(`   [veo-hook] script OK (hook=${parsed.hookLine.length}c, ext=${parsed.extendedScript.length}c)`);
    return parsed;
  } catch (e) {
    log(`   [veo-hook] Claude fail (${e.message?.slice(0, 60)}) — using template`);
    const shortName = productName.slice(0, 40);
    const hookLine = `Khoan! ${shortName} đây — bán chạy số 1!`;
    return {
      veoHookPrompt: `Young attractive Vietnamese woman (early 20s), stylish modern outfit, charming smile, in bright apartment. She holds the ${shortName} (exactly matching the product in reference image), demonstrating with confident hands, eye contact with camera. She speaks directly to camera with energetic cheerful tone: "${hookLine}" Smooth handheld camera, quick zoom-ins, modern color grading. 9:16 vertical, 8 seconds, no overlay text.`,
      hookLine,
      extendedScript:
        `Sản phẩm này dùng siêu sướng tay, chất lượng đảm bảo, ưu đãi đang giảm sâu. ` +
        `Giá chỉ ${price}, rẻ hơn ly trà sữa. Link mua ngay bên dưới, đừng bỏ lỡ nha!`,
    };
  }
}

/**
 * Generate the 8s Veo cinematic hook from image-1.
 *
 * Quota policy: try fast first, then standard. Skip premium (reserved for
 * quotes). If both exhausted, returns { fallback: "kenburns_only" } and the
 * caller composes without a Veo segment.
 *
 * @param {string} veoPrompt
 * @param {string} imagePath - path to padded 1080x1920 JPG
 * @param {string} outputPath
 * @param {Object} opts
 * @returns {Promise<{path: string, model: string} | {fallback: string}>}
 */
export async function generateHookClip(veoPrompt, imagePath, outputPath, opts = {}) {
  const log = opts.log || console.log;

  if (opts.mockVeo) {
    // Test mode: produce a 8s placeholder by zoompanning the input image
    const cmd =
      `"${FFMPEG}" -y -loop 1 -i "${imagePath}" -t 8 ` +
      `-vf "zoompan=z='min(zoom+0.0015,1.3)':d=200:s=1080x1920:fps=25,format=yuv420p" ` +
      `-c:v libx264 -preset ultrafast -crf 26 "${outputPath}"`;
    run(cmd, 30_000);
    if (existsSync(outputPath) && statSync(outputPath).size > 50_000) {
      log(`   [veo-hook] mock Veo clip generated`);
      return { path: outputPath, model: "mock" };
    }
    throw new Error("mock Veo ffmpeg failed");
  }

  // Use opts.veoModel if provided (e.g. "lite" for native audio + lip-sync).
  // Otherwise fall back to pickAvailableModel() priority order.
  const modelKey = opts.veoModel || pickAvailableModel();
  if (!modelKey || modelKey === "premium") {
    log(`   [veo-hook] Veo quota exhausted (or only premium left) → Ken Burns fallback`);
    return { fallback: "kenburns_only" };
  }

  try {
    const r = await generateVideo(veoPrompt, outputPath, {
      model: modelKey,
      image: imagePath,
      aspectRatio: "9:16",
    });
    log(`   [veo-hook] Veo OK (tier=${r.model})`);
    return { path: r.path, model: r.model };
  } catch (e) {
    log(`   [veo-hook] Veo failed (${e.message?.slice(0, 80)}) → Ken Burns fallback`);
    return { fallback: "kenburns_only" };
  }
}

/**
 * Generate VN voiceover using Gemini TTS. Saves to outputPath (.mp3 or .wav).
 *
 * Voice picked per style: urgent → Fenrir (excitable), elegant → Enceladus
 * (breathy calm), playful → Puck (upbeat).
 */
export async function generateVoiceover(script, style, outputPath, opts = {}) {
  const log = opts.log || console.log;
  // Female voices, high-energy bias for Shopee hook ads (per user feedback:
  // "giọng nữ, tông cao, đọc nhanh"). NOT same as quotes pipeline (Algenib/male).
  const voiceMap = {
    urgent:  "Zephyr",   // Bright, fast — best for energetic hook ads
    elegant: "Aoede",    // Smooth, warm female — beauty/fashion
    playful: "Leda",     // Youthful, upbeat female — family/playful
  };
  const styleInstruction = {
    urgent:  "Speak in a fast, energetic, high-pitched young Vietnamese female voice. Maximum enthusiasm, like a TikTok product reviewer. Quick pace, no pauses.",
    elegant: "Speak in a warm, smooth, slightly fast young Vietnamese female voice. Confident, friendly, premium feel.",
    playful: "Speak in a playful, upbeat, fast young Vietnamese female voice. Cheerful, like talking to a friend.",
  };
  const voice = voiceMap[style] || "Zephyr";
  const styleText = styleInstruction[style] || styleInstruction.urgent;
  try {
    const r = await generateGeminiTTS(script, outputPath, { voice, style: styleText });
    log(`   [veo-hook] TTS OK (voice=${voice}, ${(r.sizeBytes / 1024).toFixed(0)}KB)`);
    return { path: r.path };
  } catch (e) {
    log(`   [veo-hook] TTS failed (${e.message?.slice(0, 80)}) — composing without voiceover`);
    return { path: null };
  }
}

/**
 * Compose final video from Veo clip + slideshow + extended TTS, with auto-loop.
 *
 * Architecture (Option A from user):
 *   - Veo segment (8s): native audio + lip-sync from Veo (MC speaks hookLine)
 *   - Slideshow segment (~25-30s): all images Ken Burns 5s each + extended TTS
 *   - If total < targetDuration, append the result to itself (loop) to extend
 *
 * Text overlays start at 8s (after Veo segment) so MC speaking is uninterrupted.
 * Persistent page signature bottom-right throughout.
 *
 * @param {Object} args
 * @param {string|null} args.veoClip       - 8s Veo clip path WITH native audio (or null = Ken Burns fallback)
 * @param {string[]} args.images           - 1080x1920 JPGs (≥1 required, all used in slideshow)
 * @param {string|null} args.extendedAudio - Gemini TTS extendedScript audio file (or null)
 * @param {Object} args.product            - for text overlays + price
 * @param {string} args.outputPath
 * @param {string|null} args.pageName      - persistent signature bottom-right
 * @param {number} [args.targetDuration=35] - seconds; loop if (veo+slideshow) < this
 * @param {Function} args.log
 */
export async function composeVideo({
  veoClip, images, extendedAudio, product, outputPath,
  log = console.log, pageName = null, targetDuration = 35,
}) {
  const workDir = dirname(outputPath);
  mkdirSync(workDir, { recursive: true });
  if (images.length === 0) throw new Error("composeVideo: no images");

  const segDir = join(workDir, "_seg");
  mkdirSync(segDir, { recursive: true });

  // ffprobe helper for duration
  const ffprobePath = FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const probeDur = (p) => {
    const r = run(`"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${p}"`, 10_000);
    return parseFloat((r.stdout || "0").trim()) || 0;
  };

  // Segment A: Veo 8s WITH native audio (or Ken Burns fallback w/ silent track)
  const segAPath = join(segDir, "a.mp4");
  if (veoClip && existsSync(veoClip)) {
    // Re-encode but KEEP audio (Veo's native audio + lip-sync).
    run(`"${FFMPEG}" -y -i "${veoClip}" -vf "scale=1080:1920,format=yuv420p,fps=25" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${segAPath}"`, 60_000);
  } else {
    // Fallback: Ken Burns on image-0 with silent audio track.
    run(`"${FFMPEG}" -y -loop 1 -i "${images[0]}" -f lavfi -i anullsrc=r=44100:cl=stereo -t 8 -vf "zoompan=z='min(zoom+0.0015,1.3)':d=200:s=1080x1920:fps=25,format=yuv420p" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest "${segAPath}"`, 60_000);
  }

  // Segment B: slideshow of ALL images, Ken Burns 5s each, with silent audio
  const slideDur = 5;
  const segBPaths = [];
  for (let i = 0; i < images.length; i++) {
    const p = join(segDir, `b_${i}.mp4`);
    const direction = i % 2 === 0
      ? "zoompan=z='min(zoom+0.001,1.25)':d=125:s=1080x1920:fps=25"
      : "zoompan=z='if(lte(zoom,1.0),1.25,max(1.001,zoom-0.001))':d=125:s=1080x1920:fps=25";
    run(`"${FFMPEG}" -y -loop 1 -i "${images[i]}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${slideDur} -vf "${direction},format=yuv420p" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest "${p}"`, 60_000);
    segBPaths.push(p);
  }

  // Concat Veo + slideshow
  const concatList = join(segDir, "concat.txt");
  const allSegs = [segAPath, ...segBPaths];
  writeFileSync(concatList, allSegs.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
  const joinedPath = join(segDir, "joined.mp4");
  run(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${joinedPath}"`, 120_000);

  // Mux extended TTS over slideshow portion (delayed by Veo length)
  const veoLen = probeDur(segAPath);  // ~8s
  let withExtAudio = joinedPath;
  if (extendedAudio && existsSync(extendedAudio)) {
    withExtAudio = join(segDir, "with_ext.mp4");
    const delayMs = Math.max(0, Math.floor(veoLen * 1000));
    // Mix joined's audio (Veo for 0-veoLen, silence after) with extended TTS
    // delayed to start at veoLen. Use adelay=N:all=1 (works for mono+stereo)
    // and duration=first (don't extend beyond joined.mp4 length).
    run(`"${FFMPEG}" -y -i "${joinedPath}" -i "${extendedAudio}" -filter_complex "[1:a]adelay=${delayMs}:all=1[delayed];[0:a][delayed]amix=inputs=2:duration=first:dropout_transition=0[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k "${withExtAudio}"`, 120_000);
  }

  // Auto-loop if duration < targetDuration
  const oneLoopLen = probeDur(withExtAudio);
  let loopedPath = withExtAudio;
  if (oneLoopLen > 0 && oneLoopLen < targetDuration) {
    log(`   [veo-hook] one-pass=${oneLoopLen.toFixed(1)}s < target=${targetDuration}s, looping`);
    const loopList = join(segDir, "loop.txt");
    const passes = Math.ceil(targetDuration / oneLoopLen);
    writeFileSync(loopList, Array(passes).fill(`file '${withExtAudio.replace(/\\/g, "/")}'`).join("\n"));
    loopedPath = join(segDir, "looped.mp4");
    run(`"${FFMPEG}" -y -f concat -safe 0 -i "${loopList}" -c copy "${loopedPath}"`, 120_000);
  }

  // Text overlays (start AFTER Veo's lip-sync segment to not cover MC's face)
  const fontEsc = FONT.replace(/\\/g, "/").replace(/:/g, "\\:");
  const productName = (product.name || "").replace(/[【】\[\]()（）'":]/g, "").slice(0, 38);
  const priceTxt = product.price ? `${product.price.toLocaleString("vi")}d` : "Gia tot";
  const soldTxt = product.sold
    ? (product.sold >= 1_000_000 ? `Da ban ${Math.floor(product.sold / 1_000_000)}M+`
      : product.sold >= 1000 ? `Da ban ${Math.floor(product.sold / 1000)}k+` : `Da ban ${product.sold}+`)
    : "Ban chay";
  const esc = (s) => s.replace(/'/g, "’").replace(/:/g, "\\:").replace(/[[\]"]/g, "").replace(/%/g, "%%");

  const overlays = [
    // 8.5-13s: product name + sold
    `drawtext=fontfile='${fontEsc}':text='${esc(productName)}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=120:enable='between(t,8.5,13)':box=1:boxcolor=black@0.7:boxborderw=18:shadowcolor=black:shadowx=3:shadowy=3`,
    `drawtext=fontfile='${fontEsc}':text='${esc(soldTxt)}':fontcolor=yellow:fontsize=56:x=(w-text_w)/2:y=240:enable='between(t,8.5,13)':box=1:boxcolor=black@0.75:boxborderw=14`,
    // 13-23s: feature callouts
    `drawtext=fontfile='${fontEsc}':text='Chat luong dam bao':fontcolor=yellow:fontsize=52:x=(w-text_w)/2:y=200:enable='between(t,13,18)':box=1:boxcolor=black@0.75:boxborderw=14`,
    `drawtext=fontfile='${fontEsc}':text='Uu dai cuc soc':fontcolor=yellow:fontsize=52:x=(w-text_w)/2:y=200:enable='between(t,18,23)':box=1:boxcolor=black@0.75:boxborderw=14`,
    // 23-30s: BIG price
    `drawtext=fontfile='${fontEsc}':text='${esc(priceTxt)}':fontcolor=white:fontsize=110:x=(w-text_w)/2:y=h/2-60:enable='between(t,23,30)':box=1:boxcolor=red@0.85:boxborderw=24:shadowcolor=black:shadowx=4:shadowy=4`,
    // 30s+: CTA persistent until end
    `drawtext=fontfile='${fontEsc}':text='MUA NGAY LINK DUOI':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=h-260:enable='gte(t,30)':box=1:boxcolor=red@0.85:boxborderw=20`,
  ];

  // Persistent page signature (bottom-right, always)
  if (pageName) {
    const sig = esc(pageName.replace(/[^\p{L}\p{N} &]/gu, "").slice(0, 30));
    overlays.push(
      `drawtext=fontfile='${fontEsc}':text='${sig}':fontcolor=white:fontsize=30:x=w-text_w-25:y=h-80:box=1:boxcolor=black@0.55:boxborderw=10`
    );
  }
  const drawtexts = overlays.join(",");

  // Final encode: apply overlays (audio passes through unchanged)
  run(`"${FFMPEG}" -y -i "${loopedPath}" -filter_complex "[0:v]${drawtexts}[v]" -map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a copy "${outputPath}"`, 240_000);

  if (!existsSync(outputPath) || statSync(outputPath).size < 200_000) {
    const sz = existsSync(outputPath) ? statSync(outputPath).size : 0;
    throw new Error(`composeVideo: output too small or missing — ${sz} bytes`);
  }
  log(`   [veo-hook] composed ${(statSync(outputPath).size / 1024 / 1024).toFixed(1)}MB, ${probeDur(outputPath).toFixed(1)}s -> ${outputPath}`);
  return { path: outputPath };
}

/**
 * Single entry point: generate a 60-70s MP4 from a product's images.
 *
 * @param {Object} product   - parsed Shopee product (must include _raw or product.image)
 * @param {string} outputPath
 * @param {Object} opts
 * @param {string} [opts.style="urgent"]
 * @param {boolean} [opts.mockVeo=false]
 * @param {Function} [opts.log=console.log]
 * @param {boolean} [opts.cleanup=true]
 * @returns {Promise<{path: string, veoTier: string|null, duration: number}>}
 */
export async function generateVeoHookVideo(product, outputPath, opts = {}) {
  const log = opts.log || console.log;
  const style = opts.style || "urgent";
  const workDir = join(dirname(outputPath), `veo_hook_${product.itemId}`);

  log(`\n🎬 [veo-hook] start: ${product.itemId} "${(product.name || "").slice(0, 40)}"`);

  // Step 1: images
  const images = await prepareImages(product, workDir, log);

  // Step 2: scripts (3 fields: veoHookPrompt, hookLine, extendedScript)
  const { veoHookPrompt, extendedScript } = await generateScripts(product, style, log);

  // Step 3: Veo Lite WITH product image reference (native audio + lip-sync for hookLine).
  // Pass images[0] as the visual anchor so Veo renders the actual product, not generic.
  const hookOut = join(workDir, "hook.mp4");
  const veoResult = await generateHookClip(veoHookPrompt, images[0], hookOut, {
    ...opts,
    veoModel: opts.veoModel || "lite",  // Veo 3.1 Lite default — cheap + native audio
    log,
  });
  const veoClip = veoResult.path || null;
  const veoTier = veoResult.model || null;

  // Step 4: Gemini TTS reads ONLY extendedScript (Veo handles hookLine for 0-8s)
  const voPath = join(workDir, "vo.mp3");
  const voResult = await generateVoiceover(extendedScript, style, voPath, { log });
  const extendedAudio = voResult.path;

  // Step 5: compose (Veo with native audio + slideshow with extended TTS + auto-loop)
  const targetDuration = opts.targetDuration || 35;
  await composeVideo({
    veoClip, images, extendedAudio, product, outputPath,
    log, pageName: opts.pageName || null, targetDuration,
  });

  // Step 6: cleanup intermediates (keep final output)
  if (opts.cleanup !== false) {
    try {
      run(`rmdir /s /q "${workDir.replace(/\//g, "\\")}" 2>nul`, 5_000);
    } catch {}
  }

  // Detect duration
  const ffprobePath = FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  const probe = run(`"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`, 10_000);
  const duration = parseFloat((probe.stdout || "0").trim()) || 60;

  log(`✅ [veo-hook] done: ${duration.toFixed(1)}s, tier=${veoTier || "kenburns"}`);
  return { path: outputPath, veoTier, duration };
}
