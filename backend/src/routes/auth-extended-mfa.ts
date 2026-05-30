/**
 * Auth (extended) — MFA setup sub-router.
 * Extracted from auth-extended.ts (ticket #1506).
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
import {
  passkeyAuthOptionsLimiter,
  notifyAllAdmins,
  getUserIdFromRequest,
  challenges,
  verifyReauth,
  getLocationFromIP,
  trackFailedLogin,
} from "./auth-extended-shared.js";

const router = Router();

router.post('/mfa/setup', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.mfa_enabled) {
      return res.status(400).json({ error: 'MFA is already enabled' });
    }

    // Generate TOTP secret
    const { secret, otpauth_url } = generateTOTPSecret(user.email);
    
    // Generate QR code
    const qrCode = await generateQRCode(otpauth_url);
    
    // Generate backup codes
    const backupCodes = generateBackupCodes();

    // Store secret temporarily (not saved to DB until verification)
    const setupToken = crypto.randomBytes(32).toString('hex');
    challenges.set(`mfa-setup-${setupToken}`, {
      challenge: secret,
      userId,
      expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    res.json({
      setupToken,
      qrCode,
      secret,
      backupCodes,
    });
  } catch (err) {
    error('[AuthExtended] MFA setup error:', err);
    res.status(500).json({ error: 'MFA setup failed' });
  }
});

/**
 * Enable MFA - Step 2: Verify TOTP token and enable MFA
 */
router.post('/mfa/verify-setup', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const { setupToken, token, backupCodes } = req.body;

    if (!setupToken || !token || !backupCodes) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get temporary secret
    const setup = challenges.get(`mfa-setup-${setupToken}`);
    if (!setup || setup.userId !== userId || setup.expires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired setup token' });
    }

    // Verify TOTP token
    if (!verifyTOTP(setup.challenge, token)) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Enable MFA
    enableMFA(userId, setup.challenge, backupCodes);
    challenges.delete(`mfa-setup-${setupToken}`);

    // Update session to reflect MFA enabled
    if ((req.session as any)?.user) {
      (req.session as any).user.mfa_enabled = true;
    }

    // Get user info for notification
    const user = getUserById(userId);

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.userSetupMFATitle',
        'notifications.backend.userSetupMFABody',
        'user-setup-mfa',
        'mfaEnabled',
        {
          userName: user.name || user.email,
          userEmail: user.email
        }
      ).catch(err => error('[AuthExtended] Failed to send MFA setup notification:', err));
    }

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] MFA verification error:', err);
    res.status(500).json({ error: 'MFA verification failed' });
  }
});

/**
 * Disable MFA
 */
router.post('/mfa/disable', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Require a fresh re-auth proof (password OR passkey assertion). Without
    // this, users who authenticate via Google OAuth or passkey only (no
    // `password_hash`) could disable MFA with no second-factor check.
    const reauth = await verifyReauth(user, req.body);
    if (!reauth.ok) {
      return res.status(reauth.status).json({ error: reauth.reason });
    }

    disableMFA(userId);

    // Update session to reflect MFA disabled
    if ((req.session as any)?.user) {
      (req.session as any).user.mfa_enabled = false;
    }

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.mfaDisabledTitle',
        'notifications.backend.mfaDisabledBody',
        'mfa-disabled',
        'mfaDisabled',
        {
          userName: user.name || user.email,
          userEmail: user.email
        }
      ).catch(err => error('[AuthExtended] Failed to send MFA disable notification:', err));
    }

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] MFA disable error:', err);
    res.status(500).json({ error: 'Failed to disable MFA' });
  }
});

/**
 * Get new backup codes
 */
router.post('/mfa/backup-codes', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = getUserById(userId);
    if (!user || !user.mfa_enabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    // Require a fresh re-auth proof (password OR passkey assertion). Without
    // this, users without a `password_hash` could mint new backup codes from a
    // hijacked Google session and defeat the second factor.
    const reauth = await verifyReauth(user, req.body);
    if (!reauth.ok) {
      return res.status(reauth.status).json({ error: reauth.reason });
    }

    // Generate new backup codes
    const backupCodes = generateBackupCodes();
    enableMFA(userId, user.totp_secret!, backupCodes);

    res.json({ backupCodes });
  } catch (err) {
    error('[AuthExtended] Backup codes error:', err);
    res.status(500).json({ error: 'Failed to generate backup codes' });
  }
});

/**
 * Start passkey registration
 */

export default router;
