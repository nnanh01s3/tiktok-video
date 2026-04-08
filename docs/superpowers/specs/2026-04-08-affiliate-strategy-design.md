# Affiliate Strategy Design — Facebook + TikTok

## Context

Hệ thống hiện tại:
- **6 Facebook pages** đang active (shopee, gia_dung, tech, sac_dep, thoi_trang, me_be), post video sản phẩm Shopee dưới dạng Reels
- **TikTok Tuệ Đàm** (@trituemoingay.vn): video quotes truyền cảm hứng (< 1000 followers)
- **TikTok @suutam0405**: video trending viral (< 1000 followers)
- Revenue hiện tại: chỉ qua Shopee Affiliate link trong caption/comment (commission 3-7%)

**Mục tiêu**: Tối ưu affiliate revenue bằng Facebook Affiliate Partnerships + TikTok Shop Affiliate.

## Research Findings

### Facebook Affiliate Partnerships (Shopee x Meta)

- **Product tagging trong Reels**: Chỉ manual qua Facebook app, KHÔNG có Graph API endpoint
- **Workaround**: Gắn Shopee affiliate link trong description text — vẫn track được (cookie 7 ngày)
- **Yêu cầu**: FB page + Shopee Affiliate account (đã có cả 2)
- **Giới hạn**: 1 product tag/Reel (manual), 30 Reels/24h qua API
- **Commission**: 3-7% (Shopee standard), Meta bonus 1% cho top creators

### TikTok Shop Affiliate

- **Gắn giỏ hàng vào video**: Chỉ qua TikTok app/web UI, KHÔNG có API attach product vào video
- **Bypass 1000 followers**: Đăng ký qua TikTok Seller app → link account → giỏ hàng tự enable
- **Commission**: 10-25% (seller trả cho creator, cao hơn Shopee Affiliate 3-7x)
- **Lưu ý**: Sản phẩm trên TikTok Shop là của seller TikTok, KHÔNG phải sản phẩm Shopee. Đây là hệ sinh thái riêng biệt.
- **CDP automation**: Có thể tự động gắn sản phẩm qua browser automation trên TikTok Studio web
- **Affiliate Creator API**: Có API để search products, generate links, track orders — nhưng KHÔNG attach product vào video

---

## Design

### Phase A: Facebook — Tối ưu affiliate link

**Mục tiêu**: Tăng conversion từ FB Reels hiện tại.

**Bước 1 — Kết nối Facebook Affiliate Partnerships (manual, 1 lần)**:
1. Vào Facebook app → Menu → Monetization → Affiliate Partnerships → Shopee Affiliates
2. Kết nối tài khoản Shopee Affiliate (đã có)
3. Chọn tất cả 6 FB pages đang active
4. Sau khi kết nối: có thể tag sản phẩm thủ công trong FB app cho video có nhiều views

**Bước 2 — Cải thiện caption trong pipeline (code change nhỏ)**:
- Hiện tại: affiliate link nằm cuối caption hoặc trong comment 60 phút sau
- Cải thiện: đưa affiliate link **lên đầu caption** để tăng visibility
- Format mới: `🛒 {shortlink}\n\n{caption text}\n\n{hashtags}`
- File: `src/shopee/reup.mjs` — sửa `appendAffLink()` để prepend thay vì append

**Effort**: Thấp — setup manual 1 lần + sửa 1 function.
**Revenue impact**: Tăng click-through trên affiliate link. Manual product tagging cho video top views tăng thêm conversion.

### Phase B: TikTok Shop Affiliate — @suutam0405

**Mục tiêu**: Kênh @suutam0405 post trending video + gắn giỏ hàng sản phẩm TikTok Shop → commission 10-25%.

**Lưu ý quan trọng**: TikTok Shop Affiliate bán sản phẩm của **seller trên TikTok Shop** (không phải Shopee). Đây là nguồn revenue **bổ sung**, không thay thế Shopee Affiliate.

#### B1: Đăng ký TikTok Shop Affiliate (manual, 1 lần)

