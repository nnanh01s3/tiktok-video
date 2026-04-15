/**
 * Generate TikTok cover image for a Rừng Xì Tin episode.
 *
 * Flow:
 *   1. Parse episode markdown → characters + title + episode number
 *   2. Build cover-specific prompt (hero pose, reserved banner areas)
 *   3. Inject lineup + character references (consistency)
 *   4. Generate via gemini-2.5-flash-image
 *   5. FFmpeg crop to 1080x1920
 *   6. FFmpeg drawtext top banner "RUNG XI TIN" + bottom banner "TAP N: TITLE"
 *
 * Usage:
 *   node vung/src/gen-cover.mjs --episode tap_03_ngay_song_ao.md
 *   node vung/src/gen-cover.mjs --episode tap_03_ngay_song_ao.md --force
 */
import "../../src/env.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname } from "path";
import { spawnSync } from "child_process";
import { getClient, markKeyExhausted } from "./gemini-keys.js";
import { parseEpisode } from "./scene-parser.mjs";

const MODEL = "gemini-2.5-flash-image";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FONT_BOLD = "D:/tiktok/assets/fonts/Montserrat-Bold.ttf";
const FONT_SEMI = "D:/tiktok/assets/fonts/Montserrat-SemiBold.ttf";
const REFERENCE_DIR = "D:/tiktok/vung/nhan_vat/canonical";
const REFERENCE_MAP = {
  momo: "momo.png",
  tiko: "tiko.png",
  lala: "lala.png",
  bobo: "bobo.png",
};
const LINEUP_PATH = `${REFERENCE_DIR}/lineup.png`;
const PROMPT_RULES_PATH = "D:/tiktok/vung/inputs/prompt_rules.md";

// ── Load prompt rules (same format as scene-renderer) ──
function loadPromptRules() {
  if (!existsSync(PROMPT_RULES_PATH)) return {};
  const content = readFileSync(PROMPT_RULES_PATH, "utf8");
  const rules = {};
  const re = /^## (\w+)\s*\n\n([\s\S]*?)(?=\n## |\n---|\s*$)/gm;
  let m;
  while ((m = re.exec(content))) rules[m[1].trim()] = m[2].trim();
  return rules;
}
const RULES = loadPromptRules();

// ── CLI args ──
const args = process.argv.slice(2);
const episodeArg = args.includes("--episode")
  ? args[args.indexOf("--episode") + 1]
  : null;
const forceFlag = args.includes("--force");
if (!episodeArg) {
  console.error("Usage: node vung/src/gen-cover.mjs --episode <file.md> [--force]");
  process.exit(1);
}

// ── Unicode → ASCII without diacritics (for banner text) ──
function removeDiacritics(s) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// ── Build cover-specific prompt ──
function buildCoverPrompt(episode) {
  // Characters in the episode (from all scenes, deduplicated)
  const allChars = new Set();
  for (const scene of episode.scenes) {
    for (const c of scene.characters) {
      if (c !== "narrator") allChars.add(c);
    }
  }
  const charList = [...allChars];

  // Take a "theme hook" from scene 2-3 (the story setup, not the intro template)
  // Fallback to episode title if scenes don't have good breakdown
  const themeScene = episode.scenes[1] || episode.scenes[0];
  const themeHint = (themeScene?.breakdown?.[0] || themeScene?.goal || "")
    .slice(0, 300)
    .replace(/\s+/g, " ")
    .trim();

  const header = RULES.COVER_HEADER ||
    "Dynamic Pixar 3D cartoon cover art. Keep TOP 220px and BOTTOM 260px uncluttered for text banners. 9:16 vertical.";

  const charDescription = charList.length > 0
    ? `Feature these characters: ${charList.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(", ")}. Each character appears EXACTLY ONCE (no duplicates).`
    : "";

  const themeLine = themeHint
    ? `Episode theme hint (for pose/background context): ${themeHint}`
    : "";

  const episodeTitleLine = `The cover represents the story "${episode.episodeTitle}". Compose a visual hook that makes viewers curious about this episode.`;

  const negative = RULES.COVER_NEGATIVE ||
    "Avoid: humans, text, watermarks, duplicates, clothing";

  return [
    header,
    charDescription,
    episodeTitleLine,
    themeLine,
    "Central subject, eye-catching hero pose, dramatic lighting.",
    "ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS in the image.",
    negative,
  ].filter(Boolean).join(" ");
}

