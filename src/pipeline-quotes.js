/**
 * Quotes Pipeline — End-to-end video creation and publishing.
 *
 * Flow:
 *   1. Select unused quotes from DB
 *   2. Generate narration script (Claude)
 *   3. Generate voiceover audio (ElevenLabs)
 *   4. Render video (FFmpeg: slideshow + voiceover)
 *   5. Upload & schedule on TikTok (PostFast)
 *   6. Update DB tracking
 *
 * Usage:
 *   node src/pipeline-quotes.js                    # Full pipeline
 *   node src/pipeline-quotes.js --dry-run          # Stop before publishing
 *   node src/pipeline-quotes.js --step=script      # Only generate script
 *   node src/pipeline-quotes.js --step=voiceover   # Script + voiceover
 *   node src/pipeline-quotes.js --step=render      # Up to video render
 */
import "./env.js";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";

import { getDb, getUnusedQuotes, markQuotesUsed, createVideoJob, updateVideoStatus, getActiveHashtags } from "./db.js";
import { writeScript } from "./script-writer.js";
import { generateVoiceover } from "./tts.js";
import { uploadVideo, schedulePost, getTikTokAccounts } from "./postfast.js";

const DRY_RUN = process.argv.includes("--dry-run");
const STEP = process.argv.find((a) => a.startsWith("--step="))?.split("=")[1];
const CATEGORY = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1];

const QUEUE_DIR = process.env.QUEUE_DIR || "./queue";
const NICHE = "quotes";

// Hashtag pool (fallback if DB pool is empty) — Vietnamese TikTok
const DEFAULT_HASHTAGS = {
  trending: ["#fyp", "#viral", "#xuhuong", "#trending"],
  niche_large: ["#motivation", "#donglucsong", "#truyencamhung", "#tuduysangtao", "#thanhcong"],
  niche_small: ["#caungoncuocsong", "#trietlysong", "#phattrienbantan", "#tuduytichcuc", "#ngontinh"],
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function pickHashtags() {
  // Try DB pool first
  const dbTags = getActiveHashtags(NICHE, 6);
  if (dbTags.length >= 4) {
    return dbTags.map((t) => t.tag);
  }

  // Fallback: pick from defaults
  const pick = (arr, n) => arr.sort(() => Math.random() - 0.5).slice(0, n);
  return [
    ...pick(DEFAULT_HASHTAGS.trending, 1),
    ...pick(DEFAULT_HASHTAGS.niche_large, 2),
    ...pick(DEFAULT_HASHTAGS.niche_small, 2),
  ];
}

function pickCategory() {
  if (CATEGORY) return CATEGORY;

  const categories = [
    "thành công và tham vọng",
    "kỷ luật và thói quen",
    "sức mạnh tinh thần",
    "vượt qua thất bại",
    "phát triển bản thân",
    "triết lý sống",
    "tư duy tài chính",
    "lãnh đạo và ảnh hưởng",
    "quản lý thời gian",
    "trí tuệ cảm xúc",
  ];
  return categories[Math.floor(Math.random() * categories.length)];
}

// --- Visual Themes ---
const THEMES = [
  { bg1: "0x0f0c29", bg2: "0x302b63", bg3: "0x24243e", accent: "0xf9d423" }, // Deep purple-gold
  { bg1: "0x1a1a2e", bg2: "0x16213e", bg3: "0x0f3460", accent: "0xe94560" }, // Navy-red
  { bg1: "0x0d1117", bg2: "0x161b22", bg3: "0x21262d", accent: "0x58a6ff" }, // Dark blue-cyan
  { bg1: "0x1b1b2f", bg2: "0x162447", bg3: "0x1f4068", accent: "0xe43f5a" }, // Midnight-pink
  { bg1: "0x2d1b69", bg2: "0x11001c", bg3: "0x200034", accent: "0xf39c12" }, // Purple-amber
];

const FONT_PATH = "./assets/fonts/Montserrat-Bold.ttf";
const FONT_SEMI = "./assets/fonts/Montserrat-SemiBold.ttf";

/**
 * Word-wrap text to fit within video width.
 * FFmpeg drawtext does NOT auto-wrap, so we must insert newlines manually.
 *
 * @param {string} text - Original text
 * @param {number} maxCharsPerLine - Max characters per line (~22-26 for fontsize 52 on 1080px with padding)
 * @returns {string} Text with newlines inserted at word boundaries
 */
function wrapText(text, maxCharsPerLine = 24) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxCharsPerLine && currentLine.length > 0) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += (currentLine ? " " : "") + word;
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join("\n");
}

/**
 * Generate premium video with gradient backgrounds, glow text, and fade transitions.
 *
 * Visual design:
 *   - Gradient background (top-to-bottom, theme colors)
 *   - Quote number indicator (1/4, 2/4...)
 *   - Decorative quote marks "
 *   - Text shadow/glow effect (draw text twice: blurred shadow + crisp text)
 *   - Fade in/out transitions between slides
 *   - Montserrat Bold font (supports Vietnamese)
 */
