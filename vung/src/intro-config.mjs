/**
 * Intro / outro templates for Rừng Xì Tin series.
 *
 * The opening sequence (scene 1) is identical visually across episodes —
 * only the title text differs. By hardcoding the canonical sub-shots, we get:
 *   1. Consistent branding (every episode opens the same way)
 *   2. Reusable assets (Imagen images can be cached and reused)
 *   3. Predictable quality (we don't depend on Veo interpreting different prompts)
 *
 * Each sub-shot describes:
 *   - imagenPrompt: starting frame description (Imagen 4.0 generates this)
 *   - motionPrompt: how Veo should animate the starting frame
 *   - trimDuration: how many seconds to use from the 8s Veo output
 *
 * The trim strategy keeps the FIRST N seconds of each Veo clip (where motion
 * is most controlled). Later seconds in Veo clips often drift in unwanted ways.
 */

const COMMON_NEGATIVE = "NO TEXT, NO LETTERS, NO WRITING, NO SIGNS WITH TEXT, NO LOGOS";

/**
 * Series intro: 3 sub-shots that compose the opening cinematic.
 * Total: ~8 seconds (matches scene 1 budget).
 */
export const INTRO_SUBSHOTS = [
  {
    id: "space_to_atmosphere",
    durationSec: 2.5,
    trimDuration: 2.5,
    imagenPrompt: [
      "Earth viewed from outer space, bright golden sunlight illuminating the green continents",
      "Stars and nebula in dark cosmic background",
      "Cinematic wide angle, magical fairytale atmosphere",
      "Pixar 3D cartoon style, vibrant colors, no realism",
      COMMON_NEGATIVE,
    ].join(". "),
    motionPrompt: [
      "Camera rapidly zooms toward Earth from space",
      "Smooth diving descent toward a green forest region on the planet",
      "Cinematic establishing shot, motion blur, sense of speed",
      "Pixar 3D cartoon animation style",
    ].join(". "),
  },
  {
    id: "clouds_to_forest",
    durationSec: 2.5,
    trimDuration: 2.5,
    imagenPrompt: [
      "Camera flying through fluffy white clouds high above a magical forest",
      "Sunlight rays piercing through cloud gaps, sparkles in the air",
      "View looking down at vibrant green forest canopy below",
      "Pixar 3D cartoon style, vibrant magical fairytale atmosphere",
      COMMON_NEGATIVE,
    ].join(". "),
    motionPrompt: [
      "Camera breaks through fluffy clouds revealing a vibrant magical pixar-style forest below",
      "Smooth descent into the trees with sparkling fireflies floating around",
      "Butterflies fluttering, lush green canopy, golden sunlight rays",
      "Cinematic flowing camera movement, pixar 3D cartoon",
    ].join(". "),
  },
  {
    id: "forest_to_signpost",
    durationSec: 3.0,
    trimDuration: 3.0,
    imagenPrompt: [
      "A beautiful wooden signpost in a sunlit forest clearing",
      "Surrounded by colorful flowers, butterflies, and sparkling fireflies",
      "Magical fairytale atmosphere, golden hour lighting, cute pixar 3D cartoon style",
      "The wooden sign is BLANK — no text, no letters, no writing on it",
      "Lush green grass, distant trees in soft focus",
      COMMON_NEGATIVE,
    ].join(". "),
    motionPrompt: [
      "Camera floats forward gently toward a wooden signpost in a magical forest clearing",
      "Smooth approach through fireflies and butterflies",
      "Final shot lingers on the empty wooden sign with golden hour lighting",
      "Pixar 3D cartoon, cinematic gentle motion",
    ].join(". "),
  },
];

/**
 * Episode outro / CTA template (scene 15).
 * Single sub-shot — outro is simpler than intro.
 */
export const OUTRO_SUBSHOTS = [
  {
    id: "warm_sunset_forest",
    durationSec: 8.0,
    trimDuration: 8.0,
    imagenPrompt: [
      "Warm sunset forest scene with magical atmosphere",
      "Soft pink and orange sky, silhouetted trees, gentle bokeh lights",
      "Cute friendly inviting mood, cinematic wide shot",
      "Pixar 3D cartoon style, dreamy fairytale lighting",
      COMMON_NEGATIVE,
    ].join(". "),
    motionPrompt: [
      "Camera slowly pulls back from the sunset forest",
      "Gentle zoom out revealing more of the magical landscape",
      "Sparkling fireflies floating in warm golden light",
      "Pixar 3D cartoon, cinematic peaceful ending shot",
    ].join(". "),
  },
];

/**
 * Get sub-shots template for a title scene.
 *
 * @param {import("./scene-parser.mjs").ParsedScene} scene
 * @returns {Array<{id, durationSec, trimDuration, imagenPrompt, motionPrompt}>}
 */
export function getSubShotsForTitleScene(scene) {
  if (scene.isFirstScene) return INTRO_SUBSHOTS;
  if (scene.isLastScene) return OUTRO_SUBSHOTS;
  // Fallback: single empty sub-shot (shouldn't reach here for title scenes)
  return INTRO_SUBSHOTS.slice(0, 1);
}
