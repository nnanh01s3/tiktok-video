/**
 * Scene parser for Rừng Xì Tin episode scripts.
 *
 * Episode format (from tap_01_qua_chuoi_bi_an.md):
 *
 *   # 🎬 RỪNG XÌ TIN - TẬP N
 *   # <EPISODE TITLE>
 *   # VEO DETAILED VERSION
 *   ⏱ Cấu trúc: 15 scene x 8 giây
 *
 *   ## 🎬 SCENE 01 - <SCENE TITLE>
 *   ⏱ 0:00 - 0:08
 *
 *   ### Mục tiêu
 *   ...
 *
 *   ### Breakdown theo giây
 *   * **Giây 1–2:** ...
 *   * **Giây 3–4:** ...
 *
 *   ### Lời thoại  (optional)
 *   **Character:**
 *   "text..."
 *
 *   ### Âm thanh
 *   * ...
 *
 * This parser uses regex — deterministic, fast, no API calls.
 * If a new episode breaks the format, parser throws with a clear error.
 */
import { readFileSync } from "fs";
import { getCharacter } from "./voices.mjs";

/**
 * @typedef {Object} DialogueLine
 * @property {string} character  - lowercase key ("momo", "tiko"...)
 * @property {string} text       - line text
 * @property {string} [direction] - e.g., "thì thầm" (whispering) — optional stage direction
 */

/**
 * @typedef {Object} ParsedScene
 * @property {number} id             - 1-based scene number
 * @property {string} title          - e.g., "MỞ ĐẦU + TITLE"
 * @property {string} timeRange      - e.g., "0:00 - 0:08"
 * @property {number} startSec       - parsed start second
 * @property {number} endSec         - parsed end second
 * @property {number} duration       - endSec - startSec
 * @property {string} goal           - content of "### Mục tiêu"
 * @property {string[]} breakdown    - bullet points under "Breakdown theo giây"
 * @property {string} visualDescription - joined breakdown (for image/video prompts)
 * @property {DialogueLine[]} dialogue
 * @property {string[]} characters   - lowercase character keys appearing in this scene
 * @property {string[]} sfx          - sound effects / audio notes
 */

/**
 * @typedef {Object} ParsedEpisode
 * @property {number} episodeNumber  - e.g., 1
 * @property {string} episodeTitle   - e.g., "QUẢ CHUỐI BÍ ẨN"
 * @property {string} sourceFile     - path to original .md
 * @property {ParsedScene[]} scenes
 * @property {number} totalDuration  - sum of scene durations
 */

