/**
 * URL shortener — dùng is.gd (free, no API key needed)
 */

/**
 * Rút gọn affiliate link
 * @param {string} longUrl
 * @returns {Promise<string>} short URL hoặc original nếu fail
 */
export async function shortenUrl(longUrl) {
  if (!longUrl) return longUrl;
  try {
    const r = await fetch(
      `https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const short = (await r.text()).trim();
    if (short.startsWith("https://")) return short;
  } catch {}
  // Fallback: return product link (shorter than long_link)
  const match = longUrl.match(/product\/(\d+)\/(\d+)/);
  if (match) return `https://shopee.vn/product/${match[1]}/${match[2]}`;
  return longUrl;
}
