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