Dùng **Path B** (bypass 1000 followers):
1. Download **TikTok Seller app** (Android/iOS)
2. Đăng ký với TikTok credentials của @suutam0405, chọn "Creator/Content Creator"
3. Xác minh CCCD/passport
4. Link account @suutam0405 với TikTok Shop
5. Giỏ hàng tự động enable trên profile
6. Vào Product Marketplace → thêm sản phẩm trending có commission cao (Beauty 10-20%, Fashion 10-15%)

#### B2: Tự động gắn sản phẩm vào video (code change)

Mở rộng `tiktok-direct.mjs` — thêm step giữa "fill caption" và "click Post":
1. Click "Add product link" button trong upload form
2. Search sản phẩm từ showcase bằng keyword (derive từ video category)
3. Chọn sản phẩm đầu tiên match
4. Confirm attachment

**Implementation**: Thêm method `_attachProduct(keyword)` vào class `TikTokDirectPoster`.
Gọi trong `_doPost()` sau step 5 (fill caption), trước step 5b (wait content checks).

**Rủi ro CDP automation**:
- TikTok có thể detect browser automation → flag/ban account
- Mitigation: dùng anti-detection đã có (hide webdriver), giới hạn 3-5 posts/ngày, random delays
- Nếu bị flag: fallback về post không có product link (vẫn hoạt động)

#### B3: Track commission (API)

Dùng TikTok Affiliate Creator API:
- Endpoint: search products, generate affiliate links, query orders
- Tích hợp vào daily report (Telegram alert) — hiển thị đơn hàng + commission earned
- File: `src/tiktok-shop-api.js` (new module)

### Phase C: TikTok Shop cho Tuệ Đàm (tuỳ chọn)

Kênh Tuệ Đàm post quotes — gắn sản phẩm Shopee không phù hợp. Nhưng có thể:
- Gắn **sách motivational** (sách phát triển bản thân) từ TikTok Shop vào video quotes
- Commission sách: 5-10%
- Có thể dùng Path B (Seller app) để bypass 1000 followers, giống @suutam0405
- **Chỉ nên làm sau khi Phase B đã ổn định** — tránh phân tán effort

---

## Priority & Timeline

| Phase | Effort | Revenue | Timeline |
|-------|--------|---------|----------|
| **A**: FB Affiliate Partnerships setup + caption tweak | Thấp | Moderate (3-7%) | Ngay bây giờ |
| **B1**: Đăng ký TikTok Shop cho @suutam0405 | Thấp (manual) | — | Ngay bây giờ |
| **B2**: CDP auto-attach product vào TikTok video | Trung bình | Cao (10-25%) | 1-2 ngày code |
| **B3**: Commission tracking API + Telegram report | Thấp | — | 1 ngày |
| **C**: Tuệ Đàm gắn sách vào quotes | Thấp | Thấp (5-10%) | Sau khi Phase B ổn |

## Files to Create/Modify

| File | Action | Phase |
|------|--------|-------|
| `src/shopee/reup.mjs` | Sửa `appendAffLink()`: prepend link thay vì append | A |
| `src/tiktok-direct.mjs` | Thêm `_attachProduct(keyword)` method | B2 |
| `src/shopee/trending_repost.mjs` | Pass product keyword khi gọi TikTok Direct poster | B2 |
| `src/tiktok-shop-api.js` | **NEW** — TikTok Affiliate Creator API wrapper | B3 |

## Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| TikTok ban account do CDP automation | Cao — mất kênh | Giới hạn 3-5 posts/ngày, random delays, anti-detection, fallback không gắn product |
| Facebook không cho tag product qua API | Thấp — đã biết | Dùng affiliate link trong description (workaround đã xác nhận) |
| TikTok Shop thay đổi UI upload | Trung bình — CDP selectors break | Maintain selectors, log errors, manual fallback |
| Shopee cookie hết hạn thường xuyên | Thấp — đã có fallback cache | Cache 24h + expired cache fallback (đã implement) |

## Success Metrics

- **FB**: Click-through rate trên affiliate link trong Reel description (track qua Shopee Affiliate dashboard)
- **TikTok**: Số đơn affiliate + tổng commission qua TikTok Shop (track qua Creator API)
- **Target**: Tổng commission tăng 3-5x so với chỉ dùng Shopee link trong comment
