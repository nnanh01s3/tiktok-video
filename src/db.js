import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = process.env.DB_PATH || "./data/content.db";

let _db;

export function getDb() {
  if (_db) return _db;

  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quotes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      text        TEXT    NOT NULL UNIQUE,
      author      TEXT    DEFAULT 'Original',
      category    TEXT    NOT NULL,
      hash        TEXT    NOT NULL UNIQUE,
      used_count  INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at  TEXT    DEFAULT (datetime('now')),
      source      TEXT    DEFAULT 'seed'
    );

    CREATE TABLE IF NOT EXISTS videos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          TEXT    NOT NULL UNIQUE,
      status          TEXT    NOT NULL DEFAULT 'pending',
      niche           TEXT    NOT NULL,
      content_ids     TEXT,
      script          TEXT,
      video_path      TEXT,
      tiktok_post_id  TEXT,
      caption         TEXT,
      hashtags        TEXT,
      scheduled_at    TEXT,
      posted_at       TEXT,
      views           INTEGER DEFAULT 0,
      likes           INTEGER DEFAULT 0,
      shares          INTEGER DEFAULT 0,
      comments        INTEGER DEFAULT 0,
      completion_rate REAL    DEFAULT 0,
      hook_rate       REAL    DEFAULT 0,
      created_at      TEXT    DEFAULT (datetime('now')),
      updated_at      TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hashtag_pool (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      tag       TEXT    NOT NULL UNIQUE,
      niche     TEXT    NOT NULL,
      tier      TEXT    NOT NULL CHECK(tier IN ('trending','niche_large','niche_small','branded')),
      avg_reach REAL    DEFAULT 0,
      use_count INTEGER DEFAULT 0,
      active    INTEGER DEFAULT 1,
      added_at  TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analytics_daily (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT    NOT NULL,
      niche           TEXT    NOT NULL,
      videos_posted   INTEGER DEFAULT 0,
      total_views     INTEGER DEFAULT 0,
      total_likes     INTEGER DEFAULT 0,
      total_shares    INTEGER DEFAULT 0,
      avg_completion  REAL    DEFAULT 0,
      avg_hook_rate   REAL    DEFAULT 0,
      avg_engagement  REAL    DEFAULT 0,
      followers_gained INTEGER DEFAULT 0,
      created_at      TEXT    DEFAULT (datetime('now')),
      UNIQUE(date, niche)
    );

    CREATE INDEX IF NOT EXISTS idx_quotes_category    ON quotes(category);
    CREATE INDEX IF NOT EXISTS idx_quotes_unused       ON quotes(used_count, last_used_at);
    CREATE INDEX IF NOT EXISTS idx_videos_status       ON videos(status);
    CREATE INDEX IF NOT EXISTS idx_videos_niche_date   ON videos(niche, posted_at);
    CREATE INDEX IF NOT EXISTS idx_hashtag_niche       ON hashtag_pool(niche, active);
    CREATE INDEX IF NOT EXISTS idx_analytics_date      ON analytics_daily(date, niche);

    CREATE TABLE IF NOT EXISTS posted_reels (
      video_id       TEXT PRIMARY KEY,
      source_url     TEXT NOT NULL,
      source_name    TEXT,
      page_name      TEXT NOT NULL,
      niche          TEXT NOT NULL,
      posted_at      TEXT NOT NULL,
      scheduled_at   TEXT,
      pfm_post_id    TEXT,
      topic_score    REAL,
      video_title    TEXT,
      video_duration INTEGER,
      file_size_mb   REAL
    );

    CREATE INDEX IF NOT EXISTS idx_posted_reels_page_date
      ON posted_reels(page_name, posted_at);
    CREATE INDEX IF NOT EXISTS idx_posted_reels_source
      ON posted_reels(source_name);
  `);

  // --- Migrations ---
  // Add director_json column if not exists (stores full Claude director output)
  try {
    db.exec(`ALTER TABLE videos ADD COLUMN director_json TEXT`);
  } catch {
    // Column already exists — ignore
  }
  // Add text_vi_display for proper Vietnamese translations (only if quotes_v2 exists)
  try {
    const hasV2 = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='quotes_v2'`
    ).get();
    if (hasV2) {
      db.exec(`ALTER TABLE quotes_v2 ADD COLUMN text_vi_display TEXT`);
    }
  } catch {
    // Column already exists or table doesn't exist — ignore
  }
}

// --- Quote helpers (reads from quotes_v2, fallback to quotes) ---

