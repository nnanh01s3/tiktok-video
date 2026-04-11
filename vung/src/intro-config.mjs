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
 *   - imagenPrompt: starting frame description (Imagen 4.0 generates this).
 *                   Used when chainFromPrevious is false OR for the very first
 *                   sub-shot. Sub-shots with chainFromPrevious:true use the
 *                   last frame of the previous clip instead.
 *   - motionPrompt: how Veo should animate the starting frame.
 *   - durationSec: nominal duration (informational; Veo outputs 8s).
 *   - chainFromPrevious: if true, Veo uses the previous clip's last frame
 *                        as its starting image (pixel-level continuity → true
 *                        one-shot feel). If false, Imagen generates a fresh
 *                        starting frame (used when we need specific content
 *                        like the wooden sign with carved text).
 *
 * Scene 1 flow (24s total, xfade transitions):
 *   Sub 1 (0-8s):   Outer space → diving through atmosphere (fresh Imagen)
 *   Sub 2 (8-16s):  Through clouds → reveal magical forest with waterfall,
 *                   wooden bridge, flowers, butterflies (CHAINED from sub 1)
 *   Sub 3 (16-24s): Camera glides along stream → wooden signpost with
 *                   "RUNG XI TIN" carved on it (fresh Imagen for text)
 *
 * With 0.5s xfade crossfades: effective duration ~23s.
 */

const COMMON_NEGATIVE = "NO TEXT, NO LETTERS, NO WRITING, NO SIGNS WITH TEXT, NO LOGOS";

/**
 * Series intro: sub-shots that compose the opening cinematic.
 *
 * Final intro is 2 sub-shots (clouds→forest, then stream→signpost) totalling
 * ~15.5s after 0.5s xfade. This is the approved version after user feedback:
 * "chúng ta bỏ đi 8s đầu của tap_01_final.mp4, bắt đầu từ scene_01_sub02_v4.mp4"
 *
 * The "space_to_atmosphere" sub-shot is KEPT in this config with the
 * `excludeFromConcat: true` flag so:
 *   1. The existing scene_01_sub01_v4.mp4 file is NOT deleted (user rule:
 *      "khi làm bạn đừng xóa đi video cũ")
 *   2. The render loop still iterates it (cached → $0 re-cost)
 *   3. The final concat excludes it, producing a 2-sub-shot intro
 *
 * If a future episode wants the full 3-sub-shot intro (with space opening),
 * flip the flag back to false.
 */
export const INTRO_SUBSHOTS = [
  {
    id: "space_to_atmosphere",
    durationSec: 8,
    chainFromPrevious: false, // first shot — Imagen generates starting frame
    excludeFromConcat: true,  // preserved on disk, excluded from final cut
    imagenPrompt: [
      "Earth viewed from outer space, fluffy white clouds wrapping around the planet",
      "Green continents and blue oceans visible through cloud breaks",
      "Golden sunlight illuminating the edge of the atmosphere",
      "Stars and colorful nebula in dark cosmic background",
      "Cinematic wide angle, magical fairytale atmosphere",
      "Pixar 3D cartoon style, vibrant saturated colors, no realism",
      COMMON_NEGATIVE,
    ].join(". "),
    motionPrompt: [
      "Camera rapidly zooms from outer space toward Earth",
      "Smooth cinematic diving descent through the atmosphere",
      "Earth grows larger filling the frame, cloud layer approaching",
      "Camera plunges into fluffy white clouds at the end",
      "Motion blur, sense of speed, Pixar 3D cartoon style",
      "Cinematic establishing shot, one continuous camera movement",
    ].join(". "),
  },
  {
    id: "clouds_to_magical_forest",
    durationSec: 8,
    // Chain from sub-shot 1's last frame (clouds) for seamless continuity —
    // no visible cut, the cloud-plunge continues naturally into this shot.
    chainFromPrevious: true,
    imagenPrompt: [
      // Fallback only — used if chain extraction fails
      "Flying through fluffy white clouds above a magical pixar forest",
      "Waterfall and wooden bridge visible below",
      "Pixar 3D cartoon style, vibrant magical atmosphere",
      COMMON_NEGATIVE,
    ].join(". "),
    motionPrompt: [
      "Camera bursts through the fluffy white clouds, parting them aside",
      "Below reveals a vibrant magical pixar-style forest",
      "A beautiful cascading WATERFALL flows down mossy rocks on one side",
      "A WOODEN BRIDGE crosses a sparkling stream running through the forest",
      "COLORFUL FLOWERS bloom along the stream banks",
      "BUTTERFLIES flutter gracefully through the air",
      "Sparkling fireflies drift in golden sunlight rays piercing the canopy",
      "Camera continues descending smoothly into the forest",
      "Pixar 3D cartoon, cinematic flowing camera movement, one continuous shot",
    ].join(". "),
  },
  {
    id: "stream_to_signpost",
    durationSec: 8,
    // Fresh Imagen required — we need guaranteed wooden sign with "RUNG XI TIN"
    // text carved on it. Chaining would rely on Veo's weak text rendering.
    // The xfade transition + matching forest color palette hide the cut.
    chainFromPrevious: false,
    imagenPrompt: [
      "A beautiful large wooden signpost standing in a sunlit magical forest clearing",
      "The wooden sign has large bold letters carved into it reading \"RUNG XI TIN\" at the top",
      "The text is clearly readable, carved into golden brown wood, English-style font",
      "A sparkling stream flows past the sign in the foreground",
      "A small WOODEN BRIDGE visible in the background crossing the stream",
      "Colorful FLOWERS blooming around, BUTTERFLIES fluttering nearby",
      "A cascading WATERFALL visible in the distant background",
      "Magical fairytale atmosphere, golden hour lighting, cute pixar 3D cartoon style",
      "Lush green grass, sparkling fireflies drifting in golden light",
      "NO other text in the scene besides the \"RUNG XI TIN\" sign",
    ].join(". "),
    motionPrompt: [
      "Camera glides forward gently along a sparkling stream through the magical forest",
      "Moving smoothly past colorful flowers, fluttering butterflies, and mossy rocks",
      "A wooden signpost appears in a sunlit clearing ahead with \"RUNG XI TIN\" carved on it",
      "Camera slowly approaches and settles on the wooden sign",
      "Final shot lingers on the sign showing the title clearly",
      "Smooth flowing camera, golden hour lighting, fireflies drifting",
      "Pixar 3D cartoon style, cinematic gentle motion, one continuous shot",
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
    chainFromPrevious: false,
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
 * @returns {Array<{id, durationSec, chainFromPrevious, imagenPrompt, motionPrompt}>}
 */
export function getSubShotsForTitleScene(scene) {
  if (scene.isFirstScene) return INTRO_SUBSHOTS;
  if (scene.isLastScene) return OUTRO_SUBSHOTS;
  // Fallback: single empty sub-shot (shouldn't reach here for title scenes)
  return INTRO_SUBSHOTS.slice(0, 1);
}
