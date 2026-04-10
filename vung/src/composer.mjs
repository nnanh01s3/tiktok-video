/**
 * Composer — stitch scene clips + dialogue audio into final 2-minute video.
 *
 * Strategy (v2 — with xfade transitions):
 *   1. Chain all scene clips with xfade crossfade (video) + acrossfade (audio)
 *   2. Mix dialogue TTS at correct xfade-adjusted timestamps over the scene audio
 *   3. Add background music (loop, low volume)
 *   4. Apply fadein at start + fadeout to black at end
 *   5. Output 1080x1920 9:16 MP4 ready for TikTok
 *
 * Why xfade instead of concat demuxer?
 *   Hard cuts between story scenes feel jerky. A 0.4s crossfade is standard
 *   film grammar for "same story continuing" and visually much smoother.
 *   For the final scene → black ending, we use `fade=out` filter (simpler
 *   than xfade with a synthetic black clip).
 *
 * Dialogue timing math:
 *   With xfade, next scene's visible start is (prev_start + clipDur - xfade),
 *   NOT (prev_start + clipDur). Forgetting this causes cumulative drift.
 *
 * The hardest part remains DIALOGUE TIMING: each dialogue line belongs to a
 * scene, and we want the voice to start ~0.5s after the scene is clearly
 * visible. Multiple dialogue lines in one scene are spaced evenly within the
 * scene's usable (clipDur - 1.0) window.
 */
import { existsSync, writeFileSync, unlinkSync, statSync, readdirSync } from "fs";
import { execSync, spawnSync } from "child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// Default xfade duration between scenes. Keep short (0.3-0.5s) so dialogue
// pacing isn't disturbed. Too long = viewer feels the scene "drifts".
const DEFAULT_XFADE = 0.4;

// Head/tail silence around dialogue lines within a scene
// (only used when includeDialogue=true)
const DIALOGUE_HEAD = 0.5;
const DIALOGUE_TAIL = 0.5;

// Scene ambient audio (from Veo) volume in final mix.
// Previously was 0.4 to make room for dialogue TTS. Now that dialogue is
// disabled by default, keep at 1.0 for full-strength native Veo audio.
const SCENE_AUDIO_VOLUME = 1.0;

// Fadein/fadeout duration at episode start/end (to/from black)
const EPISODE_FADE_DUR = 0.5;

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
 * Build a dialogue timing plan accounting for xfade overlap between scenes.
 *
 * @param {Array<{scene, clipPath, clipDur, dialogue}>} rendered - caller must populate clipDur
 * @param {number} xfadeDur
 * @returns {{timed: Array<{path, startSec}>, totalDuration: number}}
 */
function planDialogueTimingWithXfade(rendered, xfadeDur) {
  const timed = [];
  let sceneVisibleStart = 0; // when scene i starts being shown in output timeline

  for (let i = 0; i < rendered.length; i++) {
    const { scene, clipDur, dialogue } = rendered[i];

    if (dialogue.length > 0) {
      // Leave head + tail; distribute lines evenly in the middle
      const usable = Math.max(0.1, clipDur - DIALOGUE_HEAD - DIALOGUE_TAIL);
      const slot = usable / dialogue.length;

      for (let j = 0; j < dialogue.length; j++) {
        timed.push({
          path: dialogue[j].path,
          startSec: sceneVisibleStart + DIALOGUE_HEAD + j * slot,
        });
      }
    }

    // Advance to next scene's visible start (accounting for xfade overlap)
    // Last scene: add only clipDur (no overlap after last scene)
    if (i < rendered.length - 1) {
      sceneVisibleStart += clipDur - xfadeDur;
    } else {
      sceneVisibleStart += clipDur;
    }
  }

  return { timed, totalDuration: sceneVisibleStart };
}

/**
 * Build the video xfade chain filter graph entries.
 * Produces normalized [sv0..sv(N-1)] then chained xfades ending at [vchain].
 */
