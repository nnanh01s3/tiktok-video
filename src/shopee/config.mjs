/**
 * Shopee Reup — Page configurations.
 *
 * All pages now use PostForMe (postforme.dev) — PostFast removed.
 * CLI: node src/shopee/reup.mjs --page <key>
 */

// ── PostForMe is the sole posting provider ────────────────────────────────
// Legacy PostFast key kept for backward compat (fb_repost comment feature)
export const POSTFAST_KEY = process.env.POSTFA_API_KEY || process.env.POSTFAST_API_KEY || "";

// ── TikTok Quotes pipeline (Tuệ Đàm — chỉ post quotes, KHÔNG post Shopee) ──
export const TIKTOK_QUOTES_CONFIG = {
  provider: "postforme",
  pfmTtId: "spc_rbYFCtoEuLh8fa3ravla", // PostForMe: Tuệ Đàm (@trituemoingay.vn)
};

// ── Shopee Category IDs ────────────────────────────────────────────────────
// match_id: Affiliate API filter | catid: product category thực tế
export const SHOPEE_MATCH_IDS = [100630, 100632, 100633, 100634, 100635, 100636, 100637, 100638, 100639, 100640, 100641, 100642, 100010, 100011, 100012, 100017];

export const SHOPEE_CATEGORIES = {
  cong_nghe:   { catids: [100013, 100642, 100630],  matchIds: [100642, 100630, 100632, 100633] },
  gia_dung:    { catids: [100010, 100632, 100636],   matchIds: [100636, 100640] },
  sac_dep:     { catids: [100637],                   matchIds: [100637] },
  thoi_trang:  { catids: [100009, 100011, 100017, 100532, 100640], matchIds: [100638, 100640, 100634, 100635] },
  me_be:       { catids: [100641],                   matchIds: [100641] },
  the_thao:    { catids: [100010],                   matchIds: [100010] },
  xe_co:       { catids: [100011, 100636],           matchIds: [100011] },
  suc_khoe:    { catids: [100012],                   matchIds: [100012] },
  bach_hoa:    { catids: [100001, 100629, 100639],   matchIds: [100639, 100017] },
};

// ── Page Configs — ALL PostForMe ──────────────────────────────────────────
export const PAGES = {
  shopee: {
    name: "Sưu Tầm Hàng Dị",
    provider: "postforme",
    pfmId: "spc_C3WkWJpvHzKu8FaSbxHI",
    categories: null,
    caption: { platform: "facebook", niche: "đồ lạ Shopee", pageName: "Sưu Tầm Hàng Dị" },
    postComments: false,
  },

  gia_dung: {
    name: "Đồ Gia Dụng",
    provider: "postforme",
    pfmId: "spc_a0J7Ej8WH2gbWdmMRB6y",
    categories: SHOPEE_CATEGORIES.gia_dung,
    caption: { platform: "facebook", niche: "đồ gia dụng thông minh Shopee", pageName: "Đồ Gia Dụng" },
    postComments: false,
  },

  tech: {
    name: "Đồ Công Nghệ Giá Tốt",
    provider: "postforme",
    pfmId: "spc_PpykhqiyaIA4MLKGtcq9",
    categories: SHOPEE_CATEGORIES.cong_nghe,
    caption: { platform: "facebook", niche: "công nghệ điện tử Shopee", pageName: "Đồ Công Nghệ Giá Tốt" },
    postComments: false,
  },

  sac_dep: {
    name: "Mỹ Phẩm Giá Tốt",
    provider: "postforme",
    pfmId: "spc_0mCo8bI7sumS73I9TrMS",
    categories: SHOPEE_CATEGORIES.sac_dep,
    caption: { platform: "facebook", niche: "mỹ phẩm làm đẹp Shopee", pageName: "Mỹ Phẩm Giá Tốt" },
    postComments: false,
  },

  thoi_trang: {
    name: "Thời Trang & Phụ Kiện",
    provider: "postforme",
    pfmId: "spc_xsu6ea04M0zD3M8w4cLLE",
    categories: SHOPEE_CATEGORIES.thoi_trang,
    caption: { platform: "facebook", niche: "thời trang phụ kiện Shopee", pageName: "Thời Trang & Phụ Kiện" },
    postComments: false,
  },

  me_be: {
    name: "Mẹ & Bé Thông Minh",
    provider: "postforme",
    pfmId: "spc_lHWm4m0YMPDd6fQDKCgjQ",
    categories: SHOPEE_CATEGORIES.me_be,
    caption: { platform: "facebook", niche: "đồ mẹ và bé Shopee", pageName: "Mẹ & Bé Thông Minh" },
    postComments: false,
  },

  the_thao: {
    name: "Thể Thao & Outdoor",
    provider: "postforme",
    pfmId: "spc_9xXQctmz4DENWgzFoziv",
    categories: SHOPEE_CATEGORIES.the_thao,
    caption: { platform: "facebook", niche: "đồ thể thao outdoor Shopee", pageName: "Thể Thao & Outdoor" },
    postComments: false,
  },

  bach_hoa: {
    name: "Bách Hóa & Sách Hay",
    provider: "postforme",
    pfmId: "spc_PnUumgq90Zc2aALTC3R",
    categories: SHOPEE_CATEGORIES.bach_hoa,
    caption: { platform: "facebook", niche: "bách hóa sách hay Shopee", pageName: "Bách Hóa & Sách Hay" },
    postComments: false,
  },
};

// ── Trending Repost Config ────────────────────────────────────────────────
export const TRENDING_CONFIG = {
  provider: "postforme",
  pfmFbId: "spc_C3WkWJpvHzKu8FaSbxHI", // Sưu Tầm Hàng Dị (PostForMe)
  // TikTok Direct posting (Chrome CDP)
  tiktokDirect: {
    account: "suutam0405",
    cdpPort: 9402,
    chromeProfile: "D:/tiktok/data/tiktok/chrome_profile",
  },
  tiktokKeywords: [],
  fbWatchKeywords: [],
  goldenHours: [7, 11, 17, 20],
  maxPerDay: 5,
  maxPerRun: 3,
  minDuration: 10,
  maxDuration: 180,
};

// ── Paths (Windows local) ──────────────────────────────────────────────────
export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
export const FONT = process.env.FONT_PATH || "C:/Windows/Fonts/arial.ttf";
export const BASE_DIR = "D:/tiktok/data/shopee";
export const MAX_PER_DAY = 12;
export const MAX_PER_RUN = 1; // 1 video per page per daily run (was 2)
