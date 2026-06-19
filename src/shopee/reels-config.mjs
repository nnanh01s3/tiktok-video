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
    // ── ADDED 2026-05-22: long-format đồ-độc-lạ roundup (verified 12MB+ raw) ──
    { name: "Hằng Đi Buôn 2",          platform: "tiktok", url: "https://www.tiktok.com/@hangdibuon.2" },        // roundup reviews đồ độc lạ nội địa TQ, 50-111s videos, verified 12 MB raw
    // ── ADDED 2026-06-14: source expansion for 5-slot cadence (niche sparse — only 2 confirmed). ──
    { name: "Idea Shop VN",            platform: "tiktok", url: "https://www.tiktok.com/@ideashopvn" },           // EDC/fidget/novelty gadgets, 180-314s very long → always clears 2MB, active 2026-06
    { name: "Gia Dụng Tiện Ích TM",    platform: "tiktok", url: "https://www.tiktok.com/@giadungtienichthongminh3" }, // gadget tiện ích demos, MULTIPLE posts/day (high inventory), 42-57s, original-sound
    // ── ADDED 2026-06-19: shopee weakest page (56% miss) — niche genuinely sparse, only 1 new verified ──
    { name: "Jan2 Decor",              platform: "tiktok", url: "https://www.tiktok.com/@jan2.decor" },          // "tổng hợp món đồ bếp/nhà cửa" gadget roundups, 6/8 ≥40s (med ~85s), 1080p 16-30MB, âm thanh gốc; ~50% on-niche
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
    // ── ADDED 2026-05-22: long-format roundup channels (verified 12MB+ raw, fixes <2MB filter failures) ──
    { name: "Hằng Đi Buôn 2",          platform: "tiktok",   url: "https://www.tiktok.com/@hangdibuon.2" },            // roundup reviews đồ gia dụng nội địa TQ, 50-111s videos, verified 12 MB raw — NOTE: drifted to travel vlogs, high off-topic rate
    { name: "Sam Home",                platform: "tiktok",   url: "https://www.tiktok.com/@samhome_" },                // "Tổng hợp món đồ gia dụng" series, 59-75s videos, verified 11.8 MB raw — NOTE: drifted, high off-topic rate
    // ── ADDED 2026-05-31: long-format "thử nghiệm/review có thật sự" archetype (verified 7/8 vids ≥40s, 1080p 14-18MB raw). ──
    // Mixed topics (~50% gia_dung, ~50% beauty/toy) but on-topic clips are 2-3min → reliably >2MB after FFmpeg. The "đủ dài để qua bitrate filter" win gia_dung lacked.
    { name: "Bếp Nhà Thỏ Phương Chi",  platform: "tiktok",   url: "https://www.tiktok.com/@bepnhathophuongchi" },     // 99-229s long-format product reviews, 1080p ~14-18MB raw, active 2026-05
    // ── ADDED 2026-06-14: more "thử nghiệm/test/đập hộp" personality channels for 5-slot cadence. ──
    { name: "Kiên Review",             platform: "tiktok",   url: "https://www.tiktok.com/@kienthanhle90" },          // "thánh review" test/đập hộp, daily, 36-111s, gadgets+small appliances+smart home
    { name: "Hạnh Chia Sẻ",            platform: "tiktok",   url: "https://www.tiktok.com/@hanhchiase.xaykenh" },     // self-test reviews, daily, 43-77s, 6/6 âm thanh gốc, máy làm đá/quạt/ổ cắm/đèn
    { name: "Trung Quốc Có Gì Hot",    platform: "tiktok",   url: "https://www.tiktok.com/@trungquoccogihot12021988" }, // kitchen/cleaning gadget "có thật sự tốt?" tests, 47-76s, most on-topic kitchen
    // ── ADDED 2026-06-19: gia_dung still missed ~39% — more "thử nghiệm/có thật sự tốt" long-format channels ──
    { name: "Đen Đá Trải Nghiệm",      platform: "tiktok",   url: "https://www.tiktok.com/@dendatrainghiem" },        // BEST archetype: "có thực sự tốt như quảng cáo" tests, 8/8 ≥40s (med 238s!), multi/day, 8/8 âm thanh gốc
    { name: "Điện Máy Xanh OL",        platform: "tiktok",   url: "https://www.tiktok.com/@dienmayxanh.ol" },          // official high-inventory điện máy/gia dụng, 7/8 ≥40s, 1080p 10.7MB, 8/8 âm thanh gốc
    { name: "Điện Máy Huân Liên",      platform: "tiktok",   url: "https://www.tiktok.com/@dienmayhuanlien0" },       // máy bơm/tưới vườn "có nên mua", 8/8 ≥40s (53-123s), 720p verified, daily
    { name: "NV Tỷ Đồ Nghề",           platform: "tiktok",   url: "https://www.tiktok.com/@nvty75" },                  // home tools/gadgets "có nên mua", 8/8 ≥40s (68-155s); mostly commercial-audio
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
    // REMOVED 2026-05-27: HannahOlala (user request)
    { name: "Tom Skincare",      platform: "tiktok",   url: "https://www.tiktok.com/@tomskincare" },        // daily, minimalist skincare routines/reviews, 8.4 MB raw
    { name: "Hoàng Minh Ngọc",  platform: "tiktok",   url: "https://www.tiktok.com/@hoangminhngoc21" },    // daily, Gen Z beauty (makeup, mỹ phẩm), ~1.1M, 6.2 MB raw
    { name: "HTX Beauty",        platform: "tiktok",   url: "https://www.tiktok.com/@htxbeauty.lc" },       // daily, beauty-blogger collective (makeup/skincare/son), 12.9 MB raw
    // ── ADDED 2026-06-14: source expansion post-HannahOlala removal + 5-slot cadence. All verified
    // 6/6 (top 4) "âm thanh gốc" narrated reviews → FB-mute safe, long-format 80-470s → clears bitrate. ──
    { name: "Skincare Đúng Cách", platform: "tiktok",  url: "https://www.tiktok.com/@skincaredungcach.byson" }, // TOP PICK: 12/12 âm thanh gốc, pure skincare/KCN/serum, 120-470s, 1080p 9-23MB
    { name: "Sâu Biu Ti",        platform: "tiktok",   url: "https://www.tiktok.com/@sobeauty.glx" },        // 12/12 âm thanh gốc, skincare da dầu mụn + KCN budget, daily, 88-152s
    { name: "Hồ Ánh Trinh",      platform: "tiktok",   url: "https://www.tiktok.com/@kikianhtrinh" },        // 12/12 original sound, makeup+skincare full-face reviews, 82-344s
    { name: "Kỳ Kỳ",            platform: "tiktok",   url: "https://www.tiktok.com/@unofficiallykyky" },    // 10/12 original sound, skincare talking reviews, 73-306s
    { name: "An Phương",        platform: "tiktok",   url: "https://www.tiktok.com/@anphuongtruong" },      // 10/12 original, skincare+beauty; scorer filters occasional travel/bag posts
    { name: "Thanh Phương Lê",  platform: "tiktok",   url: "https://www.tiktok.com/@thanhphuonglede" },     // 11/12 âm thanh gốc, làm đẹp facial+hair/body, 72-333s
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
    // ── ADDED 2026-06-19: thoi_trang missed ~49% — OOTD/try-on long-format expansion (prefer the ≥40s ones) ──
    { name: "Cao Kim Chi",       platform: "tiktok", url: "https://www.tiktok.com/@caokiimchi" },           // OOTD/mix đồ/try-on, 8/8 ≥40s (48-109s), 1080p 10MB, 7/8 âm thanh gốc — strongest
    { name: "Minh Hải Review",   platform: "tiktok", url: "https://www.tiktok.com/@minhhaireview2" },        // review quần áo nữ+unisex, MULTI/day (high inventory), 7/8 ≥40s (39-171s), 8/8 gốc
    { name: "nghĩa (ajihgnn)",   platform: "tiktok", url: "https://www.tiktok.com/@nnghija" },               // outfit/ratingoutfits/haul, 4/8 ≥40s (44-146s), 1080p 13MB best-bitrate, 7/8 gốc
    { name: "Hùng Phạm",         platform: "tiktok", url: "https://www.tiktok.com/@iam.hung2702" },          // men's fashion (zip shirt/fitcheck/sơ mi), 6/8 ≥40s (41-90s)
    { name: "Teddy (Phi Vĩ)",    platform: "tiktok", url: "https://www.tiktok.com/@teddy2606" },             // men's OOTD #daily, multi/day, 8/8 âm thanh gốc; ~half clips short (<40s skip)
  ],

  // ── me_be (Mẹ & Bé) — parenting, baby products ──
  me_be: [
    { name: "Fansie Family",      platform: "tiktok",   url: "https://www.tiktok.com/@befansie" },
    { name: "Giang Chè Xíu Xôi", platform: "tiktok",   url: "https://www.tiktok.com/@giangchekm" },
    { name: "Salim Official",     platform: "tiktok",   url: "https://www.tiktok.com/@salim_official" },
    { name: "Isis Min",           platform: "facebook", url: "https://www.facebook.com/isismin.vietnam" },
    // ── NEW: high-frequency ──
    // REMOVED 2026-06-10: BabyKopo Home (@babykopohome) — frequent copyright claims on reposts (user request)
    { name: "Xoài Fam (Trang Lou)", platform: "tiktok", url: "https://www.tiktok.com/@xoaifam" },          // daily, 797K, mom-baby lifestyle
    { name: "Gia Đình Cam Cam",  platform: "tiktok",   url: "https://www.tiktok.com/@giadinhcamcam" },     // daily, 725K, family vlogs + tips
    { name: "Nguyễn Vy Family",  platform: "tiktok",   url: "https://www.tiktok.com/@nguyenvy1234567" },   // daily, 1M, #1 family TikTok VN
    // ── ADDED 2026-05-18: high-view rotation expansion (verified active + bitrate) ──
    { name: "Làm Mẹ Cùng Phương", platform: "tiktok", url: "https://www.tiktok.com/@lammecungphuongg" },  // daily, mẹ bỉm review (bỉm, sữa, ăn dặm), 6.2 MB raw
    { name: "Sếp An Nhàn",       platform: "tiktok",   url: "https://www.tiktok.com/@sepannhan" },          // daily, parenting/dạy con (bé Bống), 8.6 MB raw
    { name: "Tina Thảo Thi",     platform: "tiktok",   url: "https://www.tiktok.com/@tinathaothi" },        // daily, top VN parenting/family creator ~5M, 68 MB raw
    // REMOVED 2026-06-18: Gia Đình Truyền Hình (@giadinhtruyenhinh) — copyright claims on reposts (user request)
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
    // ── ADDED 2026-06-10: BÓNG ĐÁ sources (user request — page had zero football content).
    // All verified via 3-stage funnel: active ≤5 days, ≥30s majority, 1080p ≥4MB raw, "âm thanh gốc"
    // majority (FB-mute safe). Original-filming skills/freestyle/futsal only — NO broadcast
    // match highlights (FB Rights Manager flags broadcast football footage → page strike risk).
    { name: "Việt Anh Football",       platform: "tiktok", url: "https://www.tiktok.com/@viet_anh_219" },          // freestyle 2.7M, TikTok Awards Best Sports Creator 2024, 39-96s
    { name: "Đỗ Kim Phúc",             platform: "tiktok", url: "https://www.tiktok.com/@dokimphuc.official" },    // freestyle/analysis, 42-99s, 100% âm thanh gốc, 10MB/71s
    { name: "Nguyễn Duy Trung",        platform: "tiktok", url: "https://www.tiktok.com/@duytrung.official" },     // skill creator (Trung Spin Kick), 1M, all videos 32s+
    { name: "Văn Anh Neymar",          platform: "tiktok", url: "https://www.tiktok.com/@vananhneymar" },          // Sport Creator of the Year 2025, challenges/journey, 34-75s
    { name: "Nguyễn Đắc Huy (Futsal)", platform: "tiktok", url: "https://www.tiktok.com/@nguyendachuy_official" }, // futsal nat'l team, training/matches; ~30% clips <30s get filtered
    // ── ADDED 2026-06-15: World Cup 2026 commentary (SAFE — creator MC talking-head, NOT broadcast highlights).
    // Verified active 15/6, 34-79s. NOTE: dùng nhạc nền → FB có thể mute audio (dựa caption/visual). KHÔNG thêm
    // các kênh repost highlight trận đấu (VTV/broadcaster) — FB Rights Manager strike chắc chắn, rủi ro page.
    { name: "Bóng Đá Vui Vẻ",      platform: "tiktok", url: "https://www.tiktok.com/@bongdavuive8386" },  // MC bình luận hài + dự đoán WC, daily, 23-79s
    { name: "Bóng Đá Tiếu Lâm TV", platform: "tiktok", url: "https://www.tiktok.com/@bongdatieulamtv" },  // "Gà Siêu Phệ" bình luận/preview WC, 34-66s, 1080p 12.8MB
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