function buildVideoXfadeChain(rendered, xfadeDur) {
  const n = rendered.length;
  const parts = [];

  // Normalize each scene video to 1080x1920 30fps
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
        `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30[sv${i}]`
    );
  }

  if (n === 1) {
    // Single scene: alias [sv0] → [vchain]
    parts.push(`[sv0]null[vchain]`);
    return parts;
  }

  // Chain xfades: first xfade offset = clipDur[0] - xfadeDur
  // Each subsequent offset += clipDur[i] - xfadeDur
  let prev = "[sv0]";
  let offset = rendered[0].clipDur - xfadeDur;
  for (let i = 1; i < n; i++) {
    const isLast = i === n - 1;
    const out = isLast ? "[vchain]" : `[vxc${i}]`;
    parts.push(
      `${prev}[sv${i}]xfade=transition=fade:duration=${xfadeDur}:` +
        `offset=${offset.toFixed(3)}${out}`
    );
    prev = out;
    offset += rendered[i].clipDur - xfadeDur;
  }

  return parts;
}

/**
 * Build the scene audio acrossfade chain filter graph entries.
 * Produces chained [0:a]..[n-1:a] acrossfades ending at [achain].
 */
function buildSceneAudioChain(rendered, xfadeDur) {
  const n = rendered.length;
  const parts = [];

  if (n === 1) {
    parts.push(`[0:a]anull[achain]`);
    return parts;
  }

  let prev = "[0:a]";
  for (let i = 1; i < n; i++) {
    const isLast = i === n - 1;
    const out = isLast ? "[achain]" : `[axc${i}]`;
    parts.push(`${prev}[${i}:a]acrossfade=d=${xfadeDur}${out}`);
    prev = out;
  }

  return parts;
}

/**
 * Compose final video from rendered scenes.
 *
 * Audio strategy (post "quá nhỏ" fix):
 *   - Native Veo scene audio is the PRIMARY audio track (full volume 1.0)
 *   - Dialogue TTS mixing is DISABLED by default (was causing amix gain
 *     reduction: with 21 inputs, each one got 1/21 ≈ 4.8% final volume)
 *   - Background music is optional, mixed at musicVolume
 *   - All amix calls use normalize=0 to prevent auto gain reduction
 *
 * @param {Array<{scene, imagePath, clipPath, dialogue}>} rendered - output from renderScene() for each scene
 * @param {string} outputPath - final .mp4 path
 * @param {Object} [options]
 * @param {string} [options.bgMusic] - optional background music file path
 * @param {number} [options.musicVolume=0.15] - bgm volume (0-1)
 * @param {number} [options.xfadeDur=0.4] - crossfade duration between scenes
 * @param {boolean} [options.includeDialogue=false] - mix dialogue TTS over scene audio
 *   (default false — rely on native Veo audio; set true to bring back TTS voice mixing)
 */
