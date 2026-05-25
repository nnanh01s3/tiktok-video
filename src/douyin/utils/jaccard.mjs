/**
 * Character-level Jaccard similarity for CJK OCR dedup.
 * Returns 0..1.
 */
export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const sa = new Set([...a]);
  const sb = new Set([...b]);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  const union = sa.size + sb.size - inter;
  return inter / union;
}

export function isSameText(a, b, threshold = 0.85) {
  return jaccardSimilarity(a, b) >= threshold;
}
