/**
 * Unified TTS module.
 *
 * Strategy:
 *   1. Gemini TTS (Algenib voice — gravelly, deep, mature) — primary
 *   2. Edge TTS (vi-VN-NamMinhNeural) — free fallback
 *
 * Edge TTS uses Microsoft's speech service via the msedge-tts package.
 */
import { writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

// Edge TTS voices — Vietnamese for motivation content
const EDGE_VOICES = {
  vi_male: "vi-VN-NamMinhNeural",     // Vietnamese male — deep, powerful with prosody tuning
  vi_female: "vi-VN-HoaiMyNeural",    // Vietnamese female, professional
  // English fallbacks (if needed)
  en_male_deep: "en-US-GuyNeural",
  en_male_casual: "en-US-DavisNeural",
};

// Prosody settings for deep, powerful, older male voice
const VOICE_PROSODY = {
  pitch: "-15%",    // Lower pitch → trầm hơn
  rate: "-10%",     // Slower rate → chậm rãi, có lực
  volume: "+10%",   // Slightly louder → ấm, rõ ràng
};

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Generate voiceover using Edge TTS (free, unlimited).
 * Uses msedge-tts package (pure JS, no TypeScript issues).
 */
async function useEdgeTTS(script, outputPath, options) {
  const { MsEdgeTTS } = await import("msedge-tts");
  const voice = options.edgeVoice || EDGE_VOICES.vi_male;

  ensureDir(outputPath);

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, "audio-24khz-96kbitrate-mono-mp3");

  // Apply prosody for deep, powerful voice
  const prosody = options.prosody || VOICE_PROSODY;
  const { audioStream } = tts.toStream(script, {
    pitch: prosody.pitch || "+0%",
    rate: prosody.rate || "+0%",
    volume: prosody.volume || "+0%",
  });

  // Collect stream into buffer then write file
  const chunks = [];
  await new Promise((resolve, reject) => {
    audioStream.on("data", (chunk) => {
      if (chunk instanceof Buffer) chunks.push(chunk);
    });
    audioStream.on("end", resolve);
    audioStream.on("error", reject);
  });

  const buffer = Buffer.concat(chunks);
  await writeFile(outputPath, buffer);

  return { provider: "edge-tts", path: outputPath, sizeBytes: buffer.length, voice };
}

/**
 * Generate voiceover — priority: Gemini TTS (Algenib) → Edge TTS.
 *
 * @param {string} script - Text to convert to speech
 * @param {string} outputPath - Where to save the audio file
 * @param {Object} [options]
 * @param {string} [options.provider] - Force provider: 'gemini' | 'edge'
 * @param {string} [options.voice] - Gemini voice name (default: Algenib)
 * @param {string} [options.style] - Gemini style instruction
 * @param {string} [options.edgeVoice] - Edge TTS voice name
 */
export async function generateVoiceover(script, outputPath, options = {}) {
  const forceProvider = options.provider;

  // Try Gemini TTS first (unless forced to edge)
  if (forceProvider !== "edge") {
    try {
      const { generateGeminiTTS } = await import("./gemini-tts.js");
      const result = await generateGeminiTTS(script, outputPath, {
        voice: options.voice,
        style: options.style,
      });
      return result;
    } catch (err) {
      console.log(`[TTS] Gemini TTS failed (${err.message}), falling back to Edge TTS`);
    }
  }

  // Fallback: Edge TTS (free, unlimited)
  return useEdgeTTS(script, outputPath, options);
}

export { EDGE_VOICES, VOICE_PROSODY };