export async function composeVideo(rendered, outputPath, options = {}) {
  const {
    bgMusic,
    musicVolume = 0.15,
    xfadeDur = DEFAULT_XFADE,
    includeDialogue = false,
  } = options;

  // Validate inputs
  for (const r of rendered) {
    if (!existsSync(r.clipPath) || statSync(r.clipPath).size < 10000) {
      throw new Error(`Scene ${r.scene.id} clip missing or too small: ${r.clipPath}`);
    }
  }

  // Probe actual clip durations (needed for xfade offset math)
  for (const r of rendered) {
    r.clipDur = probeDuration(r.clipPath) || r.scene.duration || 8;
  }

  const nScenes = rendered.length;

  // Compute total duration + dialogue timing (only used if includeDialogue=true)
  const { timed: dialogueTiming, totalDuration } = planDialogueTimingWithXfade(
    rendered,
    xfadeDur
  );
  const dialogueCount = includeDialogue ? dialogueTiming.length : 0;
  console.log(
    `[Compose] ${nScenes} scenes, ${totalDuration.toFixed(1)}s total ` +
      `(${xfadeDur}s xfade), ${dialogueCount} dialogue lines ` +
      `(includeDialogue=${includeDialogue})`
  );

  // Build ffmpeg inputs list:
  //   Inputs 0..N-1: scene clips
  //   Inputs N..N+K-1: dialogue audio files (only if includeDialogue)
  //   Last input (optional): background music
  const inputs = [];
  rendered.forEach((r) => inputs.push(`-i "${r.clipPath}"`));
  if (includeDialogue) {
    dialogueTiming.forEach((d) => inputs.push(`-i "${d.path}"`));
  }

  let bgmIdx = -1;
  if (bgMusic && existsSync(bgMusic)) {
    bgmIdx = nScenes + dialogueCount;
    inputs.push(`-stream_loop -1 -i "${bgMusic}"`);
  }

  // Build filter_complex graph
  const filterParts = [];

  // 1) Video xfade chain → [vchain]
  filterParts.push(...buildVideoXfadeChain(rendered, xfadeDur));

  // 2) Apply episode fadein/fadeout (to/from black)
  filterParts.push(
    `[vchain]fade=in:st=0:d=${EPISODE_FADE_DUR},` +
      `fade=out:st=${(totalDuration - EPISODE_FADE_DUR).toFixed(3)}:d=${EPISODE_FADE_DUR}[vout]`
  );

  // 3) Scene audio acrossfade chain → [achain] → volume → [sceneaudio]
  filterParts.push(...buildSceneAudioChain(rendered, xfadeDur));
  filterParts.push(`[achain]volume=${SCENE_AUDIO_VOLUME}[sceneaudio]`);

  const mixInputs = [`[sceneaudio]`];

  // 4) Dialogue delays (optional — only when includeDialogue=true)
  if (includeDialogue) {
    dialogueTiming.forEach((d, i) => {
      const idx = nScenes + i;
      const delayMs = Math.round(d.startSec * 1000);
      const label = `d${i}`;
      filterParts.push(
        `[${idx}:a]adelay=${delayMs}|${delayMs},volume=1.3[${label}]`
      );
      mixInputs.push(`[${label}]`);
    });
  }

  // 5) Background music (optional, trimmed to total duration)
  if (bgmIdx >= 0) {
    filterParts.push(
      `[${bgmIdx}:a]volume=${musicVolume},` +
        `atrim=duration=${totalDuration.toFixed(3)},` +
        `afade=in:st=0:d=${EPISODE_FADE_DUR},` +
        `afade=out:st=${(totalDuration - EPISODE_FADE_DUR).toFixed(3)}:d=${EPISODE_FADE_DUR}[bgm]`
    );
    mixInputs.push(`[bgm]`);
  }

  // 6) Final audio mix
  // CRITICAL: normalize=0 prevents FFmpeg's default gain reduction (1/N per
  // input). Without this, scene audio at volume=1.0 with 21 mix inputs would
  // become 1/21 ≈ 4.8% of original — the bug that caused "quá nhỏ" audio.
  if (mixInputs.length === 1) {
    // Only scene audio — rename to [aout] directly, no mix needed
    filterParts.push(`[sceneaudio]anull[aout]`);
  } else {
    filterParts.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:` +
        `duration=longest:dropout_transition=0:normalize=0[aout]`
    );
  }

  const filterComplex = filterParts.join(";");
  const filterFile = outputPath.replace(/\.mp4$/, "_filter.txt");
  writeFileSync(filterFile, filterComplex);

  const cmd = [
    `${FFMPEG} -y`,
    ...inputs,
    `-filter_complex_script "${filterFile}"`,
    `-map "[vout]"`,
    `-map "[aout]"`,
    `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
    `-c:a aac -b:a 128k -ar 44100`,
    `-t ${totalDuration.toFixed(3)}`,
    `"${outputPath}"`,
  ].join(" ");

  console.log(`[Compose] Running ffmpeg (${nScenes} scenes + ${dialogueCount} dialogue + ${bgmIdx >= 0 ? "bgm" : "no bgm"})...`);
  const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 600_000 });

  // Cleanup temp files
  try { unlinkSync(filterFile); } catch {}

  if (result.status !== 0) {
    const stderr = (result.stderr || "").slice(-1200);
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
