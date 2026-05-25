/**
 * SRT parser/serializer.
 * Cue shape: { index: number, start_ms: number, end_ms: number, text: string }
 */

const TS_RE = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;

function tsToMs(ts) {
  const m = ts.trim().match(TS_RE);
  if (!m) throw new Error(`Invalid SRT timestamp: ${ts}`);
  const [, h, mn, s, ms] = m;
  return (+h) * 3600_000 + (+mn) * 60_000 + (+s) * 1000 + (+ms);
}

function msToTs(ms) {
  const h = Math.floor(ms / 3600_000);
  const mn = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(r).padStart(3,"0")}`;
}

export function parseSRT(src) {
  const cues = [];
  const blocks = src.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim());
    if (lines.length < 2) continue;
    let i = 0;
    let index;
    if (/^\d+$/.test(lines[0])) {
      index = parseInt(lines[0], 10);
      i = 1;
    }
    const timeLine = lines[i];
    if (!timeLine) continue;
    const m = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!m) continue;
    const start_ms = tsToMs(m[1]);
    const end_ms = tsToMs(m[2]);
    const text = lines.slice(i + 1).filter(l => l.length > 0).join("\n");
    if (!text) continue;
    cues.push({ index: index ?? cues.length + 1, start_ms, end_ms, text });
  }
  return cues;
}

export function serializeSRT(cues) {
  return cues.map((c, i) =>
    `${c.index ?? i + 1}\n${msToTs(c.start_ms)} --> ${msToTs(c.end_ms)}\n${c.text}\n`
  ).join("\n") + "\n";
}

export function validateSRTMatch(src, translated, toleranceMs = 50) {
  const errors = [];
  if (src.length !== translated.length) {
    errors.push(`cue count mismatch: src=${src.length} vs translated=${translated.length}`);
    return { ok: false, errors };
  }
  for (let i = 0; i < src.length; i++) {
    const a = src[i], b = translated[i];
    if (Math.abs(a.start_ms - b.start_ms) > toleranceMs ||
        Math.abs(a.end_ms - b.end_ms) > toleranceMs) {
      errors.push(`cue ${i + 1} timing drift exceeds ${toleranceMs}ms`);
    }
  }
  return { ok: errors.length === 0, errors };
}
