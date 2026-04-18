/**
 * Character voice mapping for Rừng Xì Tin series.
 *
 * Maps each character to:
 *   - Gemini TTS voice (prebuilt voice name)
 *   - Style instruction (how the AI should deliver the line)
 *   - Character prompt (visual description, reused across scenes)
 *
 * Character prompts copied from inputs/characters.md — keep in sync if those change.
 * Narrator voice used for title cards and CTA.
 */

/** @typedef {"momo" | "tiko" | "lala" | "bobo" | "narrator"} CharacterKey */

export const CHARACTERS = {
  momo: {
    name: "Momo",
    role: "monkey",
    voice: "Puck", // Upbeat, versatile
    style: "Speak fast, mischievous, playful, energetic. Vietnamese with clear diction.",
    visualPrompt: "a mischievous monkey, slim body, light brown fur, cream face, big expressive eyes, playful smile, long tail, energetic pose",
    negativePrompt: "realistic monkey, scary, dark, aggressive, low quality, blurry, extra limbs",
  },
  tiko: {
    name: "Tiko",
    role: "turtle",
    voice: "Sadaltager", // Knowledgeable, slow, authoritative
    style: "Speak slow, calm, wise, thoughtful. Deliberate pauses. Vietnamese.",
    visualPrompt: "a wise turtle, green shell with hex pattern, wearing round glasses, calm expression, slightly slow posture, small gentle smile",
    negativePrompt: "realistic turtle, ugly, broken shell, dark tone, low quality",
  },
  lala: {
    name: "Lala",
    role: "fox",
    voice: "Aoede", // Bright, feminine
    style: "Speak dramatic, high-pitched, sassy, expressive. Vietnamese.",
    visualPrompt: "a stylish fox, orange fur, white chest and tail tip, big fluffy tail, confident expression, slightly feminine style, elegant pose",
    negativePrompt: "realistic fox, aggressive, dark, horror, low quality",
  },
  bobo: {
    name: "Bobo",
    role: "bear",
    voice: "Fenrir", // Warm, excitable
    style: "Speak slow, silly, warm, a bit confused but friendly. Vietnamese.",
    visualPrompt: "a chubby bear, brown fur, big belly, round face, small eyes, friendly and a bit silly expression",
    negativePrompt: "realistic bear, scary, angry, dark, low quality",
  },
  narrator: {
    name: "Narrator",
    role: "voice-over",
    voice: "Charon", // Informative, clear
    style: "Speak clear, warm, storytelling tone. Vietnamese.",
    visualPrompt: null,
    negativePrompt: null,
  },
  // ── Secondary characters (appear in specific episodes) ──
  "sóc phụ": {
    name: "Sóc phụ",
    role: "squirrel-extra",
    voice: "Puck", // Upbeat, quick
    style: "Speak quick, casual. Vietnamese.",
    visualPrompt: "a small squirrel, brown fur, fluffy tail, cute expression",
    negativePrompt: null,
  },
  chim: {
    name: "Chim",
    role: "bird-messenger",
    voice: "Fenrir", // Warm
    style: "Speak casual, relaxed. Vietnamese.",
    visualPrompt: "a small colorful bird, messenger bird perched on a branch",
    negativePrompt: null,
  },
  "chim khác": {
    name: "Chim khác",
    role: "bird-messenger-2",
    voice: "Sadaltager", // Calm
    style: "Speak chill, nonchalant. Vietnamese.",
    visualPrompt: "a different small bird, slightly different color from the first bird",
    negativePrompt: null,
  },
  "thỏ rừng": {
    name: "Thỏ rừng",
    role: "rabbit-extra",
    voice: "Aoede", // Bright
    style: "Speak cheerful, fast, excited. Vietnamese.",
    visualPrompt: "a small cute rabbit, white and brown fur, long ears, energetic",
    negativePrompt: null,
  },
};

/**
 * Master style prompt applied to ALL scene images for consistency.
 * Copied from inputs/characters.md § MASTER PROMPT.
 */
export const MASTER_STYLE_PROMPT =
  "cute 3D cartoon, pixar style, vibrant forest environment, soft cinematic lighting, " +
  "consistent character design, high detail, expressive faces, smooth animation look, " +
  "9:16 vertical aspect ratio";

export const MASTER_NEGATIVE_PROMPT =
  "realistic, photorealistic, scary, dark, horror, low quality, blurry, distorted, " +
  "extra limbs, text, watermark, logo";

// Character name aliases — map common script variants to canonical keys.
// Keep in sync with parseDialogue → normalizeCharacterKey in scene-parser.mjs
// (parser normalizes before reaching here, but this is a safety net for
// any direct getCharacter() callers that don't go through the parser).
const CHARACTER_ALIASES = {
  "voice over": "narrator",
  "voiceover": "narrator",
  "vo": "narrator",
  "sóc": "sóc phụ",
  "sóc con": "sóc phụ",
  "vo / chim đưa tin": "narrator",
  "thỏ rừng": "thỏ rừng",
};

/**
 * Lookup a character by lowercase name/key. Case-insensitive.
 * Applies alias resolution (e.g. "Voice Over" → "narrator").
 * @param {string} name
 * @returns {typeof CHARACTERS[CharacterKey] | null}
 */
export function getCharacter(name) {
  if (!name) return null;
  let key = name.toLowerCase().trim();
  key = CHARACTER_ALIASES[key] || key;
  return CHARACTERS[key] || null;
}

/**
 * Build a character visual prompt string, including all characters that
 * appear in a scene. Used for Imagen scene generation.
 *
 * @param {string[]} characterNames - e.g., ["momo", "bobo"]
 * @returns {string} — concatenated visual prompts
 */
export function buildCharacterPrompt(characterNames) {
  const parts = [];
  for (const name of characterNames) {
    const char = getCharacter(name);
    if (char?.visualPrompt) {
      parts.push(`${char.name}: ${char.visualPrompt}`);
    }
  }
  return parts.join(". ");
}
