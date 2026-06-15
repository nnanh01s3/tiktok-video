/**
 * Load environment variables from config/.env.
 * Must be imported before any module that reads process.env.
 *
 * Uses dotenv.parse + manual assignment because dotenv.config()
 * silently fails to set process.env for values containing
 * special characters (=, +) on some platforms.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", "config", ".env");

const parsed = dotenv.parse(readFileSync(envPath));
for (const [key, value] of Object.entries(parsed)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// ── Self-contained tool resolution (added 2026-06-15 after a 3-layer outage) ──
// The pipeline shells out to `ffmpeg` (config FFMPEG_PATH || "ffmpeg") and
// yt-dlp, which needs a JS runtime (deno) to solve TikTok's JS challenge.
// Historically both were resolved via the machine's user PATH — fragile:
//   • ffmpeg lived in D:\anh_khanh\ffmpeg\bin (another user's dir) and vanished
//     → every FFmpeg call failed → 0 posts.
//   • deno wasn't installed → yt-dlp fell back to a flaky native-Python JS
//     solver → most TikTok downloads failed.
// We now bundle ffmpeg in the repo's own bin/ and prepend both that and the
// deno install dir to PATH, so spawned tools resolve regardless of user PATH.
import { existsSync } from "fs";
import { homedir } from "os";

const repoBin = join(__dirname, "..", "bin");
const denoBin = join(homedir(), ".deno", "bin");
const sep = process.platform === "win32" ? ";" : ":";
const extraPaths = [repoBin, denoBin].filter(existsSync);
if (extraPaths.length) {
  process.env.PATH = extraPaths.join(sep) + sep + (process.env.PATH || "");
}

// Prefer the bundled ffmpeg over a bare "ffmpeg" PATH lookup.
const bundledFfmpeg = join(repoBin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
if (!process.env.FFMPEG_PATH && existsSync(bundledFfmpeg)) {
  process.env.FFMPEG_PATH = bundledFfmpeg;
}
