/**
 * Prepend cover.png as a 1-second static intro to an existing final.mp4.
 *
 * Why: cover as first frame → strong branding when viewers pause/scroll on TikTok.
 * Also serves as video thumbnail.
 *
 * Usage:
 *   node vung/src/add-cover-intro.mjs --episode tap_02
 *   node vung/src/add-cover-intro.mjs --episode tap_02 --duration 1.5
 *
 * Flow:
 *   1. Find vung/output/<tap>/cover.png + <tap>_final.mp4
 *   2. FFmpeg: prepend cover as N-second silent clip, concat with final
 *   3. Output: <tap>_final_with_cover.mp4 (keeps original intact)
 */
import { existsSync, statSync, renameSync } from "fs";
import { spawnSync } from "child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const args = process.argv.slice(2);
const tapArg = args.includes("--episode")
  ? args[args.indexOf("--episode") + 1]
  : null;
// Default 5s — enough time for viewers to read title, identify characters,
// and register the episode theme before video starts.
const duration = args.includes("--duration")
  ? parseFloat(args[args.indexOf("--duration") + 1])
  : 5.0;
const replaceOriginal = args.includes("--replace"); // overwrite existing _final.mp4

if (!tapArg) {
  console.error("Usage: node vung/src/add-cover-intro.mjs --episode tap_02 [--duration 1.0] [--replace]");
  process.exit(1);
}

const tapSlug = tapArg.startsWith("tap_") ? tapArg : `tap_${tapArg.padStart(2, "0")}`;
const outputDir = `D:/tiktok/vung/output/${tapSlug}`;
const coverPath = `${outputDir}/cover.png`;
const videoPath = `${outputDir}/${tapSlug}_final.mp4`;
const outputPath = `${outputDir}/${tapSlug}_final_with_cover.mp4`;

if (!existsSync(coverPath)) {
  console.error(`❌ Cover not found: ${coverPath}`);
  console.error(`   Run: node vung/src/gen-cover.mjs --episode ${tapArg}`);
  process.exit(1);
}
if (!existsSync(videoPath)) {
  console.error(`❌ Video not found: ${videoPath}`);
  process.exit(1);
}

console.log(`🎬 Prepending cover (${duration}s) to video:`);
console.log(`   Cover: ${coverPath}`);
console.log(`   Video: ${videoPath}`);
console.log(`   Output: ${outputPath}`);

// FFmpeg filter_complex:
// - Input 0: cover image, looped for `duration` seconds, scaled+cropped to 1080x1920, 30fps
// - Input 1: existing video (already 1080x1920 30fps with audio)
// - Concat video streams + concat audio (prepend silence for cover duration)
const filter = [
  `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1[v0]`,
  `[1:v]fps=30,setsar=1[v1]`,
  `[v0][v1]concat=n=2:v=1:a=0[vout]`,
  `anullsrc=r=44100:cl=stereo:d=${duration}[a0]`,
  `[a0][1:a]concat=n=2:v=0:a=1[aout]`,
].join(";");

const cmd = [
  `${FFMPEG} -y`,
  `-loop 1 -t ${duration} -i "${coverPath}"`,
  `-i "${videoPath}"`,
  `-filter_complex "${filter}"`,
  `-map "[vout]" -map "[aout]"`,
  `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
  `-c:a aac -b:a 128k -ar 44100`,
  `"${outputPath}"`,
].join(" ");

console.log("\n[FFmpeg] Running...");
const result = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 600_000 });
if (result.status !== 0) {
  console.error("❌ FFmpeg failed:");
  console.error((result.stderr || "").slice(-1500));
  process.exit(1);
}

const sizeMB = (statSync(outputPath).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ Output: ${outputPath} (${sizeMB}MB)`);

if (replaceOriginal) {
  renameSync(outputPath, videoPath);
  console.log(`✅ Replaced original: ${videoPath}`);
}
