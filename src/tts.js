/**
 * Unified TTS module.
 *
 * Strategy:
 *   1. Try ElevenLabs first (premium quality)
 *   2. On quota/auth error → fallback to Edge TTS (free, unlimited)
 *   3. On explicit --tts=edge flag → skip ElevenLabs entirely
 *
 * Edge TTS uses Microsoft's speech service via the edge-tts package.
 * Quality is decent for TikTok — not as good as ElevenLabs but free.
 */
import { writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

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
 * Generate voiceover using ElevenLabs.
 * Returns null on quota/auth errors (caller should fallback).
 */
async function tryElevenLabs(script, outputPath, options) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  // "Adam" voice — deep, mature male. Good for Vietnamese motivation content.
  // Alternative: "Daniel" (onwK4e9ZLDjBPHTpiIRo) — British, authoritative
  // Alternative: "Callum" (N2lVS1w4EtoT3dr4eOWO) — mature, low, calm
  const voiceId = options.voiceId || process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
  const model = options.model || "eleven_multilingual_v2";

  try {
    const response = await fetch(`${ELEVENLABS_API}/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: script,
        model_id: model,
        voice_settings: {
          stability: options.stability ?? 0.65,        // Higher → more consistent deep tone
          similarity_boost: options.similarityBoost ?? 0.80,  // Higher → truer to voice character
          style: options.style ?? 0.45,              // Mid-high → expressive but controlled
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      // Quota or auth errors → fallback
      if (response.status === 401 || response.status === 429 || err.includes("quota_exceeded")) {
        console.log(`[TTS] ElevenLabs unavailable (${response.status}), falling back to Edge TTS`);
        return null;
      }
      throw new Error(`ElevenLabs error ${response.status}: ${err}`);
    }

    ensureDir(outputPath);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(outputPath, buffer);

    return { provider: "elevenlabs", path: outputPath, sizeBytes: buffer.length, voiceId };
  } catch (err) {
    if (err.message.includes("quota_exceeded") || err.message.includes("401")) {
      console.log(`[TTS] ElevenLabs error: ${err.message}, falling back to Edge TTS`);
      return null;
    }
    throw err;
  }
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
 * Generate voiceover — priority: Gemini TTS → Edge TTS.
 *
 * ElevenLabs removed — Gemini TTS is better quality and cheaper.
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
