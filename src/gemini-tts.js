/**
 * Gemini TTS module — Google's high-quality text-to-speech.
 *
 * Uses Gemini 2.5 Flash TTS (cheaper) or Pro TTS (premium).
 * Supports 30 voices. For Vietnamese motivation content, best voices:
 *   - Orus: Firm, decisive — best for authority/motivation
 *   - Algenib: Gravelly texture — best for deep, mature feel
 *   - Sadaltager: Knowledgeable, authoritative
 *   - Charon: Informative, clear
 *
 * Output: raw PCM → saved as WAV file.
 * Cost: Flash TTS ~$0.01/video, Pro TTS ~$0.02/video
 */
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "fs";
import { dirname } from "path";
import { execSync } from "child_process";

let _client;
function client() {
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

// Voice presets for different content styles
export const GEMINI_VOICES = {
  // Deep male voices — ideal for motivation/quotes
  deep_authoritative: "Orus",       // Firm, decisive
  deep_gravelly: "Algenib",         // Gravelly texture, mature
  deep_wise: "Sadaltager",          // Knowledgeable, authoritative
  deep_clear: "Charon",             // Informative, clear

  // Other useful voices
  warm_male: "Fenrir",              // Excitable
  calm_male: "Enceladus",           // Breathy, calm
  storyteller: "Puck",              // Upbeat, versatile
};

// Default voice for our channel — Algenib: gravelly, deep, mature
const DEFAULT_VOICE = GEMINI_VOICES.deep_gravelly; // Algenib

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Generate voiceover using Gemini TTS.
 *
 * @param {string} text - Script text to convert to speech
 * @param {string} outputPath - Output file path (.mp3 or .wav)
 * @param {Object} [options]
 * @param {string} [options.voice] - Voice name (default: Orus)
 * @param {string} [options.model] - TTS model (default: gemini-2.5-flash-preview-tts)
 * @param {string} [options.style] - Natural language style instruction
 * @returns {Promise<{provider, path, sizeBytes, voice, model}>}
 */
export async function generateGeminiTTS(text, outputPath, options = {}) {
  const voice = options.voice || DEFAULT_VOICE;
  const model = options.model || "gemini-2.5-flash-preview-tts";

  // Style instruction for deep, mature, powerful delivery
  const styleInstruction = options.style ||
    "Speak in a deep, mature, powerful male voice. Slow and deliberate pace. " +
    "Authoritative and inspiring tone, like a wise mentor sharing life lessons. " +
    "Pause briefly between sentences for dramatic effect.";

  // Combine style instruction with the actual text
  const fullText = `${styleInstruction}\n\n${text}`;

  // Voice consistency: retry hard before falling back to Edge TTS.
  // User locked the voice to Algenib — switching to Edge changes the voice
  // audibly, breaking brand consistency across videos. 5 retries with
  // exponential backoff (1s, 2s, 4s, 8s, 16s) give Gemini ~30s total to
  // recover from transient errors (500, rate limits, timeouts).
  const MAX_RETRIES = 5;
  let lastError;
  let pcmBuffer;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client().models.generateContent({
        model,
        contents: [{ parts: [{ text: fullText }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      });

      const part = response.candidates?.[0]?.content?.parts?.[0];
      if (!part?.inlineData?.data) {
        throw new Error("Gemini TTS returned no audio data");
      }

      pcmBuffer = Buffer.from(part.inlineData.data, "base64");
      if (attempt > 0) {
        console.log(`[Gemini TTS] ✓ succeeded on retry ${attempt + 1} (voice=${voice})`);
      }
      break; // success — exit retry loop
    } catch (err) {
      lastError = err;
      const isRetryable =
        /5\d\d|rate.*limit|timeout|ECONN|ENOTFOUND|fetch failed|transient/i.test(
          String(err?.message || "")
        );
      if (attempt < MAX_RETRIES - 1 && isRetryable) {
        const backoffMs = 1000 * 2 ** attempt; // 1s, 2s, 4s, 8s, 16s
        console.log(
          `[Gemini TTS] attempt ${attempt + 1}/${MAX_RETRIES} failed ` +
          `(${err.message?.slice(0, 80)}), retrying in ${backoffMs}ms...`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      // Non-retryable OR last attempt failed — bubble up (tts.js will
      // fall back to Edge as last resort, with prominent warning)
      throw err;
    }
  }

  if (!pcmBuffer) throw lastError || new Error("Gemini TTS exhausted retries");

  ensureDir(outputPath);

  // Save as WAV first, then convert to MP3 if needed
  const wavPath = outputPath.replace(/\.(mp3|wav)$/, ".wav");
  writeWavFile(wavPath, pcmBuffer, 1, 24000, 16);

  let finalPath = outputPath;
  let finalSize;

  if (outputPath.endsWith(".mp3")) {
    // Convert WAV → MP3 using FFmpeg
    try {
      execSync(
        `ffmpeg -y -i "${wavPath}" -codec:a libmp3lame -b:a 128k "${outputPath}"`,
        { stdio: "pipe", timeout: 30000 }
      );
      finalSize = statSync(outputPath).size;
      // Clean up WAV
      unlinkSync(wavPath);
    } catch (e) {
      // If FFmpeg fails, keep WAV
      finalPath = wavPath;
      finalSize = pcmBuffer.length + 44; // WAV header
      console.warn("[Gemini TTS] FFmpeg MP3 conversion failed, keeping WAV:", e.message);
    }
  } else {
    finalPath = wavPath;
    finalSize = pcmBuffer.length + 44;
  }

  return {
    provider: "gemini-tts",
    path: finalPath,
    sizeBytes: finalSize,
    voice,
    model,
  };
}

/**
 * Write raw PCM data as a WAV file.
 */
function writeWavFile(filename, pcmData, channels = 1, sampleRate = 24000, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);

  // fmt subchunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);        // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);         // AudioFormat (PCM = 1)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const wavBuffer = Buffer.concat([header, pcmData]);
  writeFileSync(filename, wavBuffer);
}
