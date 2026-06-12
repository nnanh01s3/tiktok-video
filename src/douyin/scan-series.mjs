/**
 * Series scanner — find episode-numbered videos for a show and sort them.
 *
 * Two modes:
 *   --keyword "<tên phim>"   : search, group candidates by author, report
 *                              which creator posts the most episodes.
 *   --creator "<profile url>": enumerate ALL of one creator's posts, parse
 *                              episode numbers, return sorted ep1 → latest.
 *
 * Episode parsing recognizes: 第X集, X集, （X）, EP X, 第X话.
 *
 * Output: JSON { episodes: [{ ep, modal_id, url, duration_sec, title }],
 *                unnumbered: [...], by_author: {...} }
 */
import "../env.js";
import { discover } from "./discover.mjs";

function parseEpisode(title) {
  const t = title || "";
  const patterns = [
    /第\s*(\d{1,4})\s*集/,
    /第\s*(\d{1,4})\s*话/,
    /\bEP\s*(\d{1,4})\b/i,
    /（\s*(\d{1,4})\s*）/,
    /\((\d{1,4})\)/,
    /\b(\d{1,4})\s*集/,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 5000) return n;
    }
  }
  return null;
}

export async function scanSeries({ keyword, creator, max = 400 }) {
  const candidates = await discover({ keyword, creator, maxResults: max });

  const numbered = [];
  const unnumbered = [];
  const byAuthor = {};

  for (const c of candidates) {
    const ep = parseEpisode(c.title);
    const entry = {
      ep,
      modal_id: c.modal_id,
      url: c.url,
      duration_sec: c.duration_sec,
      like_count: c.like_count,
      author: c.author,
      author_sec_uid: c.author_sec_uid,
      title: c.title,
    };
    if (ep != null) numbered.push(entry);
    else unnumbered.push(entry);

    const a = c.author || "(unknown)";
    byAuthor[a] = byAuthor[a] || { count: 0, numbered: 0, sec_uid: c.author_sec_uid };
    byAuthor[a].count++;
    if (ep != null) byAuthor[a].numbered++;
  }

  // Dedup numbered by ep (keep longest duration — usually the real episode
  // vs a short teaser of the same number)
  const byEp = new Map();
  for (const e of numbered) {
    const prev = byEp.get(e.ep);
    if (!prev || e.duration_sec > prev.duration_sec) byEp.set(e.ep, e);
  }
  const episodes = [...byEp.values()].sort((a, b) => a.ep - b.ep);

  return { episodes, unnumbered, by_author: byAuthor, total: candidates.length };
}

// CLI
const { isMainModule: __isMain } = await import("./utils/is-cli.mjs");
if (__isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const keyword = args.includes("--keyword") ? args[args.indexOf("--keyword") + 1] : null;
  const creator = args.includes("--creator") ? args[args.indexOf("--creator") + 1] : null;
  const max = args.includes("--max") ? parseInt(args[args.indexOf("--max") + 1]) : 400;
  if (!keyword && !creator) {
    console.error('usage: scan-series.mjs --keyword "<name>" | --creator "<url>" [--max N]');
    process.exit(1);
  }
  scanSeries({ keyword, creator, max }).then((r) => {
    console.log(`\n=== ${r.episodes.length} numbered episodes (of ${r.total} videos) ===`);
    for (const e of r.episodes) {
      const d = `${Math.floor(e.duration_sec / 60)}:${String(e.duration_sec % 60).padStart(2, "0")}`;
      console.log(`EP${String(e.ep).padStart(3)}  ${e.modal_id}  ${d}  ❤${e.like_count}  ${e.title.slice(0, 45)}`);
    }
    console.log(`\n=== authors (who posts most episodes) ===`);
    const sorted = Object.entries(r.by_author).sort((a, b) => b[1].numbered - a[1].numbered);
    for (const [name, info] of sorted.slice(0, 8)) {
      console.log(`  ${info.numbered} eps / ${info.count} vids — ${name}`);
      if (info.sec_uid) console.log(`     https://www.douyin.com/user/${info.sec_uid}`);
    }
  }).catch((e) => { console.error(e); process.exit(1); });
}
