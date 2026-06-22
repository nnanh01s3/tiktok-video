/**
 * Short link lookup — reads CSV files exported from Shopee Affiliate dashboard
 * and provides fast in-memory lookup by product item_id.
 *
 * Workflow:
 *   1. User clicks "Lấy link" on products in affiliate.shopee.vn dashboard
 *   2. User exports CSV (format: Mã sản phẩm, Tên, Giá, ..., Link ưu đãi)
 *   3. Drops CSV into D:/tiktok/ (filename matches `link_san_pham_shopee_*.csv`)
 *   4. This module auto-loads ALL matching CSVs on first lookup, merging
 *      them into a single Map<itemId, shortUrl>.
 *   5. reup.mjs calls getShortLinkFromCsv(itemId) at post time.
 *
 * Why CSV-based approach: Shopee's affiliate API has aggressive anti-bot
 * (encrypted `af-ac-enc-dat` header, per-session CSRF, fingerprinting).
 * Raw fetch hits 403; even CDP-in-browser fails when cookies are stale.
 * Manual CSV export is reliable, zero-maintenance, and provides official
 * tracking links (s.shopee.vn/xxx vs is.gd/xxx which is 3rd-party).
 *
 * CSV format (from Shopee export):
 *   Column 0: Mã sản phẩm (item_id) ← lookup key
 *   Column 1: Tên sản phẩm
 *   Column 2: Giá
 *   Column 3: Doanh thu
 *   Column 4: Tên cửa hàng
 *   Column 5: Tỉ lệ hoa hồng
 *   Column 6: Hoa hồng
 *   Column 7: Link sản phẩm (long URL)
 *   Column 8: Link ưu đãi (short URL) ← lookup value
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const CSV_DIR = "D:/tiktok";
const CSV_PATTERN = /^link_san_pham_shopee_.*\.csv$/i;

// In-memory cache: itemId (string) → shortUrl
let linkMap = null;
let loadedFiles = [];

/**
 * Parse a single CSV row into fields, handling quoted values with embedded commas.
 * Minimal implementation for Shopee's export format — assumes no multi-line
 * values and standard double-quote escaping.
 */
function parseCsvRow(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      // Handle escaped quote ("")
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

function loadCsvFile(filePath) {
  try {
    // Strip BOM if present (Excel/Windows CSV exports often include it)
    const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return 0;

    // Skip header row (row 0)
    let added = 0;
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvRow(lines[i]);
      if (fields.length < 9) continue;

      const itemId = (fields[0] || "").trim();
      const shortUrl = (fields[8] || "").trim();
      if (!itemId || !shortUrl || !shortUrl.startsWith("https://")) continue;

      linkMap.set(itemId, shortUrl);
      added++;
    }
    return added;
  } catch (e) {
    console.log(
      `[short_link_lookup] failed to parse ${filePath}: ${e.message?.slice(0, 100)}`
    );
    return 0;
  }
}

function loadAll() {
  linkMap = new Map();
  loadedFiles = [];
  if (!existsSync(CSV_DIR)) return;

  const files = readdirSync(CSV_DIR).filter((f) => CSV_PATTERN.test(f));
  for (const f of files) {
    const fullPath = join(CSV_DIR, f);
    const count = loadCsvFile(fullPath);
    if (count > 0) {
      loadedFiles.push({ file: f, count });
    }
  }

  const total = linkMap.size;
  const summary = loadedFiles
    .map((x) => `${x.file}(${x.count})`)
    .join(", ");
  console.log(
    `[short_link_lookup] Loaded ${total} short links from ${loadedFiles.length} CSV(s): ${summary}`
  );
}

/**
 * Look up official Shopee short link for a product.
 * @param {string|number} itemId - Shopee product item ID
 * @returns {string|null} - s.shopee.vn/xxx URL, or null if not in any loaded CSV
 */
export function getShortLinkFromCsv(itemId) {
  if (!linkMap) loadAll();
  if (!itemId) return null;
  return linkMap.get(String(itemId)) || null;
}

/**
 * Force reload (useful if new CSV files are dropped during a long-running
 * process, or for diagnostics).
 */
export function reloadShortLinks() {
  loadAll();
  return { total: linkMap.size, files: loadedFiles };
}

/**
 * Diagnostic: list all loaded CSVs and counts.
 */
export function getLoadedInfo() {
  if (!linkMap) loadAll();
  return { total: linkMap.size, files: loadedFiles };
}
