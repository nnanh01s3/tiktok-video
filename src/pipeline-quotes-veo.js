/**
 * Quotes Pipeline with Veo 3.1 — Cinematic AI-generated videos.
 *
 * Flow:
 *   1. Select unused quotes from DB
 *   2. Generate narration script (Claude) in Vietnamese
 *   3. Generate voiceover audio (ElevenLabs/Edge TTS)
 *   4. Generate scene videos with Veo 3.1 (one 8s clip per quote)
 *   5. Compose final video: slow-mo clips + text overlay + voiceover (FFmpeg)
 *   6. Upload & schedule on TikTok (PostFast)
 *   7. Update DB tracking
 *
 * Usage:
 *   node src/pipeline-quotes-veo.js                      # Full pipeline
 *   node src/pipeline-quotes-veo.js --dry-run             # Stop before publishing
 *   node src/pipeline-quotes-veo.js --step=veo            # Up to Veo generation
 *   node src/pipeline-quotes-veo.js --step=render         # Up to final render
 *   node src/pipeline-quotes-veo.js --category="triết lý sống"
 */
import "./env.js";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { execSync, spawn } from "child_process";

import { getUnusedQuotes, markQuotesUsed, createVideoJob, updateVideoStatus, getActiveHashtags } from "./db.js";
import { writeScript, writeDirectorScript } from "./script-writer.js";
import { generateVoiceover } from "./tts.js";
import { generateVideo, buildScenePrompts, pickAvailableModel } from "./veo.js";
import { generateImage } from "./imagen.js";
import { uploadVideo, schedulePost, getTikTokAccounts } from "./postfast.js";

const DRY_RUN = process.argv.includes("--dry-run");
const STEP = process.argv.find((a) => a.startsWith("--step="))?.split("=")[1];
const CATEGORY = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1];
const VEO_MODEL = process.argv.find((a) => a.startsWith("--veo="))?.split("=")[1] || "fast";

const QUEUE_DIR = process.env.QUEUE_DIR || "./queue";
const NICHE = "quotes";
const FONT_PATH = "./assets/fonts/Montserrat-Bold.ttf";
const FONT_SEMI = "./assets/fonts/Montserrat-SemiBold.ttf";
const LOGO_PATH = "./assets/branding/avatar.png";

// Vietnamese hashtags
const DEFAULT_HASHTAGS = {
  trending: ["#fyp", "#viral", "#xuhuong", "#trending"],
  niche_large: ["#motivation", "#donglucsong", "#truyencamhung", "#tuduysangtao", "#thanhcong"],
  niche_small: ["#caungoncuocsong", "#trietlysong", "#phattrienbantan", "#tuduytichcuc", "#ngontinh"],
};

