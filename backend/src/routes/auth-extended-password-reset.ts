/**
 * Auth (extended) — self-service password reset sub-router.
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

router.post('/password-reset/request', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = getUserByEmail(email);

    // Don't reveal if user exists or not (security best practice)
    if (!user) {
      return res.json({ success: true, message: 'If the email exists, a password reset link has been sent' });
    }

    // Only allow password reset if user doesn't have MFA enabled
    if (user.mfa_enabled) {
      return res.status(400).json({ 
        error: 'Password reset not available for accounts with MFA enabled. Contact an administrator for assistance.' 
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry to 1 hour from now
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Reload config from disk to get latest language setting
    reloadConfig();
    const currentConfig = getCurrentConfig();
    const siteLanguage = (currentConfig as any).branding?.language || 'en';

    // Try to send password reset email FIRST
    const emailSent = await sendPasswordResetEmail(user.email, resetToken, user.name, siteLanguage);

    if (!emailSent) {
      error('[Password Reset] Failed to send email');
      return res.status(500).json({ error: 'Failed to send password reset email. Please check your SMTP configuration.' });
    }

    // Only save reset token if email was sent successfully
    setPasswordResetToken(user.id, resetToken, expiresAt.toISOString());

    res.json({ 
      success: true, 
      message: 'If the email exists, a password reset link has been sent' 
    });
  } catch (err) {
    error('[AuthExtended] Password reset request error:', err);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

/**
 * Validate password reset token
 */
router.get('/password-reset/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const user = getUserByPasswordResetToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid password reset link' });
    }

    // Check if reset token has expired
    if (user.password_reset_expires_at) {
      const expiresAt = new Date(user.password_reset_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Password reset link has expired' });
      }
    }

    res.json({
      valid: true,
      email: user.email,
    });
  } catch (err) {
    error('[AuthExtended] Validate password reset error:', err);
    res.status(500).json({ error: 'Failed to validate password reset link' });
  }
});

/**
 * Complete password reset
 */
router.post('/password-reset/:token/complete', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = getUserByPasswordResetToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid password reset link' });
    }

    // Check if reset token has expired
    if (user.password_reset_expires_at) {
      const expiresAt = new Date(user.password_reset_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Password reset link has expired' });
      }
    }

    // Update password
    updatePassword(user.id, password);
    
    // Clear reset token
    clearPasswordResetToken(user.id);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.passwordChangedTitle',
      'notifications.backend.passwordChangedBody',
      'password-changed',
      'passwordChanged',
      {
        userName: user.name || user.email,
        userEmail: user.email
      }
    ).catch(err => error('[AuthExtended] Failed to send password change notification:', err));

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] Complete password reset error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

/**
 * Admin: Reset user's MFA (disable MFA only)
 */

export default router;
