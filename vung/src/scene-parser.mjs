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
//
// Supports TWO header formats:
//
// v1 (two H1 lines):
//   # 🎬 RỪNG XÌ TIN - TẬP 1
//   # QUẢ CHUỐI BÍ ẨN
//
// v2 (one combined H1 line):
//   # 🎬 RỪNG XÌ TIN - TẬP 1: QUẢ CHUỐI BÍ ẨN
function parseHeader(lines) {
  let episodeNumber = 0;
  let episodeTitle = "";

  for (const line of lines.slice(0, 10)) {
    // Extract episode number from any line mentioning "TẬP N"
    const numMatch = line.match(/T[ẬẬ]P\s+(\d+)/i);
    if (numMatch) episodeNumber = parseInt(numMatch[1], 10);

    // v2 combined format: "# 🎬 RỪNG XÌ TIN - TẬP 1: QUẢ CHUỐI BÍ ẨN"
    // Look for H1 line containing "TẬP N:" followed by the episode title
    if (!episodeTitle) {
      const combinedMatch = line.match(/^#\s+.*T[ẬẬ]P\s+\d+\s*[:\-–—]\s*(.+?)\s*$/i);
      if (combinedMatch) {
        episodeTitle = combinedMatch[1].trim();
        continue;
      }
    }

    // v1 separate format: second H1 line (not the series header, not VEO tag)
    if (!episodeTitle && /^#\s+[^🎬]/.test(line) && !line.includes("RỪNG") && !line.includes("VEO")) {
      episodeTitle = line.replace(/^#\s+/, "").trim();
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
  // Extract content between "### sectionName ..." and the next "###" or end.
  //
  // The `[^\\n]*` after the section name allows trailing words on the same
  // header line. This handles both v1 format (e.g. `### Mục tiêu`) and v2
  // format (e.g. `### Mục tiêu scene`, `### Breakdown theo từng giây`,
  // `### Âm thanh / nhạc / SFX`).
  const pattern = new RegExp(
    `###\\s*${sectionName}[^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s|\\n---|$)`,
    "i"
  );
  const m = sceneText.match(pattern);
  return m ? m[1].trim() : "";
}

function parseBreakdown(breakdownText) {
  // Supports TWO breakdown formats:
  //
  // v1 (inline):
  //   * **Giây 1–2:** description of beat 1...
  //   * **Giây 3–4:** description of beat 2...
  //
  // v2 (header + bullet list):
  //   **Giây 1**
  //
  //   * Khung hình cực rộng: Trái Đất hiện...
  //   * Mặt trời ló từ mép trái phía sau Trái Đất...
  //
  //   **Giây 2**
  //
  //   * Camera tăng tốc...
  //
  // Returns an array where each entry is one beat (for v2, all bullets under
  // a Giây header are concatenated into a single beat description).
  if (!breakdownText) return [];
  const lines = breakdownText.split("\n");
  const items = [];
  let currentBeat = null; // null = not inside a v2 beat; string = v2 beat accumulating

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, ""); // rtrim only (preserve leading indent)

    // v1 format: * **Giây 1–2:** text...
    const v1Match = line.match(/^\s*\*\s*\*\*Giây[^*]*\*\*:?\s*(.+)/);
    if (v1Match) {
      if (currentBeat !== null && currentBeat.trim()) items.push(currentBeat.trim());
      items.push(v1Match[1].trim());
      currentBeat = null;
      continue;
    }

    // v2 format: **Giây N** on its own line (header, no text after)
    // Also tolerate "**Giây 3** 🟢" style decorations after the marker.
    const v2Header = line.match(/^\s*\*\*Giây\s+\d+\*\*\s*\S*\s*$/);
    if (v2Header) {
      if (currentBeat !== null && currentBeat.trim()) items.push(currentBeat.trim());
      currentBeat = "";
      continue;
    }

    // Accumulate v2 bullet lines into the current beat
    if (currentBeat !== null) {
      const bulletMatch = line.match(/^\s*\*\s+(.+)/);
      if (bulletMatch) {
        // Strip bold markers and smart-quote wrappers so we get clean prose
        const content = bulletMatch[1]
          .replace(/\*\*/g, "")
          .trim();
        currentBeat += (currentBeat ? " " : "") + content;
      }
    }
  }

  // Finalize last v2 beat
  if (currentBeat !== null && currentBeat.trim()) {
    items.push(currentBeat.trim());
  }
  return items;
}

/**
 * Extract CTA text overlays from breakdown text.
 *
 * Supports TWO script formats:
 *
 * v1 format (standalone markers):
 *   * **Giây 7–8:** Text hiện lên + voice over:
 *
 *     👉 Text:
 *     "👉 ĐÓN XEM TẬP 2: WIFI RỪNG BỊ LAG!"
 *
 *     👉 Voice (giọng vui):
 *     "Đừng bỏ lỡ tập tiếp theo nhé!"
 *
 * v2 format (embedded bold-quoted CTA in beat content):
 *   **Giây 8**
 *
 *   * Text hiện lớn, rõ:
 *     **"👉 ĐÓN XEM TẬP 2: WIFI RỪNG BỊ LAG!"**
 *
 * In v2, the voice-over for CTA is declared as a regular dialogue line
 * inside the "Lời thoại" section using character "Voice Over", which is
 * aliased to "narrator" in parseDialogue → normalizeCharacterKey. So this
 * function only needs to extract the textOverlays for v2.
 *
 * Returns:
 *   - textOverlays: array of CTA text strings (FFmpeg drawtext overlays)
 *   - voiceOvers: v1 narrator lines (v2 handles these via dialogue parser)
 */
function parseCtaFromBreakdown(breakdownText) {
  const textOverlays = [];
  const voiceOvers = [];
  if (!breakdownText) return { textOverlays, voiceOvers };

  const lines = breakdownText.split("\n");
  const stripQuotes = (s) =>
    s.replace(/^[\u201C\u201D"']+|[\u201C\u201D"']+$/g, "").trim();

  // v1 standalone markers — "👉 Text:" or "Text:" on its own line
  const textMarker = /^(?:👉\s*)?Text\s*:?\s*$/;
  // v1 "👉 Voice:" or "👉 Voice (giọng vui):" — optional direction
  const voiceMarker = /^(?:👉\s*)?Voice(?:\s*\(([^)]+)\))?\s*:?\s*$/;

  // v2 embedded format — a bold-wrapped quoted string like
  //   **"👉 ĐÓN XEM TẬP 2: WIFI RỪNG BỊ LAG!"**
  // Detected by bold markers + smart/straight quotes around CTA-like content.
  // Uses unicode class matching to handle both " and curly quotes.
  const v2EmbeddedCta = /^\s*\*\*\s*["\u201C\u201D]([^"\u201C\u201D\n]{5,200})["\u201C\u201D]\s*\*\*\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // v2: embedded bold-quoted CTA on its own line
    const v2Match = line.match(v2EmbeddedCta);
    if (v2Match) {
      textOverlays.push(v2Match[1].trim());
      continue;
    }

    // v1: standalone "Text:" marker + quoted content on next non-empty line
    if (textMarker.test(line)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const next = stripQuotes(lines[j].trim());
        if (next) {
          textOverlays.push(next);
          break;
        }
      }
      continue;
    }

    // v1: standalone "Voice:" marker
    const voiceMatch = line.match(voiceMarker);
    if (voiceMatch) {
      const direction = voiceMatch[1]?.trim() || null;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const next = stripQuotes(lines[j].trim());
        if (next) {
          voiceOvers.push({
            character: "narrator",
            text: next,
            direction,
          });
          break;
        }
      }
      continue;
    }
  }

  return { textOverlays, voiceOvers };
}

