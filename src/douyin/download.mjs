/**
 * Download Douyin video via yt-dlp with browser-cookie session.
 *
 * Returns: { mp4_path, info_json_path, duration_sec, width, height, original_title }
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);

function ffprobeJson(mp4_path) {
  const r = spawnSync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    mp4_path,
  ], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export async function download(modal_id) {
  const outDir = join(DOUYIN_CONFIG.baseDir, modal_id);
  mkdirSync(outDir, { recursive: true });
  const mp4_path = join(outDir, "original.mp4");
  const info_json_path = join(outDir, "original.info.json");

  if (existsSync(mp4_path) && statSync(mp4_path).size > 100_000) {
    log.info("download", `skip — already exists for ${modal_id}`);
  } else {
    const videoUrl = `https://www.douyin.com/video/${modal_id}`;
    log.info("download", `yt-dlp ← ${videoUrl}`);

    // Prefer cookies.txt + ua.txt exported by login-export.mjs (avoids Windows
    // DPAPI failure + matches user-agent to cookies). Fall back to
    // --cookies-from-browser if cookies.txt is missing.
    const cookiesFile = join(DOUYIN_CONFIG.baseDir, "cookies.txt");
    const uaFile = join(DOUYIN_CONFIG.baseDir, "ua.txt");
    const cookieArgs = existsSync(cookiesFile)
      ? ["--cookies", cookiesFile]
      : ["--cookies-from-browser", "chrome"];
    const uaArgs = existsSync(uaFile)
      ? ["--user-agent", readFileSync(uaFile, "utf8").trim()]
      : [];

    const r = spawnSync("yt-dlp", [
      videoUrl,
      ...cookieArgs,
      ...uaArgs,
      "-o", join(outDir, "original.%(ext)s"),
      "--write-info-json",
      "--merge-output-format", "mp4",
      "--no-warnings",
    ], { encoding: "utf8", timeout: 300_000, shell: true });
    if (r.status !== 0) throw new Error(`yt-dlp failed (code ${r.status}): ${r.stderr || r.stdout}`);
    if (!existsSync(mp4_path)) throw new Error(`yt-dlp ran but no mp4 produced at ${mp4_path}`);
    if (statSync(mp4_path).size < 100_000) throw new Error(`download appears corrupt (<100KB)`);
  }

  const probe = ffprobeJson(mp4_path);
  const vStream = probe.streams.find(s => s.codec_type === "video");
  if (!vStream) throw new Error("no video stream in download");
  const duration_sec = parseFloat(probe.format.duration);
  if (Number.isNaN(duration_sec) || duration_sec <= 0) {
    throw new Error(`invalid duration: ${probe.format.duration}`);
  }

  let original_title = modal_id;
  if (existsSync(info_json_path)) {
    try {
      const info = JSON.parse(readFileSync(info_json_path, "utf8"));
      original_title = info.title || info.description || modal_id;
    } catch {}
  }

  return {
    mp4_path,
    info_json_path,
    duration_sec,
    width: vStream.width,
    height: vStream.height,
    original_title,
  };
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const id = process.argv[2];
  if (!id) { console.error("usage: download.mjs <modal_id>"); process.exit(1); }
  download(id).then(r => console.log(JSON.stringify(r, null, 2)));
}