export function getUnusedQuotes(category, limit = 5) {
  const db = getDb();

  // Try quotes_v2 first (verified, attributed quotes)
  const v2Quotes = db
    .prepare(
      `SELECT id, COALESCE(text_vi_display, text_vi) AS text, text_vi AS text_raw,
              COALESCE(author_vi, author) AS author,
              category, source_work, source_detail, text_original, origin, tone,
              times_used AS used_count
       FROM quotes_v2
       WHERE category = ? AND (times_used = 0 OR used_at < datetime('now', '-90 days'))
       ORDER BY times_used ASC, RANDOM()
       LIMIT ?`
    )
    .all(category, limit);

  if (v2Quotes.length >= limit) {
    return v2Quotes.map((q) => ({ ...q, _source: "v2" }));
  }

  // If not enough in exact category, try any quotes_v2 with fewer uses
  if (v2Quotes.length < limit) {
    const remaining = limit - v2Quotes.length;
    const v2Ids = v2Quotes.map((q) => q.id);
    const extra = db
      .prepare(
        `SELECT id, COALESCE(text_vi_display, text_vi) AS text, text_vi AS text_raw,
                COALESCE(author_vi, author) AS author,
                category, source_work, source_detail, text_original, origin, tone,
                times_used AS used_count
         FROM quotes_v2
         WHERE (times_used = 0 OR used_at < datetime('now', '-30 days'))
           ${v2Ids.length ? `AND id NOT IN (${v2Ids.join(",")})` : ""}
         ORDER BY times_used ASC, RANDOM()
         LIMIT ?`
      )
      .all(remaining);
    const combined = [...v2Quotes, ...extra].map((q) => ({ ...q, _source: "v2" }));
    if (combined.length >= limit) return combined.slice(0, limit);
  }

  // NO fallback to old quotes table (v1) — that data contains AI-fabricated
  // quotes and English categories no longer used. Only quotes_v2 (verified,
  // attributed, Vietnamese) is the source of truth.
  return combined.length > 0 ? combined.slice(0, limit) : v2Quotes;
}

export function markQuotesUsed(ids) {
  const db = getDb();
  // Update quotes_v2
  const stmtV2 = db.prepare(
    `UPDATE quotes_v2 SET times_used = times_used + 1, used_at = datetime('now') WHERE id = ?`
  );
  // Old quotes table (v1) no longer updated — only quotes_v2 is used.
  const tx = db.transaction((ids) => {
    for (const id of ids) {
      stmtV2.run(id);
    }
  });
  tx(ids);
}

export function getQuoteStats() {
  const db = getDb();
  const v2Stats = db
    .prepare(
      `SELECT category, COUNT(*) as total,
              SUM(CASE WHEN times_used = 0 THEN 1 ELSE 0 END) as unused,
              'v2' as source
       FROM quotes_v2 GROUP BY category`
    )
    .all();
  // Old quotes table (v1) excluded — contains AI-fabricated data.
  // Only quotes_v2 is the source of truth.
  return v2Stats;
}

// --- Video job helpers ---

export function createVideoJob(job) {
  const db = getDb();
  return db
    .prepare(
      `INSERT INTO videos (job_id, status, niche, content_ids, script, caption, hashtags, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      job.job_id,
      job.status || "pending",
      job.niche,
      JSON.stringify(job.content_ids || []),
      job.script || null,
      job.caption || null,
      JSON.stringify(job.hashtags || []),
      job.scheduled_at || null
    );
}

export function updateVideoStatus(jobId, status, extra = {}) {
  const db = getDb();
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const vals = [status];

  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(jobId);

  db.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE job_id = ?`).run(
    ...vals
  );
}

export function getPendingJobs() {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM videos WHERE status IN ('pending','rendering','rendered','uploading')
       ORDER BY created_at ASC`
    )
    .all();
}

// --- Hashtag helpers ---

export function getActiveHashtags(niche, limit = 6) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM hashtag_pool
       WHERE niche = ? AND active = 1
       ORDER BY RANDOM()
       LIMIT ?`
    )
    .all(niche, limit);
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// --- posted_reels helpers (cross-page permanent blocklist) ---

export function isVideoPosted(videoId) {
  if (!videoId) return false;
  const db = getDb();
  return Boolean(
    db.prepare("SELECT 1 FROM posted_reels WHERE video_id = ?").get(videoId)
  );
}

export function recordPostedVideo(entry) {
  if (!entry?.video_id || !entry?.page_name || !entry?.posted_at) {
    throw new Error("recordPostedVideo: video_id, page_name, posted_at required");
  }
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO posted_reels (
      video_id, source_url, source_name, page_name, niche,
      posted_at, scheduled_at, pfm_post_id, topic_score,
      video_title, video_duration, file_size_mb
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.video_id,
    entry.source_url || "",
    entry.source_name || null,
    entry.page_name,
    entry.niche || entry.page_name,
    entry.posted_at,
    entry.scheduled_at || null,
    entry.pfm_post_id || null,
    entry.topic_score ?? null,
    entry.video_title?.slice(0, 200) || null,
    entry.video_duration ?? null,
    entry.file_size_mb ?? null
  );
}

export function getPostedStats() {
  const db = getDb();
  return db
    .prepare(
      `SELECT page_name, COUNT(*) AS n, MAX(posted_at) AS latest
       FROM posted_reels GROUP BY page_name ORDER BY n DESC`
    )
    .all();
}