const CATEGORIES = [
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

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function pickCategory() {
  if (CATEGORY) return CATEGORY;
  return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
}

function pickHashtags() {
  const dbTags = getActiveHashtags(NICHE, 6);
  if (dbTags.length >= 4) return dbTags.map((t) => t.tag);
  const pick = (arr, n) => arr.sort(() => Math.random() - 0.5).slice(0, n);
  return [...pick(DEFAULT_HASHTAGS.trending, 1), ...pick(DEFAULT_HASHTAGS.niche_large, 2), ...pick(DEFAULT_HASHTAGS.niche_small, 2)];
}

/**
 * Word-wrap text for overlay.
 */
function wrapText(text, maxCharsPerLine = 22) {
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
  return lines;
}

const CHANNEL_NAME = "Trí Tuệ Mỗi Ngày";
const GAP_DURATION = 1.5; // seconds of black gap between slides

/**
 * Compose final video from Veo clips + text overlay + voiceover.
 *
 * Features:
 *   - Each Veo clip slowed to match voiceover segment duration
 *   - Veo ambient audio mixed at low volume under voiceover
 *   - 1.5s black gap between slides (breathing room)
 *   - Text overlay per clip with shadow
 *   - Channel name watermark (bottom)
 *   - Author attribution under quote
 *   - Target: 60s+ for Creator Rewards
 */
async function composeVideo(veoClips, quotes, audioPath, outputPath, hookClipPath = null, titleText = null) {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });

  const hasHook = hookClipPath && existsSync(hookClipPath);
  const hasTitle = !!titleText;
  const HOOK_DURATION = 8; // Veo hook is 8 seconds
  const TITLE_DURATION = 1.5; // Title slide duration

  // Get total audio duration
  const durationStr = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
    { encoding: "utf-8" }
  ).trim();
  const totalAudioDuration = parseFloat(durationStr);

  // With xfade transitions, each crossfade OVERLAPS and shortens total video.
  // Formula accounts for optional title slide + hook clip at the start.
  const XFADE_DURATION_CALC = 1.2;
  const OUTRO_XFADE = 0.8;
  const titleXfade = hasTitle ? 0.5 : 0; // Short xfade for title → next
  const hookXfade = hasHook ? XFADE_DURATION_CALC : 0;
  const xfadeOverlapTotal = (quotes.length - 1) * XFADE_DURATION_CALC + OUTRO_XFADE + hookXfade + titleXfade;
  const targetVideoDuration = totalAudioDuration + 2.0;
  // Distribute remaining time to quote slides (subtract hook duration if present)
  // Title slide is EXTRA time — does not reduce quote slide duration
  const distributableTime = targetVideoDuration + xfadeOverlapTotal - GAP_DURATION
    - (hasHook ? HOOK_DURATION : 0);
  const segmentDuration = distributableTime / quotes.length;
  // Title adds net time (title duration minus xfade overlap)
  const totalDuration = targetVideoDuration + (hasTitle ? TITLE_DURATION - titleXfade : 0);

  if (hasTitle) {
    log(`Title slide: ${TITLE_DURATION}s (xfade ${titleXfade}s)`);
  }
  if (hasHook) {
    log(`Hook clip: ${HOOK_DURATION}s → quote slides: ${segmentDuration.toFixed(1)}s each`);
  }

  // Slowdown: stretch 8s/10s clip to fill segment duration
  const slowFactor = 8 / segmentDuration;

  const fontPath = FONT_PATH.replace(/\\/g, "/").replace(/:/g, "\\:");
  const fontSemiPath = FONT_SEMI.replace(/\\/g, "/").replace(/:/g, "\\:");

  const filterParts = [];
  const inputs = [];
  const textFiles = [];

  // Input 0: Title slide background (if present) — blurred frame from hook/first clip
  let inputOffset = 0;
  if (hasTitle) {
    const titleBgSource = hookClipPath && existsSync(hookClipPath) ? hookClipPath : veoClips[0];
    inputs.push(`-i "${titleBgSource}"`);
    inputOffset++;
  }

  // Next input: Hook clip (if present)
  const hookInputIdx = inputOffset; // remember hook's input index
  if (hasHook) {
    inputs.push(`-i "${hookClipPath}"`);
    inputOffset++;
  }

  // Inputs: Veo/Imagen clips + voiceover + gap + logo
  for (let i = 0; i < veoClips.length; i++) {
    inputs.push(`-i "${veoClips[i]}"`);
  }
  inputs.push(`-i "${audioPath}"`);
  const voiceIdx = inputOffset + veoClips.length;

  inputs.push(`-f lavfi -i "color=c=black:s=1080x1920:d=${GAP_DURATION}"`);
  const gapIdx = inputOffset + veoClips.length + 1;

  inputs.push(`-i "${LOGO_PATH}"`);
  const logoIdx = inputOffset + veoClips.length + 2;

  // --- Title slide filter (if present) ---
  if (hasTitle) {
    // Wrap title text for display (max ~18 chars per line for big font)
    const titleLines = wrapText(titleText, 16);
    const titleLineHeight = 90;
    const titleTotalH = titleLines.length * titleLineHeight;
    const titleStartY = `(h-${titleTotalH})/2`;
    const titleFontPath = fontPath;

    // Extract first frame from hook/veo clip → loop to fill title duration → blur for cinematic bg
    const titleLoopFrames = Math.ceil(TITLE_DURATION * 30);
    filterParts.push(
      `[0:v]fps=30,scale=1080:1920:flags=bilinear,trim=duration=0.1,setpts=PTS-STARTPTS,` +
      `loop=loop=${titleLoopFrames}:size=1:start=0,trim=duration=${TITLE_DURATION},setpts=PTS-STARTPTS,` +
      `boxblur=12:12,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.4:t=fill[title_bg]`
    );
    let titleLabel = "title_bg";
    for (let ti = 0; ti < titleLines.length; ti++) {
      const tLine = titleLines[ti].replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/,/g, "\\,");
      const tY = `${titleStartY}+${ti * titleLineHeight}`;
      const outLabel = `title_l${ti}`;
      // Shadow — visible immediately (no fade-in)
      filterParts.push(
        `[${titleLabel}]drawtext=text='${tLine}':` +
        `fontfile='${titleFontPath}':fontsize=64:fontcolor=black@0.5:` +
        `x=(w-text_w)/2+3:y=${tY}+3[title_s${ti}]`
      );
      // Main text — visible immediately (no fade-in)
      filterParts.push(
        `[title_s${ti}]drawtext=text='${tLine}':` +
        `fontfile='${titleFontPath}':fontsize=64:fontcolor=white:` +
        `x=(w-text_w)/2:y=${tY}[${outLabel}]`
      );
      titleLabel = outLabel;
    }
    // Channel name at bottom of title slide
    filterParts.push(
      `[${titleLabel}]drawtext=text='${CHANNEL_NAME}':` +
      `fontfile='${fontSemiPath}':fontsize=26:fontcolor=white@0.5:` +
      `x=(w-text_w)/2:y=h-120[title]`
    );
  }

  // --- Hook clip filter (if present) ---
  if (hasHook) {
    // Scale + trim hook to exactly 8s
    filterParts.push(
      `[${hookInputIdx}:v]fps=30,scale=1080:1920:flags=bilinear,trim=duration=${HOOK_DURATION},setpts=PTS-STARTPTS[hook]`
    );
  }

  for (let i = 0; i < quotes.length; i++) {
    const lines = wrapText(quotes[i].text, 22);
    const lineFiles = lines.map((line, li) => {
      const fp = `${QUEUE_DIR}/_vq${Date.now()}_${i}_${li}.txt`;
      writeFileSync(fp, line.replace(/%/g, "%%"), "utf-8");
      textFiles.push(fp);
      return fp.replace(/\\/g, "/").replace(/:/g, "\\:");
    });

    const quoteNum = `${i + 1}/${quotes.length}`;
    const authorName = quotes[i].author && quotes[i].author !== "Original" ? quotes[i].author : "";
    const sourceWork = quotes[i].source_work || "";
    const author = authorName ? (sourceWork ? `— ${authorName}, ${sourceWork}` : `— ${authorName}`) : "";
    const fadeDuration = Math.min(0.8, segmentDuration * 0.1);
    const fadeOut = segmentDuration - fadeDuration;

    // 1. Scale to 1080x1920 + normalize fps + slow-mo + trim
    const clipIdx = i + inputOffset; // Shift index if hook clip is present
    filterParts.push(
      `[${clipIdx}:v]fps=30,scale=1080:1920:flags=bilinear,setpts=PTS/${slowFactor.toFixed(4)},trim=duration=${segmentDuration.toFixed(3)},setpts=PTS-STARTPTS[slow${i}]`
    );

    // 1b. Slow-mo Veo AUDIO (ambient sound) + lower volume — only if clip has audio
    const hasAudio = (() => {
      try {
        const probe = execSync(
          `ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${veoClips[i]}"`,
          { encoding: "utf-8" }
        ).trim();
        return probe.length > 0;
      } catch { return false; }
    })();

    if (hasAudio) {
      filterParts.push(
        `[${clipIdx}:a]atempo=${Math.max(0.5, slowFactor).toFixed(4)},volume=0.15,atrim=duration=${segmentDuration.toFixed(3)},asetpts=PTS-STARTPTS[veoaud${i}]`
      );
    }

    // 2. Semi-transparent overlay for text readability (light enough to see video behind)
    filterParts.push(
      `[slow${i}]drawbox=x=0:y=ih*0.3:w=iw:h=ih*0.45:color=black@0.25:t=fill[dark${i}]`
    );

    // 3. Decorative quote mark
    const lineHeight = 80;
    const totalTextHeight = lines.length * lineHeight;
    const startY = `(h-${totalTextHeight})/2`;

    filterParts.push(
      `[dark${i}]drawtext=text='\u201C':` +
      `fontfile='${fontPath}':fontsize=100:fontcolor=white@0.25:` +
      `x=80:y=${startY}-80[deco${i}]`
    );

    // 4. Per-line text overlay with RANDOM ANIMATION
    const TEXT_ANIMATIONS = ["fade_in", "slide_up", "typewriter", "slide_left", "pop"];
    const animType = TEXT_ANIMATIONS[Math.floor(Math.random() * TEXT_ANIMATIONS.length)];
    log(`    Text animation: ${animType}`);

    let prevLabel = `deco${i}`;
    for (let li = 0; li < lines.length; li++) {
      const yPos = `${startY}+${li * lineHeight}`;
      const sLabel = `s${i}_${li}`;
      const tLabel = `t${i}_${li}`;
      const lineDelay = li * 0.25; // stagger per line

      // Animation expressions (t = time from clip start)
      let alphaExpr, xExpr, yExprAnim, shadowAlpha, shadowX, shadowY;

      switch (animType) {
        case "fade_in":
          alphaExpr = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.8,1))`;
          xExpr = "(w-text_w)/2";
          yExprAnim = yPos;
          shadowAlpha = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.8,0.6))`;
          shadowX = "(w-text_w)/2+2";
          shadowY = `${yPos}+2`;
          break;
        case "slide_up":
          alphaExpr = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.6,1))`;
          xExpr = "(w-text_w)/2";
          yExprAnim = `if(lt(t,${lineDelay}),${yPos}+120,${yPos}+120*(1-min((t-${lineDelay})/0.6,1)))`;
          shadowAlpha = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.6,0.6))`;
          shadowX = "(w-text_w)/2+2";
          shadowY = `if(lt(t,${lineDelay}),${yPos}+122,${yPos}+2+120*(1-min((t-${lineDelay})/0.6,1)))`;
          break;
        case "typewriter":
          // Line-by-line reveal with longer stagger
          const typeDelay = li * 0.5;
          alphaExpr = `if(lt(t,${typeDelay}),0,min((t-${typeDelay})/0.3,1))`;
          xExpr = "(w-text_w)/2";
          yExprAnim = yPos;
          shadowAlpha = `if(lt(t,${typeDelay}),0,min((t-${typeDelay})/0.3,0.6))`;
          shadowX = "(w-text_w)/2+2";
          shadowY = `${yPos}+2`;
          break;
        case "slide_left":
          alphaExpr = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.5,1))`;
          xExpr = `if(lt(t,${lineDelay}),w,(w-text_w)/2+(w-(w-text_w)/2)*(1-min((t-${lineDelay})/0.5,1)))`;
          yExprAnim = yPos;
          shadowAlpha = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.5,0.6))`;
          shadowX = `if(lt(t,${lineDelay}),w+2,(w-text_w)/2+2+(w-(w-text_w)/2)*(1-min((t-${lineDelay})/0.5,1)))`;
          shadowY = `${yPos}+2`;
          break;
        case "pop":
          // Fontsize scales up from 0 → overshoot → settle
          alphaExpr = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.3,1))`;
          xExpr = "(w-text_w)/2";
          yExprAnim = yPos;
          shadowAlpha = `if(lt(t,${lineDelay}),0,min((t-${lineDelay})/0.3,0.6))`;
          shadowX = "(w-text_w)/2+2";
          shadowY = `${yPos}+2`;
          break;
      }

      // Escape commas for FFmpeg filter_complex expressions
      const esc = (s) => String(s).replace(/,/g, "\\,");

      // Shadow (use alpha parameter for animated opacity)
      filterParts.push(
        `[${prevLabel}]drawtext=textfile='${lineFiles[li]}':` +
        `fontfile='${fontPath}':fontsize=52:fontcolor=black@0.6:` +
        `alpha=${esc(alphaExpr)}:` +
        `x=${esc(shadowX)}:y=${esc(shadowY)}[${sLabel}]`
      );
      // Main text
      filterParts.push(
        `[${sLabel}]drawtext=textfile='${lineFiles[li]}':` +
        `fontfile='${fontPath}':fontsize=52:fontcolor=white:` +
        `alpha=${esc(alphaExpr)}:` +
        `x=${esc(xExpr)}:y=${esc(yExprAnim)}[${tLabel}]`
      );
      prevLabel = tLabel;
    }

    // 5. Author attribution (if available)
    if (author) {
      const authorY = `${startY}+${lines.length * lineHeight}+20`;
      filterParts.push(
        `[${prevLabel}]drawtext=text='${author.replace(/'/g, "\u2019")}':` +
        `fontfile='${fontSemiPath}':fontsize=30:fontcolor=white@0.6:` +
        `x=(w-text_w)/2:y=${authorY}[auth${i}]`
      );
      prevLabel = `auth${i}`;
    }

    // 6. Quote number + channel name
    filterParts.push(
      `[${prevLabel}]drawtext=text='${quoteNum}':` +
      `fontfile='${fontSemiPath}':fontsize=28:fontcolor=white@0.5:` +
      `x=(w-text_w)/2:y=h-140[num${i}]`
    );
    filterParts.push(
      `[num${i}]drawtext=text='${CHANNEL_NAME}':` +
      `fontfile='${fontSemiPath}':fontsize=22:fontcolor=white@0.35:` +
      `x=(w-text_w)/2:y=h-100[ch${i}]`
    );

    // 7. Label for concat/xfade (no individual fade — xfade handles transitions)
    filterParts.push(
      `[ch${i}]copy[v${i}]`
    );
  }

  // Crossfade transitions — diverse types for visual variety
  const XFADE_DURATION = 1.2;
  const XFADE_TYPES = [
    "fade", "fadeblack", "fadewhite",
    "slideleft", "slideright", "slideup", "slidedown",
    "wipeleft", "wiperight", "wipeup", "wipedown",
    "dissolve", "smoothleft", "smoothright", "smoothup", "smoothdown",
    "circlecrop", "circleopen", "circleclose",
    "radial", "horzopen", "horzclose", "vertopen", "vertclose",
  ];
  const pickTransition = () => XFADE_TYPES[Math.floor(Math.random() * XFADE_TYPES.length)];

  if (quotes.length === 1 && !hasHook && !hasTitle) {
    filterParts.push(`[v0]copy[prefinal]`);
  } else {
    // Build transition chain: [title] → [hook] → [v0] → [v1] → ... → [outro]
    // Title uses smooth dissolve/fade for an impressive opening
    const TITLE_XFADE_TYPES = ["dissolve", "fade", "fadeblack", "radial", "circleopen"];
    const pickTitleTransition = () => TITLE_XFADE_TYPES[Math.floor(Math.random() * TITLE_XFADE_TYPES.length)];

    let prevLabel = hasTitle ? "title" : (hasHook ? "hook" : "v0");
    let cumulativeOffset = 0;

    if (hasTitle) {
      // Title → next (hook or v0)
      const titleOffset = TITLE_DURATION - titleXfade;
      const nextLabel = hasHook ? "hook" : "v0";
      const titleTrans = pickTitleTransition();
      log(`    Transition title→${nextLabel}: ${titleTrans}`);
      filterParts.push(
        `[title][${nextLabel}]xfade=transition=${titleTrans}:duration=${titleXfade.toFixed(1)}:offset=${titleOffset.toFixed(3)}[txf]`
      );
      prevLabel = "txf";
      if (hasHook) {
        cumulativeOffset = titleOffset + HOOK_DURATION - XFADE_DURATION;
      } else {
        cumulativeOffset = titleOffset + segmentDuration - XFADE_DURATION;
      }
    }

    if (hasHook && !hasTitle) {
      // Hook → v0 (no title before it)
      const hookOffset = HOOK_DURATION - XFADE_DURATION;
      const hookTrans = pickTransition();
      log(`    Transition hook→v0: ${hookTrans}`);
      filterParts.push(
        `[hook][v0]xfade=transition=${hookTrans}:duration=${XFADE_DURATION.toFixed(1)}:offset=${hookOffset.toFixed(3)}[hxf]`
      );
      prevLabel = "hxf";
      cumulativeOffset = hookOffset + segmentDuration - XFADE_DURATION;
    } else if (hasHook && hasTitle) {
      // Title already xfaded into hook → now hook→v0
      const hookTrans = pickTransition();
      log(`    Transition hook→v0: ${hookTrans}`);
      filterParts.push(
        `[txf][v0]xfade=transition=${hookTrans}:duration=${XFADE_DURATION.toFixed(1)}:offset=${cumulativeOffset.toFixed(3)}[hxf]`
      );
      prevLabel = "hxf";
      cumulativeOffset += segmentDuration - XFADE_DURATION;
    } else if (!hasHook && !hasTitle) {
      cumulativeOffset = segmentDuration - XFADE_DURATION;
    }

    for (let i = 1; i < quotes.length; i++) {
      const xfLabel = i < quotes.length - 1 ? `xf${i}` : `preoutro`;
      const trans = pickTransition();
      log(`    Transition v${i-1}→v${i}: ${trans}`);
      filterParts.push(
        `[${prevLabel}][v${i}]xfade=transition=${trans}:duration=${XFADE_DURATION.toFixed(1)}:offset=${cumulativeOffset.toFixed(3)}[${xfLabel}]`
      );
      cumulativeOffset += segmentDuration - XFADE_DURATION;
      prevLabel = xfLabel;
    }

    // Handle single-quote edge cases
    if (quotes.length === 1 && (hasHook || hasTitle)) {
      if (!prevLabel.startsWith("preoutro")) {
        filterParts.push(`[${prevLabel}]copy[preoutro]`);
        prevLabel = "preoutro";
      }
    }

    // Outro: blur last frame + channel name
    const outroIdx = quotes.length - 1 + inputOffset; // account for hook input offset
    const outroDuration = GAP_DURATION;
    filterParts.push(
      `[${outroIdx}:v]fps=30,scale=1080:1920:flags=bilinear,trim=start=7.5:duration=0.1,setpts=PTS-STARTPTS,` +
      `loop=loop=${Math.ceil(outroDuration * 30)}:size=1:start=0,trim=duration=${outroDuration},setpts=PTS-STARTPTS,` +
      `boxblur=20:20,fade=t=in:st=0:d=0.3,` +
      `drawtext=text='${CHANNEL_NAME}':fontfile='${fontPath}':fontsize=36:fontcolor=white@0.8:x=(w-text_w)/2:y=(h-text_h)/2[outro]`
    );

    const outroOffset = cumulativeOffset;
    filterParts.push(
      `[preoutro][outro]xfade=transition=fade:duration=0.8:offset=${outroOffset.toFixed(3)}[prefinal]`
    );
  }

  // Logo watermark: scale to 60px, semi-transparent, bottom-left corner
  filterParts.push(
    `[${logoIdx}:v]scale=60:60,format=rgba,colorchannelmixer=aa=0.7[logo]`
  );
  filterParts.push(
    `[prefinal][logo]overlay=x=30:y=H-90[final]`
  );

  // Check which clips have audio for ambient mix
  const clipsWithAudio = quotes.map((_, i) => {
    try {
      const probe = execSync(
        `ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${veoClips[i]}"`,
        { encoding: "utf-8" }
      ).trim();
      return probe.length > 0;
    } catch { return false; }
  });
  const numWithAudio = clipsWithAudio.filter(Boolean).length;

  if (numWithAudio > 0) {
    // Mix Veo ambient audio + voiceover
    const veoAudioConcat = clipsWithAudio.map((has, i) => has ? `[veoaud${i}]` : "").filter(Boolean).join("");
    filterParts.push(`${veoAudioConcat}concat=n=${numWithAudio}:v=0:a=1[veoamb]`);
    filterParts.push(`[veoamb]apad=whole_dur=${totalDuration.toFixed(3)}[veopad]`);
    filterParts.push(`[${voiceIdx}:a]apad=whole_dur=${totalDuration.toFixed(3)}[voicepad]`);
    filterParts.push(`[voicepad][veopad]amix=inputs=2:duration=first:weights=1 0.2[audio]`);
  } else {
    // No Veo audio — just use voiceover with padding
    filterParts.push(`[${voiceIdx}:a]apad=whole_dur=${totalDuration.toFixed(3)}[audio]`);
  }

  const filterComplex = filterParts.join(";\n");
  const filterScriptPath = `${QUEUE_DIR}/_veofilter_${Date.now()}.txt`;
  writeFileSync(filterScriptPath, filterComplex, "utf-8");

  const cmd = [
    "ffmpeg -y -threads 0",
    ...inputs,
    `-filter_complex_script "${filterScriptPath}"`,
    `-map "[final]" -map "[audio]"`,
    "-c:v libx264 -preset ultrafast -crf 23 -r 30 -threads 0",
    "-c:a aac -b:a 128k",
    "-pix_fmt yuv420p",
    `"${outputPath}"`,
  ].join(" ");

  log(`Composing final video (${quotes.length} clips, ${totalDuration.toFixed(1)}s total with gaps)...`);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(cmd, { stdio: ["ignore", "pipe", "pipe"], shell: true });
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      });
      proc.on("error", reject);
    });
  } finally {
    try { unlinkSync(filterScriptPath); } catch {}
    for (const tf of textFiles) {
      try { unlinkSync(tf); } catch {}
    }
  }

  return { duration: totalDuration, path: outputPath };
}

