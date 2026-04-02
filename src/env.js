/**
 * Load environment variables from config/.env.
 * Must be imported before any module that reads process.env.
 *
 * Uses dotenv.parse + manual assignment because dotenv.config()
 * silently fails to set process.env for values containing
 * special characters (=, +) on some platforms.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", "config", ".env");

const parsed = dotenv.parse(readFileSync(envPath));
for (const [key, value] of Object.entries(parsed)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
