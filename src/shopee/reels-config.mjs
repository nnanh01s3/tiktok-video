/**
 * Reels source configuration — per-niche Facebook/TikTok content pages
 * to scrape + repost as Facebook Reels for audience building.
 *
 * Strategy (per user decision):
 *   - Build audience first, sell later
 *   - 1 Reel/page/day at 18:30 VN time (prime engagement window)
 *   - Mix: repost from sources (Mon-Thu) + AI-generated (Fri-Sun)
 *   - Sources researched from VN creator rankings (KOLs, hot TikTokers)
 *
 * Source selection (rotation):
 *   day-of-year % sources.length → deterministic rotation
 *   Each day a different source is picked per niche → variety
 *
 * Platform detection (for downloader):
 *   URL contains "tiktok.com" → use yt-dlp directly
 *   URL contains "facebook.com" → use CDP scraper (like fb_repost.mjs)
 */

/**
 * @typedef {Object} Source
 * @property {string} name    - Human-readable
 * @property {"tiktok"|"facebook"} platform
 * @property {string} url     - Profile/page URL (for TikTok, we scrape latest video)
 */

/** @type {Record<string, Source[]>} */
export const REELS_SOURCES = {
  // ── shopee (Sưu Tầm Hàng Dị) — Đồ lạ, unique gadgets ──
  shopee: [
    { name: "Đồ Độc Lạ",       platform: "facebook", url: "https://www.facebook.com/profile.php?id=61576726414275" },
    { name: "Thánh Mẹo VN",    platform: "facebook", url: "https://www.facebook.com/thanhmeo.vn" },
    { name: "Mẹo Vặt",         platform: "facebook", url: "https://www.facebook.com/meohay" },
    { name: "Duy Luân",        platform: "tiktok",   url: "https://www.tiktok.com/@duyluandethuong" },
  ],

  // ── gia_dung (Đồ Gia Dụng) — smart home, utilities ──
  gia_dung: [
    { name: "Gia Dụng TM Reels",        platform: "facebook", url: "https://www.facebook.com/giadungthongminh.reels" },
    { name: "Smart Gadgets Tiện Ích",   platform: "facebook", url: "https://www.facebook.com/smartgadgets.tienichthongminh" },
    { name: "Đồ Gia Dụng Thế Hệ Mới",   platform: "facebook", url: "https://www.facebook.com/smart.dogiadung.vn" },
  ],

  // ── tech (Đồ Công Nghệ) — gadgets, phone, reviews ──
  tech: [
    { name: "Anh Le Review",      platform: "tiktok",   url: "https://www.tiktok.com/@anhlereviewcongnghe" },
    { name: "Long Khoa Học",      platform: "tiktok",   url: "https://www.tiktok.com/@longkhoahoc" },
    { name: "Mẹo hay iOS Android", platform: "facebook", url: "https://www.facebook.com/meohayiosandroid" },
  ],

  // ── sac_dep (Mỹ Phẩm) — skincare, beauty, makeup ──
  sac_dep: [
    { name: "Võ Hà Linh",       platform: "tiktok",   url: "https://www.tiktok.com/@halinhofficial" },
    { name: "Trinh Phạm",       platform: "tiktok",   url: "https://www.tiktok.com/@trinhpham2222" },
    { name: "Chloe Nguyễn",     platform: "tiktok",   url: "https://www.tiktok.com/@bychloenguyen" },
    { name: "Rư Skincare",      platform: "tiktok",   url: "https://www.tiktok.com/@goc.cua.ru" },
    { name: "Võ Hà Linh Beauty", platform: "facebook", url: "https://www.facebook.com/vohalinh.beauty" },
  ],

  // ── thoi_trang (Thời Trang) — outfit, street style ──
  thoi_trang: [
    { name: "Sơn Hồng Phạm",      platform: "tiktok", url: "https://www.tiktok.com/@sonhongpham" },
    { name: "Hoàng Hải Hiền",     platform: "tiktok", url: "https://www.tiktok.com/@tikkaisweird" },
    { name: "Phí Quỳnh Anh",      platform: "tiktok", url: "https://www.tiktok.com/@quynhanhshyn_" },
    { name: "Nguyễn Phúc Anh",    platform: "tiktok", url: "https://www.tiktok.com/@phucanhh_" },
  ],

  // ── me_be (Mẹ & Bé) — parenting, baby products ──
  me_be: [
    { name: "Fansie Family",   platform: "tiktok",   url: "https://www.tiktok.com/@befansie" },
    { name: "Giang Chè Xíu Xôi", platform: "tiktok", url: "https://www.tiktok.com/@giangchekm" },
    { name: "Salim Official",  platform: "tiktok",   url: "https://www.tiktok.com/@salim_official" },
    { name: "Isis Min",        platform: "facebook", url: "https://www.facebook.com/isismin.vietnam" },
  ],

  // ── the_thao (Thể Thao) — fitness, workout, outdoor ──
  the_thao: [
    { name: "Anh Sơn Fitness",   platform: "tiktok",   url: "https://www.tiktok.com/@anhsonn_fitness" },
    { name: "Minh Thơ Fitness",  platform: "tiktok",   url: "https://www.tiktok.com/@minhthofitness" },
    { name: "Trịnh Khánh Linh",  platform: "tiktok",   url: "https://www.tiktok.com/@trinhkhanhlinh01" },
    { name: "Đặng Kim Ba Yoga",  platform: "tiktok",   url: "https://www.tiktok.com/@dangkimba" },
    { name: "California Fitness", platform: "facebook", url: "https://www.facebook.com/cfycvn" },
  ],

  // ── bach_hoa (Bách Hóa Online) — general life hacks ──
  bach_hoa: [
    { name: "Thánh Mẹo VN",        platform: "facebook", url: "https://www.facebook.com/thanhmeo.vn" },
    { name: "Mẹo Vặt",             platform: "facebook", url: "https://www.facebook.com/meohay" },
    { name: "Skincare Đúng Cách",  platform: "tiktok",   url: "https://www.tiktok.com/@skincaredungcach.byson" },
  ],
};

/**
 * Pick source for a niche based on day-of-year rotation.
 * Deterministic: same day → same source across retries.
 * Each day rotates through sources so content variety is guaranteed.
 */
export function pickSource(niche) {
  const sources = REELS_SOURCES[niche];
  if (!sources || sources.length === 0) return null;
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000
  );
  return sources[dayOfYear % sources.length];
}

/**
 * Get all niches that have sources configured.
 */
export function getAllNiches() {
  return Object.keys(REELS_SOURCES);
}
