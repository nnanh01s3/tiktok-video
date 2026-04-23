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
  // ══════════════════════════════════════════════════════════════════════
  // Sources updated 18/4/2026 — added high-frequency (daily+) posters
  // to solve "0 new videos" issue. Prioritize TikTok aggregate channels
  // and media companies that post 1-5x/day over individual KOLs (2-3x/week).
  // ══════════════════════════════════════════════════════════════════════

  // ── shopee (Sưu Tầm Hàng Dị) — Đồ lạ, unique gadgets ──
  shopee: [
    { name: "Đồ Độc Lạ",       platform: "facebook", url: "https://www.facebook.com/profile.php?id=61576726414275" },
    { name: "Thánh Mẹo VN",    platform: "facebook", url: "https://www.facebook.com/thanhmeo.vn" },
    { name: "Mẹo Vặt",         platform: "facebook", url: "https://www.facebook.com/meohay" },
    { name: "Duy Luân",         platform: "tiktok",   url: "https://www.tiktok.com/@duyluandethuong" },
    // ── NEW: high-frequency ──
    { name: "HiisMe Store",     platform: "tiktok",   url: "https://www.tiktok.com/@hiisme.store" },       // daily, smart gadget compilations
    { name: "Đạt Đung Đưa",    platform: "tiktok",   url: "https://www.tiktok.com/@datdungdua" },          // daily, gadget tips 659K
  ],

  // ── gia_dung (Đồ Gia Dụng) — kitchen, smart home, appliances ──
  // Note 20/4/2026: removed BabyKopo Home (shifted to family/foodtour vlog)
  // and Anh Vũ Trọc (tech creator, not gia_dung). Added 4 verified creators
  // actually posting gia_dung content daily/weekly (research agent 20/4).
  gia_dung: [
    { name: "Điện Máy Quang Hạnh",    platform: "tiktok",   url: "https://www.tiktok.com/@dienmayquanghanh" },        // daily 2-3x, retail showroom (Philips, Seka, Hatari, bếp từ, máy xay)
    { name: "Nhà Xanh Gia Dụng",      platform: "tiktok",   url: "https://www.tiktok.com/@giadungxanh_giadinhviet" }, // burst 5-10/2-3 days, smart home gadgets (#dogiadungtienich)
    { name: "Mê đồ gia dụng tiện ích", platform: "tiktok",   url: "https://www.tiktok.com/@medogiadungtienich6" },     // 2-3x/week, home decor + kitchen accessories
    { name: "Long Khoa Học",           platform: "tiktok",   url: "https://www.tiktok.com/@longkhoahoc" },             // 2-3x/week, smart home tech (EZVIZ, Dyson, Panasonic)
    { name: "HiisMe Store",            platform: "tiktok",   url: "https://www.tiktok.com/@hiisme.store" },            // daily, kitchen gadgets #donhabep (may have short clips)
    { name: "Gia Dụng TM Reels",       platform: "facebook", url: "https://www.facebook.com/giadungthongminh.reels" }, // FB fallback — verify activity periodically
    { name: "Smart Gadgets Tiện Ích",  platform: "facebook", url: "https://www.facebook.com/smartgadgets.tienichthongminh" }, // FB fallback
    { name: "Đồ Gia Dụng Thế Hệ Mới",  platform: "facebook", url: "https://www.facebook.com/smart.dogiadung.vn" },     // FB fallback
    { name: "Bách Hóa Xanh",           platform: "facebook", url: "https://www.facebook.com/bachhoaxanh" },            // FB fallback — grocery chain
  ],

  // ── tech (Đồ Công Nghệ) — gadgets, phone, reviews ──
  tech: [
    { name: "Anh Le Review",     platform: "tiktok",   url: "https://www.tiktok.com/@anhlereviewcongnghe" },
    { name: "Long Khoa Học",     platform: "tiktok",   url: "https://www.tiktok.com/@longkhoahoc" },
    { name: "Mẹo hay iOS Android", platform: "facebook", url: "https://www.facebook.com/meohayiosandroid" },
    // ── NEW: high-frequency ──
    { name: "Anh Vũ Trọc",      platform: "tiktok",   url: "https://www.tiktok.com/@vuvanduc.com" },      // daily 2x, 1.6M, #1 tech VN
    { name: "Tuấn Tiền Tỉ",     platform: "tiktok",   url: "https://www.tiktok.com/@tuantienti2911" },    // daily, 1.1M, phone tricks
    { name: "Schannel",          platform: "tiktok",   url: "https://www.tiktok.com/@schannelvn" },        // daily, 3M, CellphoneS tech media, high engagement
    { name: "Di Động Việt",    platform: "tiktok",   url: "https://www.tiktok.com/@didongviet_official" }, // daily, phone retailer reviews
    { name: "Kenh14",            platform: "facebook", url: "https://www.facebook.com/Kenh14" },            // multi/day, tech trending
  ],

  // ── sac_dep (Mỹ Phẩm) — skincare, beauty, makeup ──
  sac_dep: [
    { name: "Võ Hà Linh",        platform: "tiktok",   url: "https://www.tiktok.com/@halinhofficial" },
    { name: "Trinh Phạm",        platform: "tiktok",   url: "https://www.tiktok.com/@trinhpham2222" },
    { name: "Chloe Nguyễn",      platform: "tiktok",   url: "https://www.tiktok.com/@bychloenguyen" },
    { name: "Rư Skincare",       platform: "tiktok",   url: "https://www.tiktok.com/@goc.cua.ru" },
    { name: "Võ Hà Linh Beauty", platform: "facebook", url: "https://www.facebook.com/vohalinh.beauty" },
    // ── NEW: high-frequency ──
    { name: "Lê Khánh Huyền",    platform: "tiktok",   url: "https://www.tiktok.com/@lethikhanhhuyen2004" }, // daily+, 7.5M, #1 beauty VN
    { name: "Cim Ngân",           platform: "tiktok",   url: "https://www.tiktok.com/@cimngan0503" },        // daily, 2.2M, 631K avg views
    { name: "Vanmiu Beauty",     platform: "tiktok",   url: "https://www.tiktok.com/@vanmiu_beauty" },      // daily, 1.2M, pro makeup tutorials
    { name: "Trần Oanh",         platform: "tiktok",   url: "https://www.tiktok.com/@tranoanh4451" },       // daily, 1.4M, skincare routines
    { name: "ELLE Vietnam",      platform: "facebook", url: "https://www.facebook.com/ELLEVietnam" },       // daily+, editorial beauty Reels
  ],

  // ── thoi_trang (Thời Trang) — outfit, street style ──
  thoi_trang: [
    { name: "Sơn Hồng Phạm",     platform: "tiktok", url: "https://www.tiktok.com/@sonhongpham" },
    { name: "Hoàng Hải Hiền",    platform: "tiktok", url: "https://www.tiktok.com/@tikkaisweird" },
    { name: "Phí Quỳnh Anh",     platform: "tiktok", url: "https://www.tiktok.com/@quynhanhshyn_" },
    { name: "Nguyễn Phúc Anh",   platform: "tiktok", url: "https://www.tiktok.com/@phucanhh_" },
    // ── NEW: high-frequency ──
    { name: "Đan Thy",           platform: "tiktok", url: "https://www.tiktok.com/@thybui.__" },           // daily+, 11M, 8.49% engagement!
    { name: "Ngọc Matcha",       platform: "tiktok", url: "https://www.tiktok.com/@ngoc.matcha" },         // daily, 4.3M, OOTD aesthetics
    { name: "BYB Academy VN",    platform: "tiktok", url: "https://www.tiktok.com/@bybacademyvn" },        // daily+, 2.2M, fashion education
    { name: "ELLE Vietnam",      platform: "facebook", url: "https://www.facebook.com/ELLEVietnam" },      // daily, fashion editorial Reels
  ],

  // ── me_be (Mẹ & Bé) — parenting, baby products ──
  me_be: [
    { name: "Fansie Family",      platform: "tiktok",   url: "https://www.tiktok.com/@befansie" },
    { name: "Giang Chè Xíu Xôi", platform: "tiktok",   url: "https://www.tiktok.com/@giangchekm" },
    { name: "Salim Official",     platform: "tiktok",   url: "https://www.tiktok.com/@salim_official" },
    { name: "Isis Min",           platform: "facebook", url: "https://www.facebook.com/isismin.vietnam" },
    // ── NEW: high-frequency ──
    { name: "BabyKopo Home",     platform: "tiktok",   url: "https://www.tiktok.com/@babykopohome" },      // daily+, 6.7M, mom life + cooking
    { name: "Xoài Fam (Trang Lou)", platform: "tiktok", url: "https://www.tiktok.com/@xoaifam" },          // daily, 797K, mom-baby lifestyle
    { name: "Gia Đình Cam Cam",  platform: "tiktok",   url: "https://www.tiktok.com/@giadinhcamcam" },     // daily, 725K, family vlogs + tips
    { name: "Nguyễn Vy Family",  platform: "tiktok",   url: "https://www.tiktok.com/@nguyenvy1234567" },   // daily, 1M, #1 family TikTok VN
  ],

  // ── the_thao (Thể Thao) — fitness, workout, outdoor ──
  // Note 23/4/2026: removed Minh Thơ Fitness (100% raw <2MB), Én Fitness
  // (shifted to chứng khoán), Ny Cơ Bắp (vlog cá nhân). Added 6 verified
  // creators from research agent 23/4 — pro-studio production, higher
  // bitrate confidence (@shredan72 787kbps, @trantrungnhantnt 1.77Mbps).
  the_thao: [
    // ── NEW (23/4): high-bitrate pro-studio ──
    { name: "FitStrength Academy",  platform: "tiktok",   url: "https://www.tiktok.com/@trantrungnhantnt" }, // 8x/week, PT academy, ~1.77 Mbps bitrate (best)
    { name: "An Nguyen Fitness",    platform: "tiktok",   url: "https://www.tiktok.com/@shredan72" },        // 4x/week, giảm mỡ/cắt cơ coaching, ~787 kbps
    { name: "Cường Nguyễn Fitness", platform: "tiktok",   url: "https://www.tiktok.com/@cuongnguyenfitness" }, // 10x/week, PT coaching Q&A studio
    { name: "Đinh Huỳnh Duy Anh",  platform: "tiktok",   url: "https://www.tiktok.com/@fboxda" },           // 15x/week, gym lifestyle + form demos
    { name: "PhillipSu",             platform: "tiktok",   url: "https://www.tiktok.com/@phillsu" },          // 1x/week, bodybuilding DFYNE sponsored
    { name: "nammy (namlifts)",      platform: "tiktok",   url: "https://www.tiktok.com/@namlifts" },         // 3-4x/week, transformation (bitrate borderline)
    // ── kept: still passable ──
    { name: "Anh Sơn Fitness",       platform: "tiktok",   url: "https://www.tiktok.com/@anhsonn_fitness" },
    { name: "Trịnh Khánh Linh",     platform: "tiktok",   url: "https://www.tiktok.com/@trinhkhanhlinh01" },
    { name: "Đặng Kim Ba Yoga",     platform: "tiktok",   url: "https://www.tiktok.com/@dangkimba" },
    { name: "Phan Bảo Long",        platform: "tiktok",   url: "https://www.tiktok.com/@phanbaolonglms" },   // weight loss coaching
    { name: "HitFit VN",             platform: "tiktok",   url: "https://www.tiktok.com/@hitfit.vn" },        // group workout classes
    { name: "California Fitness",    platform: "facebook", url: "https://www.facebook.com/cfycvn" },
  ],

  // ── bach_hoa (Bách Hóa Online) — general life hacks ──
  bach_hoa: [
    { name: "Thánh Mẹo VN",       platform: "facebook", url: "https://www.facebook.com/thanhmeo.vn" },
    { name: "Mẹo Vặt",            platform: "facebook", url: "https://www.facebook.com/meohay" },
    { name: "Skincare Đúng Cách", platform: "tiktok",   url: "https://www.tiktok.com/@skincaredungcach.byson" },
    // ── NEW: high-frequency aggregate channels ──
    { name: "60 Giây",            platform: "tiktok",   url: "https://www.tiktok.com/@60giay.com" },        // 5-10x/day!, 12.4M, media company
    { name: "Theanh28",           platform: "tiktok",   url: "https://www.tiktok.com/@theanh28entertainment" }, // multi/day, 14.5M, viral content
    { name: "Kenh14 Official",    platform: "tiktok",   url: "https://www.tiktok.com/@kenh14official" },     // multi/day, 9M, #1 youth media VN
    { name: "Anh Vũ Trọc",       platform: "tiktok",   url: "https://www.tiktok.com/@vuvanduc.com" },      // daily, life hacks via tech angle
    { name: "Kenh14 FB",          platform: "facebook", url: "https://www.facebook.com/Kenh14" },            // multi/day, Vietnam #1 youth media
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
