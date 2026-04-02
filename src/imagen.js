/**
 * Gemini Imagen — generate images from text prompts.
 * Used as fallback when Veo video quota is exhausted.
 * Images get Ken Burns effect in FFmpeg to create motion.
 */
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

let _client;
function client() {
  if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _client;
}

/**
 * Generate an image from a text prompt using Gemini.
 *
 * @param {string} prompt - Image description
 * @param {string} outputPath - Where to save the PNG
 * @returns {Promise<{path: string, sizeBytes: number}>}
 */
export async function generateImage(prompt, outputPath) {
  const dir = dirname(outputPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Try Imagen 4.0 Fast first (best quality), fallback to Gemini Flash Image
  let buffer;
  try {
    const response = await client().models.generateImages({
      model: "imagen-4.0-fast-generate-001",
      prompt,
      config: { numberOfImages: 1, aspectRatio: "9:16" },
    });
    const img = response.generatedImages?.[0];
    if (!img?.image?.imageBytes) throw new Error("No image data");
    buffer = Buffer.from(img.image.imageBytes, "base64");
  } catch (e) {
    // Fallback: Gemini Flash with image output
    console.log(`[Imagen] Imagen 4.0 failed (${e.message}), trying Gemini Flash Image...`);
    const response = await client().models.generateContent({
      model: "gemini-2.5-flash-image",
      contents: prompt,
      config: { responseModalities: ["IMAGE"] },
    });
    const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!part) throw new Error("No image generated from any model");
    buffer = Buffer.from(part.inlineData.data, "base64");
  }
  writeFileSync(outputPath, buffer);

  return { path: outputPath, sizeBytes: buffer.length };
}
