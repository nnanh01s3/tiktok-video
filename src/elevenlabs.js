/**
 * ElevenLabs TTS integration.
 * Converts text script to AI voiceover audio file.
 */
import { writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";

const API_BASE = "https://api.elevenlabs.io/v1";

export async function generateVoiceover(script, outputPath, options = {}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const voiceId = options.voiceId || process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Default: Adam (deep, inspirational)
  const model = options.model || "eleven_multilingual_v2";

  const response = await fetch(`${API_BASE}/text-to-speech/${voiceId}`, {
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
        stability: options.stability ?? 0.5,
        similarity_boost: options.similarityBoost ?? 0.75,
        style: options.style ?? 0.3,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${err}`);
  }

  const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);

  return {
    path: outputPath,
    sizeBytes: buffer.length,
    voiceId,
    model,
  };
}

export async function listVoices() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const response = await fetch(`${API_BASE}/voices`, {
    headers: { "xi-api-key": apiKey },
  });

  if (!response.ok) throw new Error(`ElevenLabs API error ${response.status}`);

  const data = await response.json();
  return data.voices.map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    labels: v.labels,
  }));
}
