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
import { FFMPEG } from "./config.mjs";
import { generateVideo, pickAvailableModel } from "../veo.js";

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

  const prompt = `Bạn là creative director cho video bán hàng Shopee.

Sản phẩm: "${productName}"
Giá: ${price}
Style: ${styleDesc}

Tạo 2 thứ:

1. veoHookPrompt — prompt tiếng Anh ngắn (≤ 300 ký tự) cho AI Veo tạo clip cinematic 8s, 9:16 vertical, mô tả close-up sản phẩm context tự nhiên. KHÔNG có text hay logo trong scene.

2. voiceoverScript — script tiếng Việt 150–180 từ (đọc 60–65 giây), gồm:
   - Hook 1 câu (gây tò mò)
   - 3 lý do nên mua (mỗi cái 1–2 câu, nhấn vào đặc điểm sản phẩm)
   - Giá ${price}
   - CTA "Mua ngay link dưới"

Trả về JSON đúng format:
{"veoHookPrompt":"...","voiceoverScript":"..."}

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
    if (!parsed.veoHookPrompt || !parsed.voiceoverScript) {
      throw new Error("missing fields");
    }
    log(`   [veo-hook] script OK (vo=${parsed.voiceoverScript.length} chars)`);
    return parsed;
  } catch (e) {
    log(`   [veo-hook] Claude fail (${e.message?.slice(0, 60)}) — using template`);
    return {
      veoHookPrompt: `Cinematic close-up of ${productName.slice(0, 60)}, dramatic lighting, slow zoom, 9:16 vertical, no text`,
      voiceoverScript:
        `Bạn đã thấy ${productName.slice(0, 60)} chưa? Đây là sản phẩm bán chạy nhất tuần này. ` +
        `Thứ nhất, chất lượng tốt, đáng đồng tiền. Thứ hai, nhiều người mua đã đánh giá 5 sao. ` +
        `Thứ ba, ưu đãi đang giảm sâu. Giá chỉ ${price}. Mua ngay link bên dưới, đừng bỏ lỡ!`,
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

  // Quota gate: only allow fast | standard for shopee hook.
  const modelKey = pickAvailableModel();
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
