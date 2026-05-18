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
    { name: "Duy Luân",         platform: "tiktok",   url: "https://www.tiktok.com/@duyluandethuong" },    // NOTE: drifted to tech reviews (phones, laptops) — mostly off-topic for shopee niche
    // ── NEW: high-frequency ──
    { name: "HiisMe Store",     platform: "tiktok",   url: "https://www.tiktok.com/@hiisme.store" },       // NOTE: drifted to skincare/lifestyle — mostly off-topic for shopee niche
    { name: "Đạt Đung Đưa",    platform: "tiktok",   url: "https://www.tiktok.com/@datdungdua" },          // NOTE: drifted to iPhone tips — mostly off-topic for shopee niche
    // ── ADDED 2026-05-01: high-bitrate replacement after 3x consecutive 0/N (drift on existing) ──
    { name: "Review That Vn",   platform: "tiktok",   url: "https://www.tiktok.com/@reviewthat.vn" },      // gadget novelty (LED pháo hoa, đồ Tết), 8+ MB raw, on-niche
    // ── ADDED 2026-05-18: high-view rotation expansion (only 3 confirmed — niche is sparse, see notes) ──
    { name: "Nhi Thỏ",                  platform: "tiktok", url: "https://www.tiktok.com/@nhitho2000" },          // daily, smart-home/đồ công nghệ tiện ích, 811K+, 40 MB raw
    { name: "Lãng Tử Đào Hoa TQ",      platform: "tiktok", url: "https://www.tiktok.com/@langtudaohoatq" },      // daily, quirky/độc-lạ product reviews, 300K+, 28 MB raw
    { name: "Mê Đồ Gia Dụng Tiện Ích", platform: "tiktok", url: "https://www.tiktok.com/@medogiadungtienich6" }, // daily, gadget/tiện ích review (also in gia_dung), 9 MB raw
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
    // ── ADDED 2026-05-18: high-view rotation expansion (verified active + bitrate ≥500 kbps) ──
    { name: "Điện Máy Phú Quý",       platform: "tiktok",   url: "https://www.tiktok.com/@dienmayphuquy" },           // daily, electronics/appliance retailer, ~2.35 Mbps
    { name: "Đồ Gia Dụng Nhập Khẩu",  platform: "tiktok",   url: "https://www.tiktok.com/@dogiadungnhapkhau" },       // daily, imported kitchen/home gadgets, ~1.05 Mbps
    { name: "Dreame Việt Nam",         platform: "tiktok",   url: "https://www.tiktok.com/@dreame.vietnam" },          // daily, official brand (robot vacuum, smart cleaning), ~956 kbps
    { name: "Philips Việt Nam",        platform: "tiktok",   url: "https://www.tiktok.com/@philips.vietnam" },         // daily, official brand (air fryer, blender, vacuum), ~647 kbps
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
    // ── ADDED 2026-04-27: high-bitrate replacements (existing sources serve <1MB) ──
    { name: "Khôi Ngọng",       platform: "tiktok",   url: "https://www.tiktok.com/@khoingong" },          // daily, tech reviewer (phones, tablets, tripods), 11+ MB
    { name: "Hải Triều Mobile", platform: "tiktok",   url: "https://www.tiktok.com/@haitrieumobile" },     // daily, phone retailer (iPhone, accessories), 11+ MB
    // ── ADDED 2026-05-18: wide tech expansion (user request — tech niche has many sources) ──
    { name: "Vật Vờ Studio",   platform: "tiktok",   url: "https://www.tiktok.com/@vatvostudio" },        // daily, top VN tech reviewer (phone/laptop), 12.8 MB raw
    { name: "Điện Thoại Vui",  platform: "tiktok",   url: "https://www.tiktok.com/@dienthoaivui" },       // daily, phone retailer/repair tech tips, 11.9 MB raw
    { name: "Tinh Tế",          platform: "tiktok",   url: "https://www.tiktok.com/@tinhte.vn" },          // daily, #1 VN tech community/media, 9.4 MB raw
    { name: "GenK",             platform: "tiktok",   url: "https://www.tiktok.com/@genk.vn" },            // daily, tech news media, 7.4 MB raw
    { name: "Techcare",         platform: "tiktok",   url: "https://www.tiktok.com/@techcare.vn" },        // daily, tech retailer reviews, 6.2 MB raw
    { name: "Phong Vũ",        platform: "tiktok",   url: "https://www.tiktok.com/@phongvu.official" },   // daily, PC/laptop retailer reviews, 6.2 MB raw
    { name: "Tech Review VN",   platform: "tiktok",   url: "https://www.tiktok.com/@techreview.vn" },      // daily, gadget reviews, 3.6 MB raw
    { name: "FPT Shop",         platform: "tiktok",   url: "https://www.tiktok.com/@fptshop.official" },   // daily, electronics retailer, 3.2 MB raw
  ],

  // ── sac_dep (Mỹ Phẩm) — skincare, beauty, makeup ──
  sac_dep: [
    // REMOVED 2026-05-14: Võ Hà Linh sources (vi phạm bản quyền per user request)
    { name: "Trinh Phạm",        platform: "tiktok",   url: "https://www.tiktok.com/@trinhpham2222" },
    { name: "Chloe Nguyễn",      platform: "tiktok",   url: "https://www.tiktok.com/@bychloenguyen" },
    { name: "Rư Skincare",       platform: "tiktok",   url: "https://www.tiktok.com/@goc.cua.ru" },
    // ── NEW: high-frequency ──
    { name: "Lê Khánh Huyền",    platform: "tiktok",   url: "https://www.tiktok.com/@lethikhanhhuyen2004" }, // daily+, 7.5M, #1 beauty VN
    { name: "Cim Ngân",           platform: "tiktok",   url: "https://www.tiktok.com/@cimngan0503" },        // daily, 2.2M, 631K avg views
    { name: "Vanmiu Beauty",     platform: "tiktok",   url: "https://www.tiktok.com/@vanmiu_beauty" },      // daily, 1.2M, pro makeup tutorials
    { name: "Trần Oanh",         platform: "tiktok",   url: "https://www.tiktok.com/@tranoanh4451" },       // daily, 1.4M, skincare routines
    { name: "ELLE Vietnam",      platform: "facebook", url: "https://www.facebook.com/ELLEVietnam" },       // daily+, editorial beauty Reels
    // ── ADDED 2026-05-14: replacement for removed Võ Hà Linh sources ──
    { name: "Phương Thảo Makeup", platform: "tiktok",   url: "https://www.tiktok.com/@phuongthao.makeup" }, // daily, makeup tutorials, 6+ MB raw bitrate
    { name: "Shiseido Vietnam",  platform: "tiktok",   url: "https://www.tiktok.com/@shiseido.vietnam" },  // weekly, official brand (phấn má, highlight, skincare)
    // ── ADDED 2026-05-18: high-view rotation expansion (verified active + bitrate) ──
    { name: "HannahOlala",       platform: "tiktok",   url: "https://www.tiktok.com/@hannaholala" },        // daily, beauty/skincare KOL (founder Candid Skincare), 16.6 MB raw
    { name: "Tom Skincare",      platform: "tiktok",   url: "https://www.tiktok.com/@tomskincare" },        // daily, minimalist skincare routines/reviews, 8.4 MB raw
    { name: "Hoàng Minh Ngọc",  platform: "tiktok",   url: "https://www.tiktok.com/@hoangminhngoc21" },    // daily, Gen Z beauty (makeup, mỹ phẩm), ~1.1M, 6.2 MB raw
    { name: "HTX Beauty",        platform: "tiktok",   url: "https://www.tiktok.com/@htxbeauty.lc" },       // daily, beauty-blogger collective (makeup/skincare/son), 12.9 MB raw
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
    // ── ADDED 2026-05-18: high-view rotation expansion (verified active + bitrate) ──
    { name: "Lê Chi",           platform: "tiktok", url: "https://www.tiktok.com/@lechi.official" },       // daily, FashUP Fashion Icon, phối đồ/styling, 11.4 MB raw
    { name: "Bim Nguyễn",       platform: "tiktok", url: "https://www.tiktok.com/@bimnguyen58" },          // daily, styling tips + try-on haul, 28.7 MB raw
    { name: "Tudo Khánh Linh",  platform: "tiktok", url: "https://www.tiktok.com/@tudokhanhlinh" },        // daily, fashion creator (OOTD/styling), 13.5 MB raw
    { name: "The Navarose",      platform: "tiktok", url: "https://www.tiktok.com/@the.navarose" },         // daily, fashion KOL ~5.6M followers, 5.3 MB raw
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
    // ── ADDED 2026-05-18: high-view rotation expansion (verified active + bitrate) ──
    { name: "Làm Mẹ Cùng Phương", platform: "tiktok", url: "https://www.tiktok.com/@lammecungphuongg" },  // daily, mẹ bỉm review (bỉm, sữa, ăn dặm), 6.2 MB raw
    { name: "Sếp An Nhàn",       platform: "tiktok",   url: "https://www.tiktok.com/@sepannhan" },          // daily, parenting/dạy con (bé Bống), 8.6 MB raw
    { name: "Tina Thảo Thi",     platform: "tiktok",   url: "https://www.tiktok.com/@tinathaothi" },        // daily, top VN parenting/family creator ~5M, 68 MB raw
    { name: "Gia Đình Truyền Hình", platform: "tiktok", url: "https://www.tiktok.com/@giadinhtruyenhinh" }, // daily, family vlog (kids/parenting), 16.4 MB raw
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
    // ── ADDED 2026-05-18: high-view rotation expansion (verified active + bitrate) ──
    { name: "Én Fitness",            platform: "tiktok",   url: "https://www.tiktok.com/@mc.hienvinh" },     // daily, fitness/sport challenges, 1.6M, 15.4 MB raw
    { name: "ProLifting VN",         platform: "tiktok",   url: "https://www.tiktok.com/@prolifting.vn" },   // daily, weightlifting/powerlifting technique, 16.0 MB raw
    { name: "Ngô Thuý Mông Kong",   platform: "tiktok",   url: "https://www.tiktok.com/@ngothuy.mongkong" }, // daily, gym glute/thigh training, 6.2 MB raw
    { name: "Net Việt Fitness Yoga", platform: "tiktok",   url: "https://www.tiktok.com/@fitness.yoga.netviet" }, // daily, fitness + yoga workouts, 44 MB raw
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
    // ── ADDED 2026-05-18: high-view rotation expansion (verified active + bitrate) ──
    { name: "VnExpress",          platform: "tiktok",   url: "https://www.tiktok.com/@vnexpress.official" }, // multi/day, tin tức đời sống xã hội, 3.9 MB raw
    { name: "ANH EM TV",          platform: "tiktok",   url: "https://www.tiktok.com/@anhemtv.vn" },         // daily, review sản phẩm (SChannel), 17.6 MB raw
    { name: "Út Về Vườn",        platform: "tiktok",   url: "https://www.tiktok.com/@utvevuon99" },         // daily, mẹo vặt nấu ăn/đời sống, 17.2 MB raw
    { name: "Hoshi Phan",         platform: "tiktok",   url: "https://www.tiktok.com/@hoshiphan" },          // daily, mẹo vặt nấu nướng, ~6.3M, 10.7 MB raw
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
