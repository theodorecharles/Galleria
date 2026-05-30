/**
 * Auth (extended) — shared rate limiter, helpers and in-memory challenge store.
 * Extracted from auth-extended.ts (ticket #1506) without behaviour changes.
 * NOTE: the challenge Map and rate limiter are module singletons shared across
 * all auth-extended sub-routers via this module.
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireAdmin } from '../auth/middleware.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import {
  getUserById,
  updateUser,
  updatePassword,
  enableMFA,
  disableMFA,
  addPasskey,
  removePasskey,
  updatePasskeyCounter,
  getPasskeyByCredentialId,
  verifyPassword,
  verifyBackupCode,
  createUser,
  getUserByEmail,
  getAllUsers,
  deleteUser,
  createInvitedUser,
  getUserByInviteToken,
  completeInvitation,
  setPasswordResetToken,
  getUserByPasswordResetToken,
  clearPasswordResetToken,
  resendInvitation,
  type User,
} from '../database-users.js';
import {
  generateTOTPSecret,
  generateQRCode,
  verifyTOTP,
  generateBackupCodes,
} from '../auth/mfa.js';
import {
  generatePasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  generatePasskeyAuthenticationOptions,
  verifyPasskeyAuthentication,
} from '../auth/passkeys.js';
import crypto from 'crypto';
import { sendInvitationEmail, sendPasswordResetEmail, isEmailServiceEnabled, generateInvitationUrl } from '../email.js';
import { getCurrentConfig, reloadConfig } from '../config.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';

export const passkeyAuthOptionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many passkey authentication attempts from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Helper to send push notification to all admin users
 */
export async function notifyAllAdmins(title: string, body: string, tag: string, notificationType?: any, variables?: Record<string, any>): Promise<void> {
  try {
    const admins = getAllUsers().filter(u => u.role === 'admin');
    
    for (const admin of admins) {
      const translatedTitle = await translateNotification(title, variables);
      const translatedBody = await translateNotification(body, variables);
      
      await sendNotificationToUser(admin.id, {
        title: translatedTitle,
        body: translatedBody,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        requireInteraction: false
      }, notificationType);
    }
  } catch (err) {
    error('[AuthExtended] Failed to send admin notification:', err);
  }
}

/**
 * Helper to get user ID from either Passport session or credential session
 */
export function getUserIdFromRequest(req: Request): number | null {
  // Check credential session first (has database ID directly)
  if ((req.session as any)?.userId) {
    return parseInt((req.session as any).userId);
  }
  
  // Check Passport session (Google OAuth) - need to look up by email
  if (req.user && (req.user as any).email) {
    const email = (req.user as any).email;
    const user = getUserByEmail(email);
    return user ? user.id : null;
  }
  
  return null;
}

// Store temporary challenges in memory (in production, use Redis or session store)
export const challenges = new Map<string, { challenge: string; userId?: number; user?: User; expires: number }>();

/**
 * Verify a sensitive-action re-authentication proof.
 *
 * Accepts either a valid password (when the user has a `password_hash`), a
 * current TOTP token, or a fresh passkey assertion bound to the user's own
 * credential. This closes a
 * bypass where users without a password (Google OAuth / passkey-only) could
 * pass through `if (user.password_hash && !verifyPassword(...))` because the
 * `&&` short-circuits to `false` when `password_hash` is empty, allowing MFA
 * to be disabled or backup codes to be regenerated with no proof.
 */
