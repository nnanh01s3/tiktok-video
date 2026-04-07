/**
 * Shopee Reup — Page configurations.
 *
 * Each page has: PostFast IDs, Shopee categories, FFmpeg hook style, caption config.
 * CLI: node src/shopee/reup.mjs --page <key>
 */

// ── PostFast Social Media IDs ──────────────────────────────────────────────
// These come from PostFast dashboard → Connected Accounts
// PostFast API key — optional (not needed for TikTok Direct posting)
export const POSTFAST_KEY = process.env.POSTFA_API_KEY || process.env.POSTFAST_API_KEY || "";

export const TIKTOK_ACCOUNT = "cc7c3ff7-3697-4f2f-aec1-7a044daae4b6";

// ── Shopee Category IDs ────────────────────────────────────────────────────
// From Shopee Affiliate API: affiliate.shopee.vn/api/v3/category
// 16 categories, mỗi cái 500 SP có video
export const SHOPEE_CATEGORIES = {
  cong_nghe:   [100642, 100630, 100632, 100633],  // Điện tử, ĐT, Laptop, Đồng hồ
  gia_dung:    [100636, 100640],                   // Nhà cửa & Đời sống, Thời trang Nam (gia dụng)
  sac_dep:     [100637],                           // Sắc Đẹp
  thoi_trang:  [100638, 100640, 100634, 100635],   // TT Nữ, TT Nam, Giày Dép, Túi Ví
  me_be:       [100641],                           // Mẹ & Bé
  the_thao:    [100010],                           // Thể Thao & Du Lịch
  xe_co:       [100011],                           // Ô Tô & Xe Máy
  suc_khoe:    [100012],                           // Sức Khỏe
  bach_hoa:    [100639, 100017],                   // Bách Hóa Online, Nhà Sách
};

// ── Page Configs ───────────────────────────────────────────────────────────
// provider: "postfast" (legacy, hết hạn 29/4) | "postforme" (new, unlimited)
// fbId: PostFast UUID | pfmId: PostForMe account ID
// pfmId sẽ được điền sau khi tạo FB page + connect PostForMe
export const PAGES = {
  // ══════════════════════════════════════════════════════════════════════════
  // EXISTING PAGES (PostFast — chuyển sang PostForMe sau 29/4)
  // ══════════════════════════════════════════════════════════════════════════

  shopee: {
    name: "Sưu Tầm Hàng Dị",
    provider: "postfast",
    fbId: "f195f36e-ebec-4589-a05c-ac5ddfd15b24",
    pfmId: null, // TODO: add PostForMe ID after migration
    ttId: TIKTOK_ACCOUNT,
    categories: null, // null = random across all categories
    caption: { platform: "both", niche: "đồ lạ Shopee", pageName: "Sưu Tầm Hàng Dị" },
    postComments: true,
  },

  gia_dung: {
    name: "Đồ Gia Dụng Thông Minh",
    provider: "postfast",
    fbId: "ba5a4459-287b-4a5e-8369-d481b2593b5c",
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.gia_dung,
    caption: { platform: "facebook", niche: "đồ gia dụng thông minh Shopee", pageName: "Đồ Gia Dụng Thông Minh" },
    postComments: false,
  },

  tech: {
    name: "Đồ Công Nghệ Giá Tốt",
    provider: "postfast",
    fbId: "0368057a-f4af-4e0f-93da-fd6826ffbc56",
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.cong_nghe,
    caption: { platform: "facebook", niche: "công nghệ điện tử Shopee", pageName: "Đồ Công Nghệ Giá Tốt" },
    postComments: false,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // NEW PAGES (PostForMe — cần tạo FB page + connect PostForMe trước)
  // ══════════════════════════════════════════════════════════════════════════

  sac_dep: {
    name: "Mỹ Phẩm Giá Tốt",
    provider: "postforme",
    fbId: null,
    pfmId: null, // TODO: add after creating FB page + connecting PostForMe
    ttId: null,
    categories: SHOPEE_CATEGORIES.sac_dep,
    caption: { platform: "facebook", niche: "mỹ phẩm làm đẹp Shopee", pageName: "Mỹ Phẩm Giá Tốt" },
    postComments: false,
  },

  thoi_trang: {
    name: "Thời Trang & Phụ Kiện",
    provider: "postforme",
    fbId: null,
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.thoi_trang,
    caption: { platform: "facebook", niche: "thời trang phụ kiện Shopee", pageName: "Thời Trang & Phụ Kiện" },
    postComments: false,
  },

  me_be: {
    name: "Mẹ & Bé Thông Minh",
    provider: "postforme",
    fbId: null,
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.me_be,
    caption: { platform: "facebook", niche: "đồ mẹ và bé Shopee", pageName: "Mẹ & Bé Thông Minh" },
    postComments: false,
  },

  the_thao: {
    name: "Thể Thao & Outdoor",
    provider: "postforme",
    fbId: null,
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.the_thao,
    caption: { platform: "facebook", niche: "đồ thể thao outdoor Shopee", pageName: "Thể Thao & Outdoor" },
    postComments: false,
  },

  xe_co: {
    name: "Phụ Kiện Xe Hơi & Xe Máy",
    provider: "postforme",
    fbId: null,
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.xe_co,
    caption: { platform: "facebook", niche: "phụ kiện xe hơi xe máy Shopee", pageName: "Phụ Kiện Xe Hơi & Xe Máy" },
    postComments: false,
  },

  suc_khoe: {
    name: "Sức Khỏe Mỗi Ngày",
    provider: "postforme",
    fbId: null,
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.suc_khoe,
    caption: { platform: "facebook", niche: "sức khỏe chăm sóc bản thân Shopee", pageName: "Sức Khỏe Mỗi Ngày" },
    postComments: false,
  },

  bach_hoa: {
    name: "Bách Hóa & Sách Hay",
    provider: "postforme",
    fbId: null,
    pfmId: null,
    ttId: null,
    categories: SHOPEE_CATEGORIES.bach_hoa,
    caption: { platform: "facebook", niche: "bách hóa sách hay Shopee", pageName: "Bách Hóa & Sách Hay" },
    postComments: false,
  },
};

// ── Trending Repost Config ────────────────────────────────────────────────
export const TRENDING_CONFIG = {
  fbPageId: "f195f36e-ebec-4589-a05c-ac5ddfd15b24", // Sưu Tầm Hàng Dị
  tiktokId: null, // PostFast TikTok UUID (null = không dùng PostFast cho TikTok)
  // TikTok Direct posting — bypass PostFast account limit
  // Cách dùng: Mở Chrome 1 lần với --remote-debugging-port=9402, login TikTok @suutam0405
  // Hoặc để module tự launch Chrome với profile riêng (cần login lần đầu)
  tiktokDirect: {
    account: "suutam0405",            // @suutam0405
    cdpPort: 9402,                    // Chrome CDP port (tránh xung đột 9399-9401)
    chromeProfile: "D:/tiktok/data/tiktok/chrome_profile",
  },
  // Không dùng keyword nữa — scrape trực tiếp từ For You / Explore / FB Watch
  // Giữ lại để backward compatible (không dùng trong trending flow mới)
  tiktokKeywords: [],
  fbWatchKeywords: [],
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
