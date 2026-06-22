/**
 * Parse Douyin view count strings into integers.
 * Handles: "856", "1.2k", "2.3w" (Chinese 万=10000), "3.5万", ""
 */
export function parseViewCount(input) {
  if (input == null) return 0;
  const s = String(input).trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([kw万]?)/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return 0;
  const unit = m[2];
  if (unit === "k") return Math.round(num * 1000);
  if (unit === "w" || unit === "万") return Math.round(num * 10000);
  return Math.round(num);
}
