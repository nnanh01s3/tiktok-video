/**
 * Alternative download path when yt-dlp is blocked by Douyin anti-bot.
 *
 * Strategy: use Chrome CDP to load the Douyin video page (cookies + fingerprint
 * match a real browser), capture the video .mp4 URL from network events, then
 * fetch it with the same User-Agent + Referer.
 *
 * yt-dlp's Douyin web-detail-JSON API endpoint is heavily anti-bot guarded
 * (X-Bogus signature etc) so it returns empty JSON to non-browser callers.
 * Loading the actual video page through Chrome bypasses this entirely.
 */
import "../env.js";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream, existsSync, statSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DOUYIN_CONFIG } from "./config.mjs";
import { createLogger } from "./utils/log.mjs";

const log = createLogger(DOUYIN_CONFIG.logFile);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pickPort() {
  return DOUYIN_CONFIG.chromeRemotePortBase + 100 + Math.floor(Math.random() * 50);
}

function killStaleProfile() {
  try {
    spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*douyin-cdp-profile*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ], { timeout: 10000 });
  } catch {}
  spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 2"], { timeout: 5000 });
  for (const name of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      const p = join(DOUYIN_CONFIG.chromeUserDataDir, name);
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  }
}

/**
 * Download a Douyin video by modal_id using Chrome CDP to fetch the mp4 URL.
 * Returns { mp4_path, info } same shape as download.mjs.
 */