export async function runPipeline(opts = {}) {
  const jobId = `veo-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const category = pickCategory();

  log(`=== Veo Pipeline Start: ${jobId} ===`);
  log(`Category: ${category}`);
  log(`Veo model: ${VEO_MODEL}`);
  log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  // --- Step 1: Select quotes ---
  log("Step 1: Selecting quotes...");
  const quotes = getUnusedQuotes(category, 4);
  if (quotes.length < 3) {
    log(`ERROR: Only ${quotes.length} unused quotes in "${category}". Need at least 3.`);
    return { success: false, error: "insufficient_quotes", category };
  }
  log(`Selected ${quotes.length} quotes from "${category}"`);

  createVideoJob({ job_id: jobId, status: "pending", niche: NICHE, content_ids: quotes.map((q) => q.id) });

  // --- Step 2: Generate director script (script + scene directions) ---
  log("Step 2: Generating director script + scene directions...");
  updateVideoStatus(jobId, "scripting");

  const scriptResult = await writeDirectorScript(quotes, { style: "inspirational", targetSeconds: 120 });
  log(`Script: ${scriptResult.estimatedSeconds}s, hook: "${scriptResult.hookLine.slice(0, 60)}..."`);
  log(`Scenes: ${scriptResult.scenes.length} unique scene directions`);
  if (scriptResult.hookVeoPrompt) {
    log(`Hook Veo prompt: ${scriptResult.hookVeoPrompt.slice(0, 120)}...`);
  }

  // Save full director result to JSON file + DB for review/editing
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
  const directorJson = JSON.stringify(scriptResult, null, 2);
  const directorPath = `${QUEUE_DIR}/${jobId}-director.json`;
  writeFileSync(directorPath, directorJson, "utf-8");
  log(`Director script saved: ${directorPath}`);
  updateVideoStatus(jobId, "scripted", { script: scriptResult.script, director_json: directorJson });

  if (STEP === "script") {
    console.log("\n--- SCRIPT ---\n" + scriptResult.script);
    console.log("\n--- SCENES ---");
    scriptResult.scenes.forEach((s, i) => console.log(`  ${i + 1}. [${s.mood}] ${s.veoPrompt.slice(0, 80)}...`));
    return { success: true, step: "script", scriptResult };
  }

  // --- Step 3: Generate voiceover ---
  log("Step 3: Generating voiceover...");
  const audioPath = `${QUEUE_DIR}/${jobId}-audio.mp3`;
  const voiceResult = await generateVoiceover(scriptResult.script, audioPath, {
    provider: opts.ttsProvider,
  });
  log(`Voiceover: ${(voiceResult.sizeBytes / 1024).toFixed(0)}KB`);

  if (STEP === "voiceover") {
    return { success: true, step: "voiceover", audioPath, voiceResult };
  }

  // --- Step 4a: Generate Veo 3 hook clip (8s cinematic opening) ---
  let hookClipPath = null;
  if (!opts.skipHook && scriptResult.hookVeoPrompt) {
    const veoModel = pickAvailableModel();
    if (veoModel) {
      log(`Step 4a: Generating Veo hook clip (8s) with model: ${veoModel}...`);
      hookClipPath = `${QUEUE_DIR}/${jobId}-hook.mp4`;
      try {
        await generateVideo(scriptResult.hookVeoPrompt, hookClipPath, {
          model: veoModel,
          aspectRatio: "9:16",
          resolution: "1080p",
        });
        log(`Hook clip generated: ${hookClipPath}`);
      } catch (err) {
        log(`⚠ Veo hook failed: ${err.message}. Proceeding without hook.`);
        hookClipPath = null;
      }
    } else {
      log("Step 4a: All Veo models exhausted for today. Proceeding without hook.");
    }
  } else {
    log("Step 4a: Skipping Veo hook (skipHook or no hookVeoPrompt)");
  }

  // --- Step 4b: Generate scene visuals (Imagen + Ken Burns) ---
  log("Step 4b: Generating scene visuals...");
  updateVideoStatus(jobId, "rendering");

  const scenePrompts = scriptResult.scenes.map((s) => s.veoPrompt);
  const veoClips = [];
  let useImagen = true; // Always use Imagen + Ken Burns for scenes; Veo only for hook clip

  for (let i = 0; i < quotes.length; i++) {
    const clipPath = `${QUEUE_DIR}/${jobId}-veo-${i}.mp4`;

    if (!useImagen) {
      // Try Veo first
      log(`  Veo clip ${i + 1}/${quotes.length}...`);
      let veoOk = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await generateVideo(scenePrompts[i], clipPath, {
            model: VEO_MODEL,
            aspectRatio: "9:16",
            resolution: "1080p",
          });
          veoOk = true;
          break;
        } catch (err) {
          log(`  ⚠ Veo clip ${i + 1} attempt ${attempt + 1} failed: ${err.message}`);
          // If quota exhausted, switch to Imagen for ALL remaining clips
          if (err.status === 429 || err.message?.includes("RESOURCE_EXHAUSTED")) {
            log(`  → Veo quota exhausted. Switching to Imagen + Ken Burns for all clips.`);
            useImagen = true;
            break;
          }
          if (attempt < 1) await new Promise(r => setTimeout(r, 3000));
        }
      }
      if (veoOk) {
        veoClips.push(clipPath);
        continue;
      }
    }

    // Imagen fallback: generate image → Ken Burns effect → video clip
    log(`  Imagen + Ken Burns clip ${i + 1}/${quotes.length}...`);
    const imgPath = `${QUEUE_DIR}/${jobId}-img-${i}.png`;

    // Adapt Veo prompt for still image
    const imgPrompt = scenePrompts[i]
      .replace(/^Vertical 9:16 video\.\s*/i, "")
      .replace(/No text, no people talking\.\s*/i, "")
      .replace(/Cinematic, smooth camera movement\.\s*/i, "")
      + " Vertical 9:16 aspect ratio. Ultra high quality, cinematic lighting, 4K detail.";

    await generateImage(imgPrompt, imgPath);

    // Ken Burns + Parallax: dramatic effects with depth illusion
    // Some effects use single zoompan, others use 2-layer parallax (bg slow + fg fast)
    const KEN_BURNS_EFFECTS = [
      // --- Single-layer dramatic zoom+pan ---
      { name: "zoom_in_center", type: "single",
        filter: "zoompan=z='min(zoom+0.002,1.6)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30" },
      { name: "zoom_out_reveal", type: "single",
        filter: "zoompan=z='if(eq(on,0),1.6,max(zoom-0.002,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30" },
      { name: "zoom_pan_right", type: "single",
        filter: "zoompan=z='min(zoom+0.0015,1.4)':x='min(iw/2-(iw/zoom/2)+on*0.4,iw-iw/zoom)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30" },
      { name: "zoom_pan_up", type: "single",
        filter: "zoompan=z='min(zoom+0.0015,1.4)':x='iw/2-(iw/zoom/2)':y='max(ih/2-(ih/zoom/2)-on*0.25,0)':d=300:s=1080x1920:fps=30" },
      { name: "zoom_diagonal_drift", type: "single",
        filter: "zoompan=z='min(zoom+0.0014,1.45)':x='max(iw*0.25*(1-on/300)+iw/2*(on/300)-(iw/zoom/2),0)':y='max(ih*0.25*(1-on/300)+ih/2*(on/300)-(ih/zoom/2),0)':d=300:s=1080x1920:fps=30" },
      { name: "zoom_accelerate_burst", type: "single",
        filter: "zoompan=z='min(1.0+0.6*pow(on/300,2),1.6)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30" },
      { name: "zoom_breathe", type: "single",
        filter: "zoompan=z='1.2+0.15*sin(on/300*3.14159)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30" },

      // --- Parallax 2-layer (background slow zoom + foreground fast zoom overlay) ---
      { name: "parallax_zoom_in", type: "parallax",
        bgFilter: "zoompan=z='min(zoom+0.0008,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30",
        fgFilter: "zoompan=z='min(zoom+0.003,1.8)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30,format=rgba,colorchannelmixer=aa=0.35" },
      { name: "parallax_drift_right", type: "parallax",
        bgFilter: "zoompan=z='min(zoom+0.0006,1.15)':x='min(iw/2-(iw/zoom/2)+on*0.15,iw-iw/zoom)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30",
        fgFilter: "zoompan=z='min(zoom+0.002,1.5)':x='min(iw/2-(iw/zoom/2)+on*0.5,iw-iw/zoom)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30,format=rgba,colorchannelmixer=aa=0.3" },
      { name: "parallax_zoom_out", type: "parallax",
        bgFilter: "zoompan=z='if(eq(on,0),1.15,max(zoom-0.0006,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30",
        fgFilter: "zoompan=z='if(eq(on,0),1.7,max(zoom-0.0025,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=300:s=1080x1920:fps=30,format=rgba,colorchannelmixer=aa=0.3" },
    ];

    const effect = KEN_BURNS_EFFECTS[Math.floor(Math.random() * KEN_BURNS_EFFECTS.length)];
    log(`    Effect: ${effect.name} (${effect.type})`);

    if (effect.type === "parallax") {
      // 2-pass: bg layer (slow) + fg layer (fast) → overlay → create depth
      execSync(
        `ffmpeg -y -loop 1 -i "${imgPath}" -loop 1 -i "${imgPath}" ` +
        `-filter_complex "[0:v]${effect.bgFilter}[bg];[1:v]${effect.fgFilter}[fg];[bg][fg]overlay=0:0[out]" ` +
        `-map "[out]" -t 10 -c:v libx264 -preset ultrafast -crf 23 -r 30 -pix_fmt yuv420p "${clipPath}"`,
        { stdio: "pipe", timeout: 300000 }
      );
    } else {
      // Single layer
      execSync(
        `ffmpeg -y -loop 1 -i "${imgPath}" -vf "${effect.filter}" -t 10 -c:v libx264 -preset ultrafast -crf 23 -r 30 -pix_fmt yuv420p "${clipPath}"`,
        { stdio: "pipe", timeout: 300000 }
      );
    }

    // Cleanup image
    try { unlinkSync(imgPath); } catch {}
    veoClips.push(clipPath);
  }

  log(`All ${veoClips.length} clips generated (${useImagen ? "Imagen" : "Veo"})`);

  if (STEP === "veo") {
    return { success: true, step: "veo", veoClips, audioPath };
  }

  // --- Step 5: Compose final video ---
  log("Step 5: Composing final video...");
  const videoPath = `${QUEUE_DIR}/${jobId}.mp4`;
  const titleText = scriptResult.caption?.split("\n")[0] || scriptResult.hookLine || null;
  const videoResult = await composeVideo(veoClips, quotes, audioPath, videoPath, hookClipPath, titleText);
  log(`Final video: ${videoResult.duration.toFixed(1)}s at ${videoPath}`);

  updateVideoStatus(jobId, "rendered", { video_path: videoPath });

  if (STEP === "render" || DRY_RUN || opts.skipUpload) {
    log(`Pipeline stopped at ${STEP || "render"}. Video saved to ${videoPath}`);
    return { success: true, step: STEP || "render", videoPath, videoResult, duration: videoResult.duration, category: quotes[0]?.category };
  }

  // --- Step 6: Upload & schedule ---
  log("Step 6: Uploading to PostFast...");
  updateVideoStatus(jobId, "uploading");

  const accounts = await getTikTokAccounts();
  if (accounts.length === 0) {
    log("ERROR: No TikTok accounts connected in PostFast");
    updateVideoStatus(jobId, "failed");
    return { success: false, error: "no_tiktok_account" };
  }

  const videoKey = await uploadVideo(videoPath);
  log(`Uploaded: ${videoKey}`);

  const hashtags = pickHashtags();

  // Build author credits for caption
  const uniqueAuthors = [...new Set(
    quotes
      .map((q) => {
        const name = q.author && q.author !== "Original" ? q.author : "";
        const work = q.source_work || "";
        if (!name) return "";
        return work ? `${name} (${work})` : name;
      })
      .filter(Boolean)
  )];
  const authorCredits = uniqueAuthors.length > 0
    ? `\n\n📝 ${uniqueAuthors.join("\n📝 ")}`
    : "";

  const caption = `${scriptResult.caption}${authorCredits}\n\n${hashtags.join(" ")}`;
  const scheduledAt = new Date(Date.now() + 60_000).toISOString();

  const postResult = await schedulePost({
    socialMediaId: accounts[0].id,
    videoKey,
    caption,
    scheduledAt,
  });

  log(`Scheduled: post ${postResult.postIds[0]} at ${scheduledAt}`);

  // --- Step 7: Cleanup & tracking ---
  markQuotesUsed(quotes.map((q) => q.id));
  updateVideoStatus(jobId, "posted", {
    tiktok_post_id: postResult.postIds[0],
    caption,
    hashtags: JSON.stringify(hashtags),
    posted_at: new Date().toISOString(),
  });

  // Clean up Veo clips (keep final video)
  for (const clip of veoClips) {
    try { unlinkSync(clip); } catch {}
  }

  log(`=== Veo Pipeline Complete: ${jobId} ===`);
  return {
    success: true,
    jobId,
    postId: postResult.postIds[0],
    videoPath,
    duration: videoResult.duration,
    category,
    hashtags,
    veoCost: `~$${((VEO_MODEL === "fast" ? 1.20 : 3.20) + quotes.length * 0.03).toFixed(2)}`,
  };
}

// CLI entry point
if (process.argv[1]?.endsWith("pipeline-quotes-veo.js")) {
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