// ── Generate cover image via Gemini Image ──
async function generateCoverImage(episode, outputPath) {
  if (existsSync(outputPath) && !forceFlag) {
    console.log(`[Cover] Exists, skipping (use --force to regenerate): ${outputPath}`);
    return outputPath;
  }

  // Build reference parts: lineup first, then per-character PNGs
  const refParts = [];
  if (existsSync(LINEUP_PATH)) {
    refParts.push({
      inlineData: { data: readFileSync(LINEUP_PATH).toString("base64"), mimeType: "image/png" },
    });
  }
  const allChars = new Set();
  for (const scene of episode.scenes) {
    for (const c of scene.characters) {
      if (c !== "narrator" && REFERENCE_MAP[c]) allChars.add(c);
    }
  }
  for (const c of allChars) {
    const p = `${REFERENCE_DIR}/${REFERENCE_MAP[c]}`;
    if (existsSync(p)) {
      refParts.push({
        inlineData: { data: readFileSync(p).toString("base64"), mimeType: "image/png" },
      });
    }
  }

  const prompt = buildCoverPrompt(episode);
  console.log(`[Cover] Characters in episode: ${[...allChars].join(", ")}`);
  console.log(`[Cover] Prompt: "${prompt.slice(0, 120)}..."`);
  console.log(`[Cover] References loaded: ${refParts.length} (lineup + chars)`);

  const maxAttempts = 15;
  let lastErr;
  let buffer;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = getClient("imagen");
    if (!handle) throw new Error("All imagen keys exhausted");
    try {
      const res = await handle.client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }, ...refParts] }],
        config: { responseModalities: ["IMAGE"] },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part?.inlineData?.data) throw new Error("Model returned no image");
      buffer = Buffer.from(part.inlineData.data, "base64");
      break;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "").toLowerCase();
      if (err?.status === 429 || msg.includes("quota") || msg.includes("resource_exhausted")) {
        markKeyExhausted(handle.keyId, "imagen");
        continue;
      }
      if (msg.includes("returned no") || msg.includes("503") || msg.includes("unavailable")) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  if (!buffer) throw lastErr || new Error("Cover generation failed");

  // Save raw (1024x1024 from Gemini)
  const rawPath = outputPath.replace(/\.png$/, "_raw.png");
  writeFileSync(rawPath, buffer);

  // Crop to 1080x1920 (fill, no black bars)
  const cropCmd = [
    `${FFMPEG} -y -i "${rawPath}"`,
    `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"`,
    `"${outputPath}"`,
  ].join(" ");
  const r = spawnSync(cropCmd, { shell: true, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) {
    console.log(`[Cover] ⚠ Crop failed, using raw`);
    writeFileSync(outputPath, buffer);
  } else {
    console.log(`[Cover] ✅ Cropped to 1080x1920`);
  }
  try { unlinkSync(rawPath); } catch {}
  return outputPath;
}

