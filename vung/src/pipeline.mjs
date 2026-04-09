/**
 * Rừng Xì Tin — main pipeline orchestrator.
 *
 * Usage:
 *   node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md
 *   node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md --dry-run
 *   node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md --only-scenes 1,2,3
 *   node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md --skip-render
 *   node vung/src/pipeline.mjs --episode tap_01_qua_chuoi_bi_an.md --skip-compose
 *
 * Flow:
 *   1. Parse episode markdown → scenes
 *   2. For each scene: generate image, clip, dialogue audio (resumable)
 *   3. Compose final video (concat + mix audio)
 *   4. (future) Post to TikTok via tiktok-direct.mjs
 *
 * Output: vung/output/tap_NN/tap_NN_final.mp4
 */
import "../../src/env.js";
import { existsSync, mkdirSync } from "fs";
import { basename, resolve } from "path";
import { parseEpisode, validateEpisode } from "./scene-parser.mjs";
import { renderScene } from "./scene-renderer.mjs";
import { composeVideo, findBackgroundMusic } from "./composer.mjs";
import { getQuotaStatus, loadKeys } from "./gemini-keys.js";

// ── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function flag(name) {
  return args.includes(name);
}

const episodeArg = arg("--episode");
const dryRun = flag("--dry-run");
const skipRender = flag("--skip-render");
const skipCompose = flag("--skip-compose");
const onlyScenes = arg("--only-scenes"); // "1,3,5" or "1-5"

if (!episodeArg) {
  console.error(
    "Usage: node vung/src/pipeline.mjs --episode <file.md> [flags]\n" +
    "Flags:\n" +
    "  --dry-run          Parse + validate only, no generation\n" +
    "  --only-scenes N,M  Render only specific scenes (e.g., 1,2,3 or 1-5)\n" +
    "  --skip-render      Skip scene rendering (assets must exist)\n" +
    "  --skip-compose     Skip final video composition"
  );
  process.exit(1);
}

// Resolve episode file path (accept relative to vung/ or absolute)
function resolveEpisodePath(p) {
  if (existsSync(p)) return resolve(p);
  const candidates = [
    `D:/tiktok/vung/${p}`,
    `D:/tiktok/vung/${p}.md`,
    `D:/tiktok/${p}`,
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`Episode file not found: ${p}`);
}

function parseSceneFilter(str) {
  if (!str) return null;
  const out = new Set();
  for (const part of str.split(",")) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = parseInt(range[1], 10); i <= parseInt(range[2], 10); i++) out.add(i);
    } else {
      out.add(parseInt(part, 10));
    }
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const episodePath = resolveEpisodePath(episodeArg);
  console.log(`📖 Episode file: ${episodePath}\n`);

  // Step 1: Parse
  const episode = parseEpisode(episodePath);
  console.log(`Tập ${episode.episodeNumber}: "${episode.episodeTitle}"`);
  console.log(`Scenes: ${episode.scenes.length}, Total: ${episode.totalDuration}s\n`);
  validateEpisode(episode);

  // Output dir
  const tapSlug = `tap_${String(episode.episodeNumber).padStart(2, "0")}`;
  const outputDir = `D:/tiktok/vung/output/${tapSlug}`;
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  // Scene filter (if --only-scenes)
  const sceneFilter = parseSceneFilter(onlyScenes);
  const scenesToRender = sceneFilter
    ? episode.scenes.filter((s) => sceneFilter.has(s.id))
    : episode.scenes;

  if (sceneFilter) {
    console.log(`🔍 Filter: only scenes [${[...sceneFilter].join(", ")}]\n`);
  }

  // Print dialogue summary
  const totalDialogue = episode.scenes.reduce((sum, s) => sum + s.dialogue.length, 0);
  const allChars = new Set();
  episode.scenes.forEach((s) => s.characters.forEach((c) => allChars.add(c)));
  console.log(`Characters: ${[...allChars].join(", ")}`);
  console.log(`Dialogue lines: ${totalDialogue}\n`);

  // Quota check
  const status = getQuotaStatus();
  const keys = loadKeys();
  console.log(`🔑 ${keys.length} API keys loaded. Remaining quotas:`);
  for (const [model, q] of Object.entries(status)) {
    console.log(`   ${model.padEnd(8)} ${q.remaining}/${q.total}`);
  }
  console.log();

  // Required budget check
  const neededVeo = scenesToRender.length;
  const neededImagen = scenesToRender.length;
  const neededTts = scenesToRender.reduce((sum, s) => sum + s.dialogue.length, 0);

  console.log(`📊 Generation budget for ${scenesToRender.length} scenes:`);
  console.log(`   Imagen: need ${neededImagen}, available ${status.imagen.remaining}`);
  console.log(`   Veo:    need ${neededVeo}, available ${status.veo.remaining}`);
  console.log(`   TTS:    need ${neededTts}, available ${status.tts.remaining}`);

  if (status.veo.remaining < neededVeo) {
    console.log(
      `   ⚠ Veo quota insufficient (need ${neededVeo}, have ${status.veo.remaining}). ` +
      `Pipeline will render ${status.veo.remaining} scenes then stop.`
    );
  }
  console.log();

  if (dryRun) {
    console.log("🏁 Dry run — exiting before generation.");
    return;
  }

  // Step 2: Render each scene
  const rendered = [];
  if (!skipRender) {
    console.log("🎬 Rendering scenes...\n");
    for (const scene of scenesToRender) {
      console.log(`─── Scene ${scene.id}/${episode.scenes.length}: ${scene.title} ───`);
      try {
        const result = await renderScene(scene, outputDir);
        rendered.push({ scene, ...result });
      } catch (err) {
        console.error(`[Pipeline] Scene ${scene.id} failed: ${err.message}`);
        if (err.message.includes("exhausted for")) {
          console.error(`[Pipeline] Stopping — retry tomorrow when quota resets.`);
          break;
        }
        throw err;
      }
      console.log();
    }
  } else {
    console.log("⏭ Skipping render, loading existing assets...\n");
    for (const scene of scenesToRender) {
      const sceneIdPadded = String(scene.id).padStart(2, "0");
      rendered.push({
        scene,
        imagePath: `${outputDir}/scene_${sceneIdPadded}.png`,
        clipPath: `${outputDir}/scene_${sceneIdPadded}.mp4`,
        dialogue: scene.dialogue.map((d, i) => ({
          path: `${outputDir}/voice_${sceneIdPadded}_${i}_${d.character}.wav`,
          character: d.character,
          text: d.text,
        })),
      });
    }
  }

  if (rendered.length === 0) {
    console.log("❌ No scenes rendered, nothing to compose");
    process.exit(1);
  }

  // Step 3: Compose final video
  if (!skipCompose) {
    console.log(`🎞 Composing final video from ${rendered.length} scenes...\n`);
    const finalPath = `${outputDir}/${tapSlug}_final.mp4`;
    const bgMusic = findBackgroundMusic();
    if (bgMusic) console.log(`🎵 Using background music: ${basename(bgMusic)}`);

    await composeVideo(rendered, finalPath, { bgMusic, musicVolume: 0.15 });
    console.log(`\n✅ Done! Video ready at: ${finalPath}`);
  } else {
    console.log("⏭ Skipping composition");
  }

  // Print final quota state
  const finalStatus = getQuotaStatus();
  console.log("\n📊 Final quota usage:");
  for (const [model, q] of Object.entries(finalStatus)) {
    const used = q.total - q.remaining;
    console.log(`   ${model.padEnd(8)} used ${used}/${q.total}`);
  }
}

main().catch((err) => {
  console.error("\n❌ Pipeline fatal:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
