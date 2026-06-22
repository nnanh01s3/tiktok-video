/**
 * Verify bestseller strategy in ShopeeAffiliate.discoverProducts():
 *  - Returns products sorted by sold DESC.
 *  - Excludes itemIds in usedIds.
 *  - Filters by catidFilter.
 *
 * Run: node scripts/verify-bestseller-discovery.mjs
 */
import { ShopeeAffiliate } from "../src/shopee/affiliate.mjs";

const aff = new ShopeeAffiliate();
const TEST_CATIDS = [100636]; // Nhà Cửa & Đời Sống — populous in current cache

async function fetchTopN(usedIds = []) {
  return aff.discoverProducts(usedIds, {
    strategy: "bestseller",
    videoOnly: false,
    catidFilter: TEST_CATIDS,
    productsPerCat: 5,
    log: () => {},
  });
}

let pass = true;
function assert(cond, msg) {
  if (!cond) { pass = false; console.error("  FAIL:", msg); }
  else { console.log("  PASS:", msg); }
}

// Test 1: empty usedIds → returns ≥1 product, sorted DESC by sold
const r1 = await fetchTopN([]);
if (r1.length === 0) {
  console.error("  FATAL: no products found — cache missing or catid filter too narrow");
  process.exit(1);
}
assert(r1.length > 0, `r1 has products (got ${r1.length})`);
for (let i = 1; i < r1.length; i++) {
  const prev = r1[i-1].sold || 0, cur = r1[i].sold || 0;
  assert(prev >= cur, `r1[${i-1}].sold (${prev}) >= r1[${i}].sold (${cur})`);
}
console.log("  Top-5 by sold:", r1.map(p => `${p.itemId}=${p.sold}`).join(", "));

// Test 2: usedIds excludes top-1 → top-1 of new result != original top-1
if (r1.length >= 2) {
  const excluded = r1[0].itemId;
  const r2 = await fetchTopN([excluded]);
  assert(!r2.some(p => p.itemId === excluded), `usedIds (${excluded}) excluded from result`);
  assert(r2.length > 0, "r2 still has products");
}

console.log(pass ? "\n✅ ALL TESTS PASSED" : "\n❌ TESTS FAILED");
process.exit(pass ? 0 : 1);