export async function verifyReauth(
  user: User,
  body: any
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const {
    password,
    passkeyCredential,
    passkeySessionId,
    totpToken,
    mfaToken,
    token,
  } = body || {};
  const submittedTOTP = totpToken || mfaToken || token;

  // Path 1: passkey assertion (preferred when supplied — works for every user
  // with at least one registered passkey, including OAuth-only accounts).
  if (passkeyCredential && passkeySessionId) {
    const stored = challenges.get(`passkey-auth-${passkeySessionId}`);
    if (!stored || stored.expires < Date.now()) {
      return { ok: false, status: 400, reason: 'Invalid or expired challenge' };
    }

    const result = getPasskeyByCredentialId(passkeyCredential.id);
    // The credential MUST belong to the currently authenticated user — never
    // accept a passkey owned by someone else as proof of re-authentication.
    if (!result || result.user.id !== user.id) {
      return { ok: false, status: 401, reason: 'Passkey verification failed' };
    }

    try {
      const verification = await verifyPasskeyAuthentication(
        passkeyCredential,
        stored.challenge,
        result.passkey.credentialPublicKey,
        result.passkey.counter
      );
      if (!verification.verified) {
        return { ok: false, status: 401, reason: 'Passkey verification failed' };
      }
      // Consume the challenge and bump the credential counter so the assertion
      // cannot be replayed. The counter update is a compare-and-swap against
      // `result.passkey.counter`; if a concurrent assertion already advanced
      // the counter we MUST reject this one as a replay rather than accepting
      // the auth and silently failing to advance the counter.
      const counterAdvanced = updatePasskeyCounter(
        user.id,
        result.passkey.id,
        result.passkey.counter,
        verification.authenticationInfo.newCounter
      );
      if (!counterAdvanced) {
        warn('[AuthExtended] Re-auth passkey counter CAS failed — possible replay', {
          userId: user.id,
          passkeyId: result.passkey.id,
        });
        return { ok: false, status: 401, reason: 'Passkey verification failed' };
      }
      challenges.delete(`passkey-auth-${passkeySessionId}`);
      return { ok: true };
    } catch (err) {
      error('[AuthExtended] Re-auth passkey verification error:', err);
      return { ok: false, status: 401, reason: 'Passkey verification failed' };
    }
  }

  // Path 2: TOTP proof for MFA-enabled accounts, including OAuth-only users
  // that cannot satisfy the password branch.
  if (submittedTOTP && user.totp_secret) {
    if (verifyTOTP(user.totp_secret, submittedTOTP)) {
      return { ok: true };
    }
  }

  // Path 3: password (only valid when the account actually has one).
  if (user.password_hash) {
    if (!password || !verifyPassword(user, password)) {
      return { ok: false, status: 401, reason: 'Invalid password' };
    }
    return { ok: true };
  }

  // No password on the account and no passkey assertion — reject.
  return {
    ok: false,
    status: 401,
    reason: 'Re-authentication required. Provide a verification code or passkey assertion to continue.',
  };
}

// Clean up expired challenges every 5 minutes
setInterval(() => {
  const now = Date.now();
  
  // Clean challenges
  for (const [key, value] of challenges.entries()) {
    if (value.expires < now) {
      challenges.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Get location from IP address using GeoIP
 */
export async function getLocationFromIP(ip: string): Promise<string> {
  try {
    // Check for local/private IPs that won't have GeoIP data
    const isLocalIP = 
      ip === '::1' || 
      ip === '127.0.0.1' || 
      ip.startsWith('::ffff:127.') || 
      ip.startsWith('192.168.') || 
      ip.startsWith('10.') || 
      (ip.startsWith('172.') && parseInt(ip.split('.')[1]) >= 16 && parseInt(ip.split('.')[1]) <= 31) ||
      ip === 'unknown';
    
    if (isLocalIP) {
      return 'Local Network';
    }
    
    // Try to import maxmind module
    const maxmind = await import('@maxmind/geoip2-node');
    const path = await import('path');
    const fs = await import('fs');
    
    // Use DATA_DIR from config instead of relative path resolution
    const { DATA_DIR } = await import('../config.js');
    const dbPath = path.join(DATA_DIR, 'GeoLite2-City.mmdb');
    
    // Check if database exists
    if (!fs.existsSync(dbPath)) {
      info('[Auth] GeoIP database not found at:', dbPath);
      return 'Unknown';
    }
    
    const reader = await maxmind.Reader.open(dbPath);
    const response = reader.city(ip);
    
    if (response && response.city && response.country) {
      return `${response.city.names?.en || 'Unknown City'}, ${response.country.names?.en || 'Unknown Country'}`;
    } else if (response && response.country) {
      return response.country.names?.en || 'Unknown';
    }
    
    return 'Unknown';
  } catch (err) {
    // GeoIP is optional - don't fail if not available
    verbose('[Auth] GeoIP lookup failed (this is OK if not configured):', err);
    return 'Unknown';
  }
}

/**
 * Track failed login attempt and send notification on EVERY attempt
 */
export async function trackFailedLogin(email: string, ipAddress: string): Promise<void> {
  try {
    // Get location from IP
    const location = await getLocationFromIP(ipAddress);
    
    await notifyAllAdmins(
      'notifications.backend.failedLoginAttemptsTitle',
      'notifications.backend.failedLoginAttemptsBody',
      'failed-login-attempts',
      'failedLoginAttempts',
      {
        userEmail: email,
        ipAddress,
        location: location || 'Unknown'
      }
    );
    warn(`[Auth] Failed login attempt for ${email} from ${ipAddress}${location ? ` (${location})` : ''}`);
  } catch (err) {
    error('[Auth] Failed to send failed login notification:', err);
  }
}

/**
 * Login with email/password (with optional MFA)
 */
