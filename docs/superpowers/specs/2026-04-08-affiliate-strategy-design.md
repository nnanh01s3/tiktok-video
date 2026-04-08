# Affiliate Strategy Design — Facebook + TikTok

## Context

Hệ thống hiện tại post video sản phẩm Shopee lên 5+ Facebook pages và video quotes lên TikTok. Revenue hiện tại chỉ qua Shopee Affiliate link trong caption/comment. Mục tiêu: tối ưu hóa affiliate revenue bằng cách tận dụng Facebook Affiliate Partnerships + TikTok Shop Affiliate.

## Research Findings

### Facebook Affiliate Partnerships (Shopee x Meta)

- **Product tagging trong Reels**: Chỉ manual qua Facebook app, KHÔNG có Graph API endpoint
- **Workaround**: Gắn Shopee affiliate link trong description text — vẫn track được (cookie 7 ngày)
- **Yêu cầu**: FB page + Shopee Affiliate account (đã có cả 2)
- **Giới hạn**: 1 product tag/Reel (manual), 30 Reels/24h qua API
- **Commission**: 3-7% (Shopee standard)

### TikTok Shop Affiliate

- **Gắn giỏ hàng vào video**: Chỉ qua TikTok app/web UI, KHÔNG có API
- **Bypass 1000 followers**: Đăng ký qua TikTok Seller app → link account → giỏ hàng tự enable
- **Commission**: 10-25% (cao hơn Shopee Affiliate 3-7x)
- **CDP automation**: Có thể tự động qua browser automation trên TikTok Studio web
- **Affiliate Creator API**: Có API để search products, generate links, track orders — nhưng KHÔNG attach product vào video

---

## Design

### Phase A: Facebook — Tối ưu affiliate link (ngay bây giờ, zero code)

**Mục tiêu**: Tăng conversion từ FB Reels bằng cách kết nối Facebook Affiliate Partnerships.

**Bước 1 — Manual setup (1 lần)**:
1. Vào Facebook app → Menu → Monetization → Affiliate Partnerships → Shopee Affiliates
2. Kết nối tài khoản Shopee Affiliate (đã có)
3. Chọn tất cả FB pages

**Bước 2 — Cải thiện pipeline caption** (code change nhỏ):
- Hiện tại: caption chỉ có mô tả + hashtags
- Cải thiện: thêm Shopee affiliate link **ngay dòng đầu** caption (trước mô tả) để tăng click-through
- Format: `🛒 Link: {shortlink}\n\n{caption}`
- Đã có sẵn `appendAffLink()` trong `reup.mjs` — chỉ cần đảm bảo link nằm đầu caption

**Bước 3 — Manual product tagging (tuỳ chọn)**:
- Sau khi Reel đã post (qua automation), vào FB app tag sản phẩm thủ công
- Ưu tiên tag cho video có nhiều views (không cần tag tất cả)

**Effort**: Rất thấp. Setup 1 lần + minor caption tweak.
**Revenue impact**: Moderate — affiliate link trong description ít click hơn native product tag, nhưng vẫn track được.

### Phase B: TikTok Shop Affiliate — @suutam0405 (cần setup)

**Mục tiêu**: Kênh @suutam0405 post trending video + gắn giỏ hàng sản phẩm Shopee/TikTok Shop → commission 10-25%.

#### B1: Đăng ký TikTok Shop Affiliate (manual, 1 lần)

Dùng **Path B** (bypass 1000 followers):
1. Download **TikTok Seller app** (Android/iOS)
2. Đăng ký với TikTok credentials, chọn "Creator/Content Creator"
3. Xác minh CCCD/passport
4. Link account @suutam0405 với TikTok Shop
5. Giỏ hàng tự động enable trên profile
6. Vào Product Marketplace → thêm sản phẩm có commission cao

#### B2: Tự động gắn sản phẩm vào video (code change)

Mở rộng `tiktok-direct.mjs` để sau khi upload video, tự động:
1. Navigate tới phần "Add product link" trong upload flow
2. Search sản phẩm từ showcase
3. Chọn sản phẩm phù hợp với video content
4. Attach vào video trước khi click Post

**Implementation**: Thêm method `_attachProduct(productKeyword)` vào class `TikTokDirectPoster`:

```
async _attachProduct(keyword) {
  // 1. Click "Add product link" button trong upload form
  // 2. Search sản phẩm bằng keyword
  // 3. Click chọn sản phẩm đầu tiên
  // 4. Confirm attachment
}
```

**Gọi sau step 5 (fill caption), trước step 6 (click Post)**.

Keyword có thể derive từ video title hoặc category.

#### B3: Track commission (API)

Dùng TikTok Affiliate Creator API:
- Endpoint: `GET /affiliate/creator/orders` — lấy danh sách đơn hàng affiliate
- Tích hợp vào daily report (Telegram alert)

### Phase C: TikTok Shop cho Tuệ Đàm (tương lai, khi đủ 1000 followers)

Kênh Tuệ Đàm post quotes — không phù hợp gắn sản phẩm Shopee. Nhưng có thể:
- Gắn sách motivational (sách phát triển bản thân) vào video quotes
- Commission sách thường 5-10%
- Chỉ khi đạt 1000 followers hoặc dùng Path B (Seller app)

---

## Priority & Timeline

| Phase | Effort | Revenue | Timeline |
|-------|--------|---------|----------|
| **A**: FB Affiliate Partnerships | Rất thấp | Moderate | Ngay bây giờ |
| **B1**: Đăng ký TikTok Shop | Thấp (manual) | — | Ngay bây giờ |
| **B2**: CDP auto-attach product | Trung bình (code) | Cao (10-25%) | 1-2 ngày code |
| **B3**: Commission tracking API | Thấp | — | 1 ngày |
| **C**: Tuệ Đàm TikTok Shop | Thấp | Thấp | Khi đủ 1000 followers |

## Files to Create/Modify

| File | Action | Phase |
|------|--------|-------|
| `src/shopee/reup.mjs` | Đưa affiliate link lên đầu caption | A |
| `src/tiktok-direct.mjs` | Thêm `_attachProduct()` method | B2 |
| `src/shopee/trending_repost.mjs` | Pass product keyword khi gọi TikTok Direct | B2 |
| `src/shopee/config.mjs` | Thêm TikTok Shop product categories mapping | B2 |
| `src/tiktok-shop-api.js` | **NEW** — TikTok Affiliate Creator API wrapper | B3 |

## Success Metrics

- **FB**: Clicks trên affiliate link trong Reel description (track qua Shopee dashboard)
- **TikTok**: Số đơn affiliate qua TikTok Shop (track qua Creator API)
- **Target**: Commission tăng 3-5x so với chỉ dùng link trong comment