// ── Escape for FFmpeg drawtext ──
function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%");
}
function escapePath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// ── Add top + bottom text banners ──
function addTextBanners(inputPath, outputPath, episode) {
  const topBanner = (RULES.COVER_TOP_BANNER || "RUNG XI TIN").trim();
  const bottomTemplate = (RULES.COVER_BOTTOM_BANNER_TEMPLATE || "TAP {episode}: {title}").trim();
  // Montserrat-Bold supports Vietnamese diacritics natively — keep tiếng Việt có dấu.
  const bottomBanner = bottomTemplate
    .replace("{episode}", String(episode.episodeNumber).padStart(2, "0"))
    .replace("{title}", episode.episodeTitle.toUpperCase());

  const fontBold = escapePath(FONT_BOLD);
  const fontSemi = escapePath(FONT_SEMI);
  const top = escapeDrawtext(topBanner);
  const bottom = escapeDrawtext(bottomBanner);

  // Auto-shrink bottom banner fontsize based on length to fit 1080px width.
  // Empirical: ~34px/char at fontsize=64 for Montserrat-Bold uppercase.
  // Keep 80px padding each side → usable = 920px.
  // Formula: targetFontsize = min(64, 920 * 64 / (chars * 34))
  const bottomLen = bottomBanner.length;
  const estWidth = bottomLen * 34; // at fontsize 64
  const bottomFontsize = estWidth > 920
    ? Math.max(36, Math.floor(64 * 920 / estWidth))
    : 64;

  // Top banner: bold gold on dark semi-transparent box at top
  // Bottom banner: bold gold on dark semi-transparent box at bottom
  const filterBody = [
    // Top dark band + text
    `drawbox=x=0:y=0:w=iw:h=200:color=black@0.55:t=fill`,
    `drawtext=fontfile='${fontBold}':text='${top}':` +
      `fontsize=84:fontcolor=#FFE08A:` +
      `x=(w-text_w)/2:y=55:` +
      `borderw=4:bordercolor=black@0.9:` +
      `shadowcolor=black@0.7:shadowx=3:shadowy=3`,
    // Bottom dark band + text (auto-shrink fontsize for long titles)
    `drawbox=x=0:y=h-240:w=iw:h=240:color=black@0.55:t=fill`,
    `drawtext=fontfile='${fontBold}':text='${bottom}':` +
      `fontsize=${bottomFontsize}:fontcolor=#FFE08A:` +
      `x=(w-text_w)/2:y=h-160:` +
      `borderw=4:bordercolor=black@0.9:` +
      `shadowcolor=black@0.7:shadowx=3:shadowy=3`,
  ].join(",");
  const filter = `[0:v]${filterBody}[vout]`;

  const filterFile = outputPath.replace(/\.png$/, "_banners.txt");
  writeFileSync(filterFile, filter);

  const cmd = [
    `${FFMPEG} -y -i "${inputPath}"`,
    `-filter_complex_script "${filterFile}"`,
    `-map "[vout]"`,
    `"${outputPath}"`,
  ].join(" ");
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 60_000 });
  try { unlinkSync(filterFile); } catch {}
  if (r.status !== 0) {
    console.log(`[Cover] ⚠ Banner overlay failed:`, (r.stderr || "").slice(-300));
    throw new Error("FFmpeg banner overlay failed");
  }
  console.log(`[Cover] ✅ Banners applied: top="${topBanner}" bottom="${bottomBanner}"`);
  return outputPath;
}

// ── Main ──
async function main() {
  // Resolve episode path
  const candidates = [
    `D:/tiktok/vung/${episodeArg}`,
    `D:/tiktok/vung/${episodeArg}.md`,
  ];
  const episodePath = candidates.find((p) => existsSync(p));
  if (!episodePath) throw new Error(`Episode file not found: ${episodeArg}`);

  console.log(`\n🎨 Generating cover for: ${episodePath}\n`);
  const episode = parseEpisode(episodePath);
  console.log(`   Tập ${episode.episodeNumber}: "${episode.episodeTitle}"`);
  console.log(`   Scenes: ${episode.scenes.length}\n`);

  const tapSlug = `tap_${String(episode.episodeNumber).padStart(2, "0")}`;
  const outputDir = `D:/tiktok/vung/output/${tapSlug}`;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const rawCover = `${outputDir}/cover_raw.png`;
  const finalCover = `${outputDir}/cover.png`;

  // Step 1: Generate image via Gemini
  await generateCoverImage(episode, rawCover);

  // Step 2: Apply text banners
  addTextBanners(rawCover, finalCover, episode);
  try { unlinkSync(rawCover); } catch {}

  console.log(`\n✅ Cover saved: ${finalCover}\n`);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
