/**
 * Shopee Reup — Page configurations.
 *
 * Each page has: PostFast IDs, Shopee categories, FFmpeg hook style, caption config.
 * CLI: node src/shopee/reup.mjs --page <key>
 */

// ── PostFast Social Media IDs ──────────────────────────────────────────────
// These come from PostFast dashboard → Connected Accounts
export const POSTFAST_KEY = process.env.POSTFAST_API_KEY || "rQ0ab0gM0cwTdU+eGf+WmB8cZlAOrUQ79bJWtRl3rfM=";

export const TIKTOK_ACCOUNT = "cc7c3ff7-3697-4f2f-aec1-7a044daae4b6";

// ── Shopee Category IDs ────────────────────────────────────────────────────
// From Shopee Affiliate API: affiliate.shopee.vn/api/v3/category
export const SHOPEE_CATEGORIES = {
  me_be:       [100641, 100636],
  cong_nghe:   [100642, 100630, 100632, 100633],
  gia_dung:    [100637, 100640],        // Nhà cửa & Đời sống, Gia dụng
  thoi_trang:  [100639, 100638],        // Thời trang Nữ, Nam
  lam_dep:     [100635],                // Sức khỏe & Làm đẹp
  bep:         [100637],                // Nhà cửa (bao gồm bếp)
};

// ── Page Configs ───────────────────────────────────────────────────────────
export const PAGES = {
  // Page chính — đa category, post cả TikTok + Facebook
  shopee: {
    name: "Sưu Tầm Hàng Dị",
    fbId: "f195f36e-ebec-4589-a05c-ac5ddfd15b24",
    ttId: TIKTOK_ACCOUNT,
    categories: null, // null = random across all categories
    hook: { text: "SUU TAM HANG DI", color: "red@0.85", fontSize: 46 },
    caption: { platform: "both", niche: "đồ lạ Shopee", pageName: "Sưu Tầm Hàng Dị" },
    postComments: true,
  },

  // Đồ Gia Dụng Thông Minh (đổi từ baby_reup)
  gia_dung: {
    name: "Đồ Gia Dụng Thông Minh",
    fbId: "ba5a4459-287b-4a5e-8369-d481b2593b5c",
    ttId: null,
    categories: SHOPEE_CATEGORIES.gia_dung,
    hook: { text: "DO GIA DUNG THONG MINH", color: "0x2ecc71@0.9", fontSize: 36 },
    caption: { platform: "facebook", niche: "đồ gia dụng thông minh Shopee", pageName: "Đồ Gia Dụng Thông Minh" },
    postComments: false,
  },

  // Đồ Công Nghệ Giá Tốt
  tech: {
    name: "Đồ Công Nghệ Giá Tốt",
    fbId: "0368057a-f4af-4e0f-93da-fd6826ffbc56",
    ttId: null,
    categories: SHOPEE_CATEGORIES.cong_nghe,
    hook: { text: "DO CONG NGHE GIA TOT", color: "0x1a3a8a@0.9", fontSize: 36 },
    caption: { platform: "facebook", niche: "công nghệ điện tử Shopee", pageName: "Đồ Công Nghệ Giá Tốt" },
    postComments: false,
  },

  // ── Future pages (thêm fbId khi tạo page thật) ──
  // lam_dep: {
  //   name: "Mỹ Phẩm Giá Tốt Mỗi Ngày",
  //   fbId: null,
  //   categories: SHOPEE_CATEGORIES.lam_dep,
  //   hook: { text: "MY PHAM GIA TOT", color: "0xe91e63@0.9", fontSize: 36 },
  //   caption: { platform: "facebook", niche: "mỹ phẩm làm đẹp Shopee" },
  // },
  // bep: {
  //   name: "Đồ Bếp Độc Lạ Hay Ho",
  //   fbId: null,
  //   categories: SHOPEE_CATEGORIES.bep,
  //   hook: { text: "DO BEP DOC LA", color: "0xff6b35@0.9", fontSize: 36 },
  //   caption: { platform: "facebook", niche: "đồ bếp độc lạ Shopee" },
  // },
};

// ── Trending Repost Config ────────────────────────────────────────────────
export const TRENDING_CONFIG = {
  fbPageId: "f195f36e-ebec-4589-a05c-ac5ddfd15b24", // Sưu Tầm Hàng Dị
  tiktokId: null, // Set khi tạo page TikTok mới trên PostFast
  // Từ khóa tìm video trending (rotate mỗi lần chạy)
  tiktokKeywords: [
    "hàng độc lạ", "đồ gia dụng thông minh", "sản phẩm hay",
    "review đồ shopee", "đồ công nghệ hay", "đồ bếp thông minh",
    "phát minh hay", "sản phẩm tiktok", "đồ lạ trung quốc",
  ],
  fbWatchKeywords: [
    "đồ gia dụng thông minh", "hàng độc lạ", "sản phẩm hay ho",
    "review shopee", "đồ công nghệ", "phát minh sáng tạo",
  ],
  // Khung giờ vàng Vietnam (giờ bắt đầu)
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
export const MAX_PER_RUN = 2;
