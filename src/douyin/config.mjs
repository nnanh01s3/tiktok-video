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
    // PaddleOCR PP-OCRv5 has an onednn model-loading bug on this Windows
    // machine — every run stalls then times out (5 min wasted per video)
    // before falling back to ASR. Disabled; Whisper is now the primary path.
    enabled: false,
    sampleIntervalMs: 300,
    minConfidence: 0.6,
    minCues: 5,
    cropBottomRatio: 0.4,
    cropOffsetRatio: 0.55,
  },

  // Subtitle transcription: faster-whisper (forced-aligned timestamps) is the
  // primary source so subtitles match when each line is actually spoken.
  // Gemini multimodal ASR is the fallback (good transcription, estimated timing).
  whisper: {
    enabled: true,
    lang: "zh",
    model: "large-v3",   // CPU int8 ~0.4x realtime; drop to "medium" if too slow
  },

  // Subtitle style.
  // NOTE: with `original_size=1080x1920` in the subtitle filter, FontSize and
  // MarginV are interpreted in ACTUAL output pixels. Without it, libass uses
  // a virtual PlayRes 384×288 and scales values up ~6.67×. Compose hardcodes
  // original_size so these values are pixel-accurate.
  subtitle: {
    fontName: "Be Vietnam Pro",
    fontFallback: "Arial Unicode MS",
    fontSize: 52,                       // ~3.7% of frame height, readable on phones
    primaryColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    backColour: "&H80000000",
    outline: 3,                         // thicker outline for the larger font
    shadow: 0,
    marginV: 80,                        // fallback for portrait sources (no bottom bar)
    alignment: 2,
  },

  // Recap mode (解说/thuyết minh style — like VN anime-recap channels):
  // continuous VN narration + caption box + ducked original BGM, 16:9 output.
  recap: {
    width: 1280,
    height: 720,
    crf: 23,
    preset: "ultrafast",
    bgmVolume: 0.15,          // duck original audio to 15% under the narration
    // Caption style (ASS): opaque box behind text (BorderStyle=4), bottom-center.
    caption: {
      fontName: "Be Vietnam Pro",
      fontSize: 34,           // relative to 1280x720
      primaryColour: "&H00FFFFFF",   // white text
      backColour: "&H99000000",      // ~60% opaque black box
      outlineColour: "&H00000000",
      borderStyle: 4,         // 4 = opaque box (vs 1 = outline+shadow)
      outline: 0,
      shadow: 0,
      marginV: 60,
      alignment: 2,           // bottom-center
    },
    // Optional channel logo overlay (PNG with transparency). null = skip.
    logoPath: null,
    logoX: 20,                // top-left position
    logoY: 20,
    logoWidthPx: 180,
  },

  // Compose
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 23,
    preset: "ultrafast",
    cropTopPct: 0.08,
    cropBottomPct: 0.18,
    // Letterbox mode: scale to fit canvas WITHOUT cropping (decrease, not
    // increase), pad sides with black. For landscape source this creates
    // visible bars top+bottom and we position subtitle inside the bottom bar.
    // For portrait source the bars are small/zero.
    letterbox: true,
    backgroundColor: "black",  // pad color
  },

  // TTS (Vietnamese voice-over narration)
  tts: {
    // OFF for anime episodes: these have continuous original audio (BGM + SFX
    // + voice acting) and dialogue that's rapid + expands ~3.8x in Vietnamese,
    // so cue-by-cue TTS overruns its time slots and overlaps, AND replacing the
    // original audio loses the music/effects that make the clip worth watching.
    // Subtitle-only + original audio is the correct treatment (standard fansub
    // model). Turn back on only for recap/解说 content with a single narrator.
    enabled: false,
    // MS Edge TTS voice. Vietnamese options:
    //   vi-VN-NamMinhNeural (male, mid-age, calm) — best for cultivation/cổ trang
    //   vi-VN-HoaiMyNeural  (female, young)
    voice: "vi-VN-NamMinhNeural",
    // Speech rate. "+0%" = normal. "+15%" = faster (compress TTS to fit shorter cue
    // durations). MS Edge accepts -50% to +200%.
    rate: "+0%",
    pitch: "+0Hz",
    // Replace original CN audio entirely with VN TTS (true) or duck-mix CN at 15%
    // under VN TTS (false). For storytelling content with single narrator
    // overlapping in both languages, REPLACE is cleaner.
    replaceOriginal: true,
    // When true, normalize generated TTS loudness via loudnorm filter.
    normalize: true,
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
