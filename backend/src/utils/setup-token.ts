/**
 * Setup Token
 *
 * One-shot token bound to the local installer that gates the unauthenticated
 * /api/setup/initialize endpoint. Generated on backend startup whenever no
 * config.json is present and consumed (deleted) once OOBE completes.
 *
 * Why this exists: even with refuseIfSetupComplete + admin-user guards, there
 * is a brief window between server startup and the legitimate operator
 * submitting the OOBE form during which an attacker who can reach the API
 * could win the race. Requiring the token — readable only with filesystem
 * access to the data directory — proves the request originated from the
 * installer, not the open internet. See ticket #687.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "../config.js";
import { info, warn, error } from "./logger.js";

const TOKEN_FILENAME = "setup.token";
const TOKEN_BYTES = 32;

function tokenPath(): string {
  return path.join(DATA_DIR, TOKEN_FILENAME);
}

/**
 * Generate (or rehydrate) the one-shot setup token. Idempotent: if the token
 * file already exists, leaves it in place. Logs the token prominently so the
 * operator can copy it from console / docker logs / pm2 logs.
 */
export function ensureSetupToken(): string | null {
  try {
    const filePath = tokenPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf8").trim();
      if (existing) {
        info("[SetupToken] Existing setup token detected at", filePath);
        info("[SetupToken] Token (paste into the OOBE wizard):", existing);
        return existing;
      }
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
    fs.writeFileSync(filePath, token + "\n", { encoding: "utf8", mode: 0o600 });
    // Some filesystems ignore the mode in writeFileSync — chmod explicitly.
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort */
    }
    info("============================================================");
    info("[SetupToken] One-shot setup token generated.");
    info("[SetupToken] Path :", filePath);
    info("[SetupToken] Token:", token);
    info("[SetupToken] Paste this into the OOBE wizard to finish setup.");
    info("============================================================");
    return token;
  } catch (err) {
    error("[SetupToken] Failed to generate setup token:", err);
    return null;
  }
}

/**
 * Returns true when the on-disk setup token file exists.
 */
export function setupTokenExists(): boolean {
  try {
    return fs.existsSync(tokenPath());
  } catch {
    return false;
  }
}

/**
 * Verify a candidate token against the on-disk setup token. Uses
 * timing-safe comparison. Returns false when the file is missing, the
 * candidate is empty, or the lengths/values disagree.
 */
export function verifySetupToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    const filePath = tokenPath();
    if (!fs.existsSync(filePath)) return false;
    const expected = fs.readFileSync(filePath, "utf8").trim();
    if (!expected) return false;
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(candidate, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    warn("[SetupToken] Verification error:", err);
    return false;
  }
}

/**
 * Delete the on-disk setup token. Called after a successful /initialize so
 * the token cannot be replayed.
 */
export function consumeSetupToken(): void {
  try {
    const filePath = tokenPath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      info("[SetupToken] Consumed and removed:", filePath);
    }
  } catch (err) {
    warn("[SetupToken] Failed to remove token file:", err);
  }
}
