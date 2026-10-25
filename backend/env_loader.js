/**
 * Campus Marketplace — Environment Configuration Loader
 * 
 * Safely resolves and loads the project's .env file across execution contexts,
 * working directories, and process managers.
 */

const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

/**
 * Resolves the absolute path to the project .env file.
 * Evaluates candidate locations:
 *  1. Project root relative to backend directory (__dirname/../.env)
 *  2. Current working directory (process.cwd()/.env)
 *  3. Backend directory (__dirname/.env)
 * @returns {string} Absolute path to the resolved .env file
 */
function resolveEnvPath() {
  const candidates = [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, ".env")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to project root .env even if it does not yet exist
  return path.resolve(__dirname, "..", ".env");
}

/**
 * Loads environment variables from the resolved .env file.
 * Uses override: true to ensure file values take precedence over stale shell caches.
 * @param {string} [customPath] Optional explicit path override
 * @returns {{ resolvedPath: string, exists: boolean, loaded: boolean }}
 */
function loadEnv(customPath) {
  const resolvedPath = customPath || resolveEnvPath();
  const exists = fs.existsSync(resolvedPath);

  if (exists) {
    dotenv.config({ path: resolvedPath, override: true });
    return { resolvedPath, exists: true, loaded: true };
  }

  // Fallback to default dotenv behavior if file does not exist
  dotenv.config();
  return { resolvedPath, exists: false, loaded: false };
}

// Auto-execute load on require so any file importing env_loader loads .env immediately
const initialLoad = loadEnv();

module.exports = {
  resolveEnvPath,
  loadEnv,
  initialLoad
};
