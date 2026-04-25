/**
 * Test v6 with KAW air-conditioning shirt (26835798547).
 * Not in cache — build product object manually from user-provided info.
 *
 * Run: node scripts/test-hook-v6-kaw.mjs
 */
import "../src/env.js";
import { generateVeoHookVideo } from "../src/shopee/veo_hook.mjs";

const product = {
  itemId: "26835798547",
  name: "Áo Điều Hòa KAW – Làm Mát Cơ Thể, Quạt Gió 2 Chiều, Pin Sạc Dài Lâu, Chống Nắng Tốt",
  price: 846000,
  sold: 6000,
  image: "https://down-bs-vn.img.susercontent.com/vn-11134207-820l4-mep55akxzy0y31.webp",
  // No _raw → prepareImages will fall back to product.image (single cover)
  // and pad it to 1080x1920. Slideshow = 1 image looped for all slides.
};

const outputPath = "D:/tiktok/data/shopee/_test_veo_hook/v6_kaw.mp4";
console.log("v6 test KAW:", product.itemId, product.name.slice(0, 60));

const r = await generateVeoHookVideo(product, outputPath, {
  style: "urgent",       // KAW = thể thao/outdoor → urgent style
  pageName: "Thể Thao & Outdoor",
  targetDuration: 35,
  cleanup: false,
});
console.log("\n✅", r);
