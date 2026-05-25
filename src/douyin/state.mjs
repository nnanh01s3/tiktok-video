/**
 * State store for Douyin pipeline.
 * Schema:
 *   { schema_version: 1, videos: { [modal_id]: { status, ...meta } } }
 *
 * Status values:
 *   discovered | downloaded | subs_extracted | translated | composed |
 *   published | subs_failed | translate_failed | compose_failed |
 *   publish_failed | skipped
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const SCHEMA_VERSION = 1;

function loadOrInit(path) {
  if (!existsSync(path)) return { schema_version: SCHEMA_VERSION, videos: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed.videos) parsed.videos = {};
    return parsed;
  } catch (err) {
    const backup = `${path}.bak.${Date.now()}`;
    try { renameSync(path, backup); } catch {}
    return { schema_version: SCHEMA_VERSION, videos: {} };
  }
}

export function createState(path) {
  const data = loadOrInit(path);

  const save = () => writeFileSync(path, JSON.stringify(data, null, 2));

  return {
    get(modal_id) {
      return data.videos[modal_id] || null;
    },
    upsert(modal_id, patch) {
      const existing = data.videos[modal_id] || {};
      data.videos[modal_id] = {
        ...existing,
        ...patch,
        modal_id,
        updated_at: new Date().toISOString(),
      };
      save();
    },
    list({ status } = {}) {
      const out = Object.values(data.videos);
      if (!status) return out;
      const re = status instanceof RegExp ? status : new RegExp(`^${status}$`);
      return out.filter(v => re.test(v.status));
    },
  };
}