function renderVideo(audioPath, quotes, outputPath) {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });

  const durationStr = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
    { encoding: "utf-8" }
  ).trim();
  const totalDuration = parseFloat(durationStr);
  const segmentDuration = totalDuration / quotes.length;
  const fadeDuration = Math.min(0.6, segmentDuration * 0.1); // 10% of segment, max 0.6s

  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const fontPath = FONT_PATH.replace(/\\/g, "/").replace(/:/g, "\\:");
  const fontSemiPath = FONT_SEMI.replace(/\\/g, "/").replace(/:/g, "\\:");

  const filterParts = [];
  const inputs = [];
  const textFiles = []; // temp files for per-line textfile= approach

  for (let i = 0; i < quotes.length; i++) {
    // Split quote into lines, write each to separate file (avoids newline glyph bug)
    const lines = wrapText(quotes[i].text, 22).split("\n");
    const lineFiles = lines.map((line, li) => {
      const fp = `${QUEUE_DIR}/_q${Date.now()}_${i}_${li}.txt`;
      writeFileSync(fp, line.replace(/%/g, "%%"), "utf-8");
      textFiles.push(fp);
      return fp.replace(/\\/g, "/").replace(/:/g, "\\:");
    });

    inputs.push(
      `-f lavfi -i "color=c=${theme.bg1}:s=1080x1920:d=${segmentDuration}"`
    );

    const slideIdx = i;
    const quoteNum = `${i + 1}/${quotes.length}`;
    const fadeOut = segmentDuration - fadeDuration;

    // Calculate vertical positions for multi-line text (centered as a block)
    const lineHeight = 80; // fontsize 52 + line_spacing 28
    const totalTextHeight = lines.length * lineHeight;
    const startY = `(h-${totalTextHeight})/2`; // center the text block vertically

    // 1. Gradient: darken bottom half
    filterParts.push(
      `[${slideIdx}]drawbox=x=0:y=ih/2:w=iw:h=ih/2:color=black@0.3:t=fill[bg${slideIdx}]`
    );

    // 2. Decorative quote mark
    filterParts.push(
      `[bg${slideIdx}]drawtext=text='\u201C':` +
      `fontfile='${fontPath}':fontsize=120:fontcolor=${theme.accent}@0.3:` +
      `x=80:y=${startY}-100[deco${slideIdx}]`
    );

    // 3. Render each line separately (shadow + main text)
    let prevLabel = `deco${slideIdx}`;
    for (let li = 0; li < lines.length; li++) {
      const yPos = `${startY}+${li * lineHeight}`;
      const shadowLabel = `s${slideIdx}_${li}`;
      const textLabel = `t${slideIdx}_${li}`;

      // Shadow
      filterParts.push(
        `[${prevLabel}]drawtext=textfile='${lineFiles[li]}':` +
        `fontfile='${fontPath}':fontsize=52:fontcolor=black@0.5:` +
        `x=(w-text_w)/2+3:y=${yPos}+3[${shadowLabel}]`
      );

      // Main text
      filterParts.push(
        `[${shadowLabel}]drawtext=textfile='${lineFiles[li]}':` +
        `fontfile='${fontPath}':fontsize=52:fontcolor=white:` +
        `x=(w-text_w)/2:y=${yPos}[${textLabel}]`
      );

      prevLabel = textLabel;
    }

    // 4. Quote number indicator
    filterParts.push(
      `[${prevLabel}]drawtext=text='${quoteNum}':` +
      `fontfile='${fontSemiPath}':fontsize=28:fontcolor=${theme.accent}@0.6:` +
      `x=(w-text_w)/2:y=h-120[num${slideIdx}]`
    );

    // 5. Fade in + fade out
    filterParts.push(
      `[num${slideIdx}]fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${fadeOut}:d=${fadeDuration}[v${slideIdx}]`
    );
  }

  // Concatenate all slides
  const concatInputs = quotes.map((_, i) => `[v${i}]`).join("");
  filterParts.push(`${concatInputs}concat=n=${quotes.length}:v=1:a=0[slideshow]`);

  const filterComplex = filterParts.join(";\n");

  // Write filter to temp file to avoid shell escaping issues with multiline text
  const filterScriptPath = `${QUEUE_DIR}/_filter_${Date.now()}.txt`;
  writeFileSync(filterScriptPath, filterComplex, "utf-8");

  const cmd = [
    "ffmpeg -y",
    ...inputs,
    `-i "${audioPath}"`,
    `-filter_complex_script "${filterScriptPath}"`,
    `-map "[slideshow]" -map ${quotes.length}:a`,
    "-c:v libx264 -preset fast -crf 20 -r 30",
    "-c:a aac -b:a 128k",
    "-shortest",
    "-pix_fmt yuv420p",
    `"${outputPath}"`,
  ].join(" ");

  log(`Rendering video (${quotes.length} slides, ${totalDuration.toFixed(1)}s, theme: ${theme.accent})...`);
  try {
    execSync(cmd, { stdio: "pipe", timeout: 180000 });
  } finally {
    // Clean up temp files
    try { unlinkSync(filterScriptPath); } catch {}
    for (const tf of textFiles) {
      try { unlinkSync(tf); } catch {}
    }
  }

  return { duration: totalDuration, path: outputPath };
}

