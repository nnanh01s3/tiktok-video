/**
 * Composer — stitch scene clips + dialogue audio into final 2-minute video.
 *
 * Strategy:
 *   1. Concat all scene clips in order (xfade transitions optional)
 *   2. Build an audio track: mix dialogue audio at correct timestamps
 *   3. Add background music (loop, low volume)
 *   4. Output 1080x1920 9:16 MP4 ready for TikTok
 *
 * The hardest part is DIALOGUE TIMING: each dialogue line belongs to a scene,
 * and we want the voice to start near the beginning of that scene (not exactly
 * at scene start, but after ~0.5s so the visual lands first). Multiple dialogue
 * lines in one scene are spaced evenly within the scene's 8s window.
 */
import { existsSync, writeFileSync, unlinkSync, statSync, readdirSync } from "fs";
import { execSync, spawnSync } from "child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/**
 * Get duration of an audio/video file in seconds.
 */
function probeDuration(filePath) {
  try {
    const out = execSync(
      `${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { encoding: "utf8" }
    ).trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

/**
 * Build a dialogue timing plan:
 *   For each scene's dialogue lines, compute absolute timestamps where they
 *   should start, given the scene's cumulative offset in the final video.
 *
 * @param {Array<{scene, clipPath, dialogue}>} rendered
 * @returns {Array<{path: string, startSec: number}>}
 */
function planDialogueTiming(rendered) {
  const timed = [];
  let cumulative = 0;

  for (const { scene, clipPath, dialogue } of rendered) {
    const clipDur = probeDuration(clipPath) || scene.duration || 8;
    const sceneStart = cumulative;

    if (dialogue.length > 0) {
      // Leave 0.5s head, 0.5s tail; distribute lines evenly in the middle
      const usable = clipDur - 1.0;
      const slot = usable / dialogue.length;

      for (let i = 0; i < dialogue.length; i++) {
        timed.push({
          path: dialogue[i].path,
          startSec: sceneStart + 0.5 + i * slot,
        });
      }
    }

    cumulative += clipDur;
  }

  return { timed, totalDuration: cumulative };
}

/**
 * Compose final video from rendered scenes.
 *
 * @param {Array<{scene, imagePath, clipPath, dialogue}>} rendered - output from renderScene() for each scene
 * @param {string} outputPath - final .mp4 path
 * @param {Object} [options]
 * @param {string} [options.bgMusic] - optional background music file path
 * @param {number} [options.musicVolume=0.15] - bgm volume (0-1)
 */
export async function composeVideo(rendered, outputPath, options = {}) {
  const { bgMusic, musicVolume = 0.15 } = options;

  // Validate inputs
  for (const r of rendered) {
    if (!existsSync(r.clipPath) || statSync(r.clipPath).size < 10000) {
      throw new Error(`Scene ${r.scene.id} clip missing or too small: ${r.clipPath}`);
    }
  }

  // Step 1: build a concat list file for ffmpeg concat demuxer
  const concatList = outputPath.replace(/\.mp4$/, "_concat.txt");
  const concatContent = rendered
    .map((r) => `file '${r.clipPath.replace(/\\/g, "/")}'`)
    .join("\n");
  writeFileSync(concatList, concatContent);

  // Step 2: plan dialogue timing
  const { timed: dialogueTiming, totalDuration } = planDialogueTiming(rendered);
  console.log(
    `[Compose] ${rendered.length} scenes, ${totalDuration.toFixed(1)}s total, ${dialogueTiming.length} dialogue lines`
  );

  // Step 3: build ffmpeg command with filter_complex
  const inputs = [];
  // Input 0: concat video
  inputs.push(`-f concat -safe 0 -i "${concatList}"`);

  // Inputs 1..N: dialogue audio files
  dialogueTiming.forEach((d) => {
    inputs.push(`-i "${d.path}"`);
  });

  // Input N+1: background music (optional)
  let bgmIdx = -1;
  if (bgMusic && existsSync(bgMusic)) {
    bgmIdx = 1 + dialogueTiming.length;
    inputs.push(`-stream_loop -1 -i "${bgMusic}"`);
  }

  // Build audio filter graph:
  //   Each dialogue: [idx:a]adelay=START_MS|START_MS,volume=1[vN]
  //   Then amix all dialogue streams with bgm into final audio
  const filterParts = [];
  const mixInputs = [];

  dialogueTiming.forEach((d, i) => {
    const idx = i + 1; // 0 is video concat
    const delayMs = Math.round(d.startSec * 1000);
    const label = `d${i}`;
    filterParts.push(
      `[${idx}:a]adelay=${delayMs}|${delayMs},volume=1.3[${label}]`
    );
    mixInputs.push(`[${label}]`);
  });

  if (bgmIdx >= 0) {
    filterParts.push(
      `[${bgmIdx}:a]volume=${musicVolume},atrim=duration=${totalDuration.toFixed(3)}[bgm]`
    );
    mixInputs.push(`[bgm]`);
  }

  let audioMap = "0:a?"; // fallback to video's own audio (likely none)
  if (mixInputs.length > 0) {
    filterParts.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[aout]`
    );
    audioMap = "[aout]";
  }

  // Normalize video: scale/pad to 1080x1920
  filterParts.push(`[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30[vout]`);

  const filterComplex = filterParts.join(";");
  const filterFile = outputPath.replace(/\.mp4$/, "_filter.txt");
  writeFileSync(filterFile, filterComplex);

  const cmd = [
    `${FFMPEG} -y`,
    ...inputs,
    `-filter_complex_script "${filterFile}"`,
    `-map "[vout]"`,
    `-map "${audioMap}"`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `-c:a aac -b:a 128k`,
    `-t ${totalDuration.toFixed(3)}`,
    `"${outputPath}"`,
  ].join(" ");

  console.log(`[Compose] Running ffmpeg...`);
  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 600_000 });

  // Cleanup temp files
  try { unlinkSync(concatList); } catch {}
  try { unlinkSync(filterFile); } catch {}

  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(-800);
    throw new Error(`FFmpeg failed (exit ${result.status}):\n${stderr}`);
  }

  if (!existsSync(outputPath)) {
    throw new Error("FFmpeg completed but output file missing");
  }

  const sizeMB = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`[Compose] ✅ Final video: ${outputPath} (${sizeMB}MB, ${totalDuration.toFixed(1)}s)`);

  return { path: outputPath, duration: totalDuration };
}

/**
 * Find a background music file from assets/music if available.
 */
export function findBackgroundMusic(preferredName = null) {
  const musicDir = "D:/tiktok/vung/assets/music";
  if (!existsSync(musicDir)) return null;
  const files = readdirSync(musicDir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f));
  if (files.length === 0) return null;
  if (preferredName) {
    const match = files.find((f) => f.toLowerCase().includes(preferredName.toLowerCase()));
    if (match) return `${musicDir}/${match}`;
  }
  return `${musicDir}/${files[0]}`;
}
