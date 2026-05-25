import { join } from "node:path";

const BASE_DIR = "D:/tiktok/douyin";

export const DOUYIN_CONFIG = {
  // Discovery
  keywords: ["百岁觉醒"],
  creators: [],
  maxPerRun: 3,
  minViewCount: 100_000,

  // Chrome CDP
  chromePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  chromeUserDataDir: process.env.DOUYIN_CHROME_PROFILE || "C:/Users/nnanh01/AppData/Local/douyin-cdp-profile",
  chromeRemotePortBase: 9223,

  // OCR
  ocr: {
    sampleIntervalMs: 300,
    minConfidence: 0.6,
    minCues: 5,
    cropBottomRatio: 0.4,
    cropOffsetRatio: 0.55,
  },

  // Subtitle style
  subtitle: {
    fontName: "Be Vietnam Pro",
    fontFallback: "Arial Unicode MS",
    fontSize: 18,
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    backColour: "&H80000000",
    outline: 2,
    shadow: 0,
    marginV: 80,
    alignment: 2,
  },

  // Compose
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 23,
    preset: "medium",
    cropTopPct: 0.08,
    cropBottomPct: 0.05,
  },

  // Publish channels
  channels: {
    tiktok:    { enabled: false, pfmTtId: null,  provider: "postforme" },
    fb_reels:  { enabled: false, pfmId: null,    provider: "postforme" },
    fb_page:   { enabled: false, pfmId: null,    provider: "postforme" },
    yt_shorts: { enabled: false, pfmYtId: null,  provider: "postforme" },
  },

  // Caption
  caption: {
    maxChars: 80,
    requiredHashtags: ["#trendingvideo", "#trend"],
  },

  // Paths
  baseDir: BASE_DIR,
  stateFile: join(BASE_DIR, "state.json"),
  logFile: join(BASE_DIR, "repurpose.log"),
  pythonScript: "scripts/paddle_ocr_batch.py",
};