// ── Time parsing ─────────────────────────────────────────────────────────
function parseTimestamp(ts) {
  // "0:00" → 0, "1:28" → 88
  const m = ts.match(/(\d+):(\d+)/);
  if (!m) throw new Error(`Invalid timestamp: "${ts}"`);
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function parseTimeRange(line) {
  // "⏱ 0:00 - 0:08"
  const m = line.match(/(\d+:\d+)\s*[-–—]\s*(\d+:\d+)/);
  if (!m) return null;
  return {
    timeRange: `${m[1]} - ${m[2]}`,
    startSec: parseTimestamp(m[1]),
    endSec: parseTimestamp(m[2]),
  };
}

// ── Episode header parsing ───────────────────────────────────────────────
function parseHeader(lines) {
  let episodeNumber = 0;
  let episodeTitle = "";

  for (const line of lines.slice(0, 10)) {
    // "# 🎬 RỪNG XÌ TIN - TẬP 1"
    const numMatch = line.match(/T[ẬẬ]P\s+(\d+)/i);
    if (numMatch) episodeNumber = parseInt(numMatch[1], 10);

    // "# QUẢ CHUỐI BÍ ẨN" (the second H1 after the series title)
    if (/^#\s+[^🎬]/.test(line) && !line.includes("RỪNG") && !line.includes("VEO")) {
      if (!episodeTitle) episodeTitle = line.replace(/^#\s+/, "").trim();
    }
  }

  return { episodeNumber, episodeTitle };
}

// ── Scene section parsing ───────────────────────────────────────────────
function splitScenes(content) {
  // Split by "## 🎬 SCENE" — each section is one scene
  // Keep the delimiter by using positive lookahead
  const sections = content.split(/(?=^##\s*🎬\s*SCENE\s*\d+)/m);
  return sections.filter((s) => /##\s*🎬\s*SCENE/.test(s));
}

function parseSceneHeader(headerLine) {
  // "## 🎬 SCENE 01 - MỞ ĐẦU + TITLE"
  const m = headerLine.match(/SCENE\s*(\d+)\s*[-–—]\s*(.+)/i);
  if (!m) return null;
  return {
    id: parseInt(m[1], 10),
    title: m[2].trim(),
  };
}

function extractSection(sceneText, sectionName) {
  // Extract content between "### sectionName" and the next "###" or end
  const pattern = new RegExp(
    `###\\s*${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|\\n---|$)`,
    "i"
  );
  const m = sceneText.match(pattern);
  return m ? m[1].trim() : "";
}

function parseBreakdown(breakdownText) {
  // "* **Giây 1–2:** description..." → array of descriptions
  if (!breakdownText) return [];
  const lines = breakdownText.split("\n");
  const items = [];
  for (const line of lines) {
    const m = line.match(/^\s*\*\s*\*\*Giây[^*]*\*\*:?\s*(.+)/);
    if (m) items.push(m[1].trim());
  }
  return items;
}

function parseDialogue(dialogueText) {
  // Format:
  //   **Momo (thì thầm):**
  //   "Đây chắc chắn là..."
  //
  //   **Bobo:**
  //   "Momo giấu gì vậy ta?"
  if (!dialogueText) return [];

  const lines = dialogueText.split("\n");
  const result = [];
  let currentChar = null;
  let currentDirection = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Character line: **Name:** or **Name (direction):**
    const charMatch = line.match(/^\*\*([^(*]+?)(?:\s*\(([^)]+)\))?:\*\*/);
    if (charMatch) {
      currentChar = charMatch[1].trim().toLowerCase();
      currentDirection = charMatch[2]?.trim() || null;
      // Sometimes text is on the SAME line after the ":**"
      const rest = line.replace(charMatch[0], "").trim();
      if (rest && rest !== "") {
        const cleaned = rest.replace(/^[\u201C\u201D"']+|[\u201C\u201D"']+$/g, "").trim();
        if (cleaned) {
          result.push({ character: currentChar, text: cleaned, direction: currentDirection });
        }
      }
      continue;
    }

    // Bullet line: "* Không cần thoại dài." — skip narrative notes, no char
    if (line.startsWith("*") && !currentChar) continue;

    // Dialogue text line (usually quoted)
    if (currentChar) {
      const cleaned = line.replace(/^[\u201C\u201D"']+|[\u201C\u201D"']+$/g, "").replace(/^\*\s*/, "").trim();
      if (cleaned && !cleaned.startsWith("*")) {
        result.push({ character: currentChar, text: cleaned, direction: currentDirection });
        currentDirection = null; // direction applies to first line only
      }
    }
  }
  return result;
}

function parseSfx(sfxText) {
  if (!sfxText) return [];
  return sfxText
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s*/, "").trim())
    .filter(Boolean);
}

function extractCharactersFromBreakdown(breakdown, dialogue) {
  // Collect character keys mentioned in breakdown text OR in dialogue
  const known = ["momo", "tiko", "lala", "bobo"];
  const found = new Set();

  for (const d of dialogue) {
    if (known.includes(d.character)) found.add(d.character);
  }
  const text = breakdown.join(" ").toLowerCase();
  for (const name of known) {
    if (text.includes(name)) found.add(name);
  }
  return [...found];
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Parse an episode markdown file into structured data.
 *
 * @param {string} filePath - absolute path to episode .md file
 * @returns {ParsedEpisode}
 */
export function parseEpisode(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const { episodeNumber, episodeTitle } = parseHeader(lines);

  if (!episodeNumber || !episodeTitle) {
    throw new Error(
      `Could not parse episode header from ${filePath}. ` +
      `Expected "# 🎬 RỪNG XÌ TIN - TẬP N" and "# <EPISODE TITLE>" near the top.`
    );
  }

  const sceneSections = splitScenes(content);
  if (sceneSections.length === 0) {
    throw new Error(
      `No scenes found in ${filePath}. ` +
      `Expected sections starting with "## 🎬 SCENE NN - ..."`
    );
  }

  const scenes = sceneSections.map((section) => {
    const sectionLines = section.split("\n");
    const header = parseSceneHeader(sectionLines[0]);
    if (!header) {
      throw new Error(`Malformed scene header: "${sectionLines[0]}"`);
    }

    // Find the time range line (usually right after header)
    let timeInfo = null;
    for (const line of sectionLines.slice(1, 5)) {
      const parsed = parseTimeRange(line);
      if (parsed) { timeInfo = parsed; break; }
    }
    if (!timeInfo) {
      throw new Error(`No time range (⏱) found in scene ${header.id}`);
    }

    const goal = extractSection(section, "Mục tiêu");
    const breakdownText = extractSection(section, "Breakdown theo giây");
    const breakdown = parseBreakdown(breakdownText);
    const dialogueText = extractSection(section, "Lời thoại");
    const dialogue = parseDialogue(dialogueText);
    const sfxText = extractSection(section, "Âm thanh");
    const sfx = parseSfx(sfxText);
    const characters = extractCharactersFromBreakdown(breakdown, dialogue);
    const visualDescription = breakdown.join(" ") || goal;

    return {
      id: header.id,
      title: header.title,
      timeRange: timeInfo.timeRange,
      startSec: timeInfo.startSec,
      endSec: timeInfo.endSec,
      duration: timeInfo.endSec - timeInfo.startSec,
      goal,
      breakdown,
      visualDescription,
      dialogue,
      characters,
      sfx,
    };
  });

  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);

  return {
    episodeNumber,
    episodeTitle,
    sourceFile: filePath,
    scenes,
    totalDuration,
  };
}

/**
 * Validate that a parsed episode is suitable for Veo generation.
 * Throws descriptive errors if something's wrong.
 */
export function validateEpisode(episode) {
  const errors = [];

  if (episode.scenes.length === 0) {
    errors.push("Episode has no scenes");
  }

  for (const scene of episode.scenes) {
    if (scene.duration > 8) {
      errors.push(
        `Scene ${scene.id} "${scene.title}" is ${scene.duration}s — Veo 2.0 max is 8s`
      );
    }
    if (scene.duration <= 0) {
      errors.push(`Scene ${scene.id} has invalid duration ${scene.duration}s`);
    }
    if (!scene.visualDescription) {
      errors.push(`Scene ${scene.id} has no visual description (breakdown)`);
    }
    for (const d of scene.dialogue) {
      if (!getCharacter(d.character)) {
        errors.push(
          `Scene ${scene.id} has unknown character "${d.character}" — ` +
          `add to voices.mjs or fix script`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error("Episode validation failed:\n  - " + errors.join("\n  - "));
  }
  return true;
}