export async function cdpDownload(modal_id) {
  const outDir = join(DOUYIN_CONFIG.baseDir, modal_id);
  mkdirSync(outDir, { recursive: true });
  const mp4_path = join(outDir, "original.mp4");
  const info_json_path = join(outDir, "original.info.json");

  if (existsSync(mp4_path) && statSync(mp4_path).size > 100_000) {
    log.info("cdp-download", `skip — already exists for ${modal_id}`);
    return { mp4_path, info_json_path };
  }

  await killStaleProfile();

  const port = pickPort();
  const videoPageUrl = `https://www.douyin.com/video/${modal_id}`;
  mkdirSync(DOUYIN_CONFIG.chromeUserDataDir, { recursive: true });

  // Non-headless required: Douyin fingerprints headless Chrome and serves
  // captcha intermediate page (验证码中间页) instead of the video player.
  // Same root cause as discover.mjs needing headless: false for search.
  log.info("cdp-download", `launching Chrome (windowed) on port ${port}`);
  const proc = spawn(`"${DOUYIN_CONFIG.chromePath}"`, [
    "--start-minimized",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${DOUYIN_CONFIG.chromeUserDataDir}`,
    "--window-size=1280,800",
    "--no-first-run",
    "--disable-blink-features=AutomationControlled",
    "--autoplay-policy=no-user-gesture-required",
    videoPageUrl,
  ], { shell: true, detached: true, stdio: "ignore" });
  proc.unref();

  // Retry CDP connection
  let tabs = null;
  for (let attempt = 1; attempt <= 15; attempt++) {
    await sleep(2000);
    try {
      const tabsRes = await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(3000) });
      tabs = await tabsRes.json();
      if (Array.isArray(tabs) && tabs.length > 0) break;
    } catch (e) {
      if (attempt === 15) throw new Error(`CDP not reachable on port ${port} after 30s: ${e.message}`);
    }
  }

  const tab = tabs.find(t => t.type === "page") || tabs[0];
  const { default: WS } = await import("ws");
  const ws = new WS(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  let nextId = 1;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    const handler = d => {
      const m = JSON.parse(d.toString());
      if (m.id === id) { ws.off("message", handler); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.off("message", handler); rej(new Error(`CDP timeout: ${method}`)); }, 20000);
  });

  const videoCandidates = new Map(); // url → { type, size, found_at }

  // Watch network for media-type responses.
  // Exclude Douyin's static asset CDN (douyinstatic.com) which serves the
  // loading-spinner animation `uuu_265.mp4` — that's NOT the actual video.
  // The real video comes from douyinvod.com / aweme.snssdk.com / v*.douyinvod.com.
  const STATIC_HOSTS = /douyinstatic\.com|p\d+\.douyinpic\.com|p\d+-pc\.douyinpic/i;
  const VIDEO_HOSTS = /douyinvod\.com|aweme\.snssdk\.com|byteimg\.com.*\.mp4|v\d+(-pc|-dy|-web)?\.douyinvod\.com/i;

  ws.on("message", d => {
    try {
      const m = JSON.parse(d.toString());
      if (m.method === "Network.responseReceived") {
        const { response } = m.params;
        const url = response.url;
        const mime = response.mimeType || "";

        if (STATIC_HOSTS.test(url)) return; // skip UI animations

        const looksLikeVideo =
          mime.startsWith("video/") ||
          VIDEO_HOSTS.test(url) ||
          (/\.mp4(\?|$)/i.test(url) && !STATIC_HOSTS.test(url));

        if (looksLikeVideo) {
          const len = response.headers && (response.headers["Content-Length"] || response.headers["content-length"]);
          if (!videoCandidates.has(url)) {
            videoCandidates.set(url, { type: mime, size: len ? parseInt(len) : 0, found_at: Date.now() });
          }
        }
      }
    } catch {}
  });

  try {
    await cdp("Page.enable");
    await cdp("Network.enable");
    await cdp("Runtime.enable");
    await sleep(2000);

    // Force navigation (in case Chrome arg URL didn't trigger)
    await cdp("Page.navigate", { url: videoPageUrl });

    // Wait for video to load + try to trigger play
    await sleep(8000);
    try {
      await cdp("Runtime.evaluate", {
        expression: "document.querySelectorAll('video').forEach(v => { v.muted = true; v.play().catch(()=>{}); })"
      });
    } catch {}
    await sleep(8000);

    // Capture page metadata (title, description)
    let infoMeta = {};
    try {
      const titleRes = await cdp("Runtime.evaluate", {
        expression: "JSON.stringify({ title: document.title, ogTitle: document.querySelector('meta[property=\"og:title\"]')?.content, desc: document.querySelector('meta[name=\"description\"]')?.content })",
        returnByValue: true,
      });
      infoMeta = JSON.parse(titleRes?.result?.value || "{}");
    } catch {}

    // Try to extract video URL directly from <video> element too
    let videoSrcFromDom = null;
    try {
      const r = await cdp("Runtime.evaluate", {
        expression: "document.querySelector('video')?.src || ''",
        returnByValue: true,
      });
      videoSrcFromDom = r?.result?.value || null;
      if (videoSrcFromDom && videoSrcFromDom.startsWith("http")) {
        videoCandidates.set(videoSrcFromDom, { type: "video/mp4", source: "dom" });
      }
    } catch {}

    log.info("cdp-download", `captured ${videoCandidates.size} video URL candidates`);
    for (const [url, meta] of videoCandidates) {
      log.info("cdp-download", `  → ${(meta.size / 1024).toFixed(0)}KB type=${meta.type} ${url.slice(0, 100)}`);
    }

    if (!videoCandidates.size) {
      throw new Error(`No video URL captured from CDP for ${modal_id}. Page may not have loaded — check Douyin login.`);
    }

    // Douyin uses DASH — video and audio are separate streams. URL patterns:
    //   tos-cn-ve-* = video-only (h264)
    //   tos-cn-vd-* = video-only alt quality
    //   tos-cn-ae-* = audio-only (aac)
    // For storytelling content we need to fetch both and mux with ffmpeg.
    // Strategy: probe each candidate, sort by HEAD content-length, fetch top 2,
    // identify which is video and which is audio by ffprobe, mux them.

    const uaPath = join(DOUYIN_CONFIG.baseDir, "ua.txt");
    const ua = existsSync(uaPath)
      ? readFileSync(uaPath, "utf8").trim()
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

    const fetchHeaders = {
      "User-Agent": ua,
      "Referer": "https://www.douyin.com/",
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Range": "bytes=0-",
    };

    // Probe each candidate via HEAD to get true Content-Length
    const probed = [];
    for (const url of videoCandidates.keys()) {
      try {
        const head = await fetch(url, { method: "HEAD", headers: { ...fetchHeaders, Range: undefined } });
        const cl = parseInt(head.headers.get("content-length") || "0");
        probed.push({ url, size: cl });
      } catch {}
    }
    probed.sort((a, b) => b.size - a.size);
    log.info("cdp-download", `probed sizes: ${probed.map(p => `${(p.size/1024/1024).toFixed(1)}MB`).join(" / ")}`);

    // Fetch each candidate to a temp file, then ffprobe to determine type
    const tmpFiles = [];
    for (let i = 0; i < Math.min(probed.length, 4); i++) {
      const tmp = join(outDir, `stream_${i}.mp4`);
      log.info("cdp-download", `downloading stream ${i} (${(probed[i].size/1024/1024).toFixed(1)} MB)`);
      const dlRes = await fetch(probed[i].url, { headers: fetchHeaders });
      if (!dlRes.ok) { log.warn("cdp-download", `stream ${i} fetch failed: ${dlRes.status}`); continue; }
      await pipeline(Readable.fromWeb(dlRes.body), createWriteStream(tmp));
      tmpFiles.push({ path: tmp, url: probed[i].url });
    }

    // Classify each tmp by codec_type
    let videoTmp = null, audioTmp = null;
    for (const t of tmpFiles) {
      const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", t.path], { encoding: "utf8", timeout: 15000 });
      if (r.status !== 0) continue;
      try {
        const probe = JSON.parse(r.stdout);
        const types = probe.streams.map(s => s.codec_type);
        if (types.includes("video") && !videoTmp) videoTmp = t.path;
        else if (types.includes("audio") && !audioTmp) audioTmp = t.path;
        log.info("cdp-download", `  classified ${t.path.split(/[\\/]/).pop()} → streams: ${types.join(",")}`);
      } catch {}
    }

    if (!videoTmp) throw new Error("No video stream found among CDP candidates");

    // Mux video + audio (or just copy video if no separate audio)
    log.info("cdp-download", `muxing → ${mp4_path}`);
    const muxArgs = audioTmp
      ? ["-y", "-i", videoTmp, "-i", audioTmp, "-c", "copy", "-map", "0:v:0", "-map", "1:a:0", mp4_path]
      : ["-y", "-i", videoTmp, "-c", "copy", mp4_path];
    const muxR = spawnSync("ffmpeg", muxArgs, { encoding: "utf8", timeout: 60000 });
    if (muxR.status !== 0) throw new Error(`mux failed: ${muxR.stderr.slice(-1000)}`);

    // Cleanup tmp files
    for (const t of tmpFiles) { try { (await import("node:fs")).unlinkSync(t.path); } catch {} }

    const size = statSync(mp4_path).size;
    if (size < 100_000) throw new Error(`downloaded file is suspiciously small: ${size} bytes`);

    log.info("cdp-download", `wrote ${mp4_path} (${(size / 1024 / 1024).toFixed(2)} MB)`);

    writeFileSync(info_json_path, JSON.stringify({
      modal_id,
      source_url: videoPageUrl,
      candidates: probed.map(p => ({ url: p.url, size: p.size })),
      video_only: !audioTmp,
      ...infoMeta,
      downloaded_at: new Date().toISOString(),
    }, null, 2));

    ws.close();
    return { mp4_path, info_json_path };
  } finally {
    try { proc.kill(); } catch {}
    spawnSync(`taskkill /F /PID ${proc.pid} 2>nul`, { shell: true, timeout: 5000 });
  }
}

// CLI smoke
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const id = process.argv[2];
  if (!id) { console.error("usage: cdp-download.mjs <modal_id>"); process.exit(1); }
  cdpDownload(id).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}