export async function runPipeline(opts = {}) {
  const jobId = `quotes-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const category = pickCategory();

  log(`=== Pipeline Start: ${jobId} ===`);
  log(`Category: ${category}`);
  log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  // --- Step 1: Select quotes ---
  log("Step 1: Selecting quotes...");
  const quotes = getUnusedQuotes(category, 4);
  if (quotes.length < 3) {
    log(`ERROR: Only ${quotes.length} unused quotes in "${category}". Need at least 3.`);
    return { success: false, error: "insufficient_quotes", category };
  }
  log(`Selected ${quotes.length} quotes from "${category}"`);

  // Create job in DB
  createVideoJob({
    job_id: jobId,
    status: "pending",
    niche: NICHE,
    content_ids: quotes.map((q) => q.id),
  });

  if (STEP === "select") {
    quotes.forEach((q) => console.log(`  - "${q.text}"`));
    return { success: true, step: "select", quotes };
  }

  // --- Step 2: Generate script ---
  log("Step 2: Generating script...");
  updateVideoStatus(jobId, "scripting");

  const scriptResult = await writeScript(quotes, {
    style: "inspirational",
    targetSeconds: 75,
  });

  log(`Script: ${scriptResult.estimatedSeconds}s, hook: "${scriptResult.hookLine.slice(0, 60)}..."`);
  updateVideoStatus(jobId, "scripted", { script: scriptResult.script });

  if (STEP === "script") {
    console.log("\n--- SCRIPT ---");
    console.log(scriptResult.script);
    console.log("\n--- CAPTION ---");
    console.log(scriptResult.caption);
    return { success: true, step: "script", scriptResult };
  }

  // --- Step 3: Generate voiceover ---
  log("Step 3: Generating voiceover...");
  updateVideoStatus(jobId, "rendering");

  const audioPath = `${QUEUE_DIR}/${jobId}-audio.mp3`;
  const voiceResult = await generateVoiceover(scriptResult.script, audioPath, {
    provider: opts.ttsProvider,
  });
  log(`Voiceover: ${(voiceResult.sizeBytes / 1024).toFixed(0)}KB`);

  if (STEP === "voiceover") {
    return { success: true, step: "voiceover", audioPath, voiceResult };
  }

  // --- Step 4: Render video ---
  log("Step 4: Rendering video...");
  const videoPath = `${QUEUE_DIR}/${jobId}.mp4`;
  const videoResult = renderVideo(audioPath, quotes, videoPath);
  log(`Video: ${videoResult.duration.toFixed(1)}s at ${videoPath}`);

  updateVideoStatus(jobId, "rendered", { video_path: videoPath });

  if (STEP === "render" || DRY_RUN) {
    log(`Pipeline stopped at ${STEP || "dry-run"}. Video saved to ${videoPath}`);
    return { success: true, step: STEP || "render", videoPath, videoResult };
  }

  // --- Step 5: Upload & schedule ---
  log("Step 5: Uploading to PostFast...");
  updateVideoStatus(jobId, "uploading");

  const accounts = await getTikTokAccounts();
  if (accounts.length === 0) {
    log("ERROR: No TikTok accounts connected in PostFast");
    updateVideoStatus(jobId, "failed");
    return { success: false, error: "no_tiktok_account" };
  }
  const account = accounts[0];

  const videoKey = await uploadVideo(videoPath);
  log(`Uploaded: ${videoKey}`);

  // Schedule for now (or calculate next optimal slot)
  const hashtags = pickHashtags();
  const caption = `${scriptResult.caption}\n\n${hashtags.join(" ")}`;
  const scheduledAt = new Date(Date.now() + 60_000).toISOString(); // 1 min from now

  const postResult = await schedulePost({
    socialMediaId: account.id,
    videoKey,
    caption,
    scheduledAt,
  });

  log(`Scheduled: post ${postResult.postIds[0]} at ${scheduledAt}`);

  // --- Step 6: Update tracking ---
  markQuotesUsed(quotes.map((q) => q.id));
  updateVideoStatus(jobId, "posted", {
    tiktok_post_id: postResult.postIds[0],
    caption,
    hashtags: JSON.stringify(hashtags),
    posted_at: new Date().toISOString(),
  });

  log(`=== Pipeline Complete: ${jobId} ===`);
  return {
    success: true,
    jobId,
    postId: postResult.postIds[0],
    videoPath,
    duration: videoResult.duration,
    category,
    hashtags,
  };
}

// CLI entry point
if (process.argv[1]?.endsWith("pipeline-quotes.js")) {
  runPipeline()
    .then((result) => {
      console.log("\nResult:", JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