// Normalize a character name: lowercased, trimmed, alias-resolved.
// "Voice Over"/"VO" → "narrator" (maps to Charon voice in voices.mjs).
function normalizeCharacterKey(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().trim();
  // Alias table — keep in sync with voices.mjs
  if (key === "voice over" || key === "voiceover" || key === "vo") return "narrator";
  return key;
}

// Strip timing prefixes like "giây 6, " from direction strings so TTS
// receives just the acting direction ("thì thầm", "hét lớn"), not metadata.
function cleanDialogueDirection(raw) {
  if (!raw) return null;
  // Remove "giây N" or "giây N-M" at the start, followed by optional separator
  const cleaned = raw
    .replace(/^giây\s+\d+(?:\s*[-–—]\s*\d+)?\s*[,\.\-–—]?\s*/i, "")
    .trim();
  return cleaned || null;
}

function parseDialogue(dialogueText) {
  // Supports TWO dialogue formats:
  //
  // v1 (multi-line):
  //   **Momo (thì thầm):**
  //   "Đây chắc chắn là..."
  //
  // v2 (bullet single-line with timing info):
  //   * **Momo (giây 6, thì thầm):** "Đây chắc chắn là..."
  //   * **Voice Over (giây 8):** "Đừng bỏ lỡ..."
  //
  // v2 direction contains a timing prefix like "giây 6, " which we strip
  // before passing to TTS. v2 also introduces "Voice Over" character which
  // is aliased to "narrator" (Charon voice) via normalizeCharacterKey.
  if (!dialogueText) return [];

  const lines = dialogueText.split("\n");
  const result = [];
  let currentChar = null;
  let currentDirection = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Character line: **Name:** or **Name (direction):**
    // Allow optional bullet prefix "* " for v2 format.
    const charMatch = line.match(/^(?:\*\s+)?\*\*([^(*]+?)(?:\s*\(([^)]+)\))?\s*:\*\*/);
    if (charMatch) {
      currentChar = normalizeCharacterKey(charMatch[1]);
      currentDirection = cleanDialogueDirection(charMatch[2]);
      // Sometimes text is on the SAME line after the ":**"
      const rest = line.replace(charMatch[0], "").trim();
      if (rest && rest !== "") {
        const cleaned = rest.replace(/^[\u201C\u201D"']+|[\u201C\u201D"']+$/g, "").trim();
        if (cleaned) {
          result.push({ character: currentChar, text: cleaned, direction: currentDirection });
          currentDirection = null;
        }
      }
      continue;
    }

    // Bullet line without a character match: skip narrative notes
    if (line.startsWith("*") && !currentChar) continue;

    // Dialogue text line (usually quoted) for v1 multi-line format
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

  const scenes = sceneSections.map((section, idx) => {
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
    // "Breakdown" matches both v1 ("### Breakdown theo giây") and v2
    // ("### Breakdown theo từng giây") — extractSection allows trailing
    // chars after the prefix name, so passing just "Breakdown" captures
    // everything until the next ### section.
    const breakdownText = extractSection(section, "Breakdown");
    const breakdown = parseBreakdown(breakdownText);
    const dialogueText = extractSection(section, "Lời thoại");
    const parsedDialogue = parseDialogue(dialogueText);
    const sfxText = extractSection(section, "Âm thanh");
    const sfx = parseSfx(sfxText);

    // Extract CTA text overlays + voice-over narrator lines from breakdown
    // (for scenes like scene 15 with "👉 Text:" / "👉 Voice:" markers)
    const { textOverlays: ctaTextOverlays, voiceOvers } =
      parseCtaFromBreakdown(breakdownText);

    // Narrator voice-overs are appended to dialogue — they go through the
    // same TTS pipeline as regular dialogue (character: "narrator" → Charon
    // voice via voices.mjs). They stay in script order, so narrator lines
    // after character lines play after them in the composer's dialogue loop.
    const dialogue = [...parsedDialogue, ...voiceOvers];

    const characters = extractCharactersFromBreakdown(breakdown, dialogue);
    const visualDescription = breakdown.join(" ") || goal;

    // Detect title scenes — only scene 1 (always intro) is a template-based
    // title scene. The last scene is rendered from its actual breakdown even
    // if its heading says "KẾT"/"CTA" — per "bám sát kịch bản" rule, we
    // never substitute user-authored beats with a generic template.
    const isFirstScene = header.id === 1;
    const isLastScene = idx === sceneSections.length - 1;
    const isTitle = isFirstScene;

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
      isTitle,
      isFirstScene,
      isLastScene,
      textOverlays: ctaTextOverlays, // from script breakdown; scene 1 overwrites below
    };
  });

  // Post-process: scene 1 always uses template-based text overlays
  // (series branding) regardless of breakdown content. Other scenes keep
  // whatever parseCtaFromBreakdown extracted (empty array if no CTA markers).
  const SERIES_TITLE = "🌳 RỪNG XÌ TIN";
  for (const scene of scenes) {
    if (scene.isFirstScene) {
      scene.textOverlays = [
        SERIES_TITLE,
        `TẬP ${episodeNumber}: ${episodeTitle}`,
      ];
    }
  }

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
