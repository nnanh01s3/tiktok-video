/**
 * ESM "is this module the entrypoint?" check that works correctly on Windows
 * with relative argv[1] paths and when argv[1] is undefined (e.g. node -e).
 *
 * Usage at bottom of a module:
 *   if (isMainModule(import.meta.url)) { ... CLI handler ... }
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryUrl = pathToFileURL(resolve(entry)).href;
    return entryUrl === importMetaUrl;
  } catch {
    return false;
  }
}
