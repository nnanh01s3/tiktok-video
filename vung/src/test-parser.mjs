/**
 * Test scene parser with tap_01_qua_chuoi_bi_an.md
 * Usage: node vung/src/test-parser.mjs
 */
import { parseEpisode, validateEpisode } from "./scene-parser.mjs";

const EPISODE_FILE = "D:/tiktok/vung/tap_01_qua_chuoi_bi_an.md";

console.log(`📖 Parsing: ${EPISODE_FILE}\n`);
const episode = parseEpisode(EPISODE_FILE);

console.log(`Episode ${episode.episodeNumber}: "${episode.episodeTitle}"`);
console.log(`Scenes: ${episode.scenes.length}`);
console.log(`Total duration: ${episode.totalDuration}s\n`);

console.log("Scenes breakdown:");
for (const s of episode.scenes) {
  const chars = s.characters.length ? `[${s.characters.join(",")}]` : "";
  const dlg = s.dialogue.length ? `${s.dialogue.length} dialogue` : "no dialogue";
  console.log(
    `  ${String(s.id).padStart(2)}. ${s.timeRange.padEnd(13)} ${s.duration}s  ${chars.padEnd(25)} ${dlg}`
  );
  console.log(`      title: "${s.title}"`);
  if (s.breakdown.length > 0) {
    console.log(`      beats: ${s.breakdown.length} (first: "${s.breakdown[0].slice(0, 60)}...")`);
  }
  if (s.dialogue.length > 0) {
    for (const d of s.dialogue) {
      const dir = d.direction ? ` (${d.direction})` : "";
      console.log(`      💬 ${d.character}${dir}: "${d.text.slice(0, 60)}"`);
    }
  }
}

console.log("\n🧪 Running validation...");
try {
  validateEpisode(episode);
  console.log("✅ Episode is valid — ready for generation");
} catch (err) {
  console.error("❌", err.message);
  process.exit(1);
}
