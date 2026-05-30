/**
 * Auth (extended) — login & change-password sub-router.
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

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password, mfaToken } = req.body;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const ipString = Array.isArray(ipAddress) ? ipAddress[0] : ipAddress;

    if (!email || !password) {
      return res.status(400).json({ error: 'Missing email or password' });
    }

    // Find user by email
    const user = getUserByEmail(email);

    if (!user) {
      await trackFailedLogin(email, ipString);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if user is active
    if (!user.is_active) {
      await trackFailedLogin(email, ipString);
      return res.status(401).json({ error: 'Account is disabled' });
    }

    // Verify password
    if (!verifyPassword(user, password)) {
      await trackFailedLogin(email, ipString);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if MFA is enabled
    if (user.mfa_enabled) {
      if (!mfaToken) {
        // Store user in temporary challenge for MFA verification
        const sessionId = crypto.randomUUID();
        challenges.set(`mfa-login-${sessionId}`, {
          challenge: sessionId,
          userId: user.id,
          user: user,
          expires: Date.now() + 5 * 60 * 1000, // 5 minutes
        });
        
        return res.status(401).json({ 
          requiresMFA: true,
          sessionId,
          message: 'MFA verification required'
        });
      }

      // Verify MFA token
      if (!user.totp_secret || !verifyTOTP(user.totp_secret, mfaToken)) {
        // Try backup code
        if (!verifyBackupCode(user, mfaToken)) {
          await trackFailedLogin(email, ipString);
          return res.status(401).json({ error: 'Invalid MFA token' });
        }
      }
    }

    // Login successful - create session
    (req.session as any).userId = user.id;
    (req.session as any).user = {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      role: user.role,
      mfa_enabled: user.mfa_enabled,
      passkey_enabled: user.passkeys && user.passkeys.length > 0,
      auth_methods: user.auth_methods,
    };

    info('[Login] Creating session for user:', {
      userId: user.id,
      email: user.email,
      role: user.role,
      mfa_enabled: user.mfa_enabled,
      sessionID: req.sessionID,
    });

    // Save session explicitly
    req.session.save((err) => {
      if (err) {
        error('[Login] Session save error:', err);
        return res.status(500).json({ error: 'Session creation failed' });
      }

      info('[Login] ✅ Session saved successfully:', {
        sessionID: req.sessionID,
        userId: (req.session as any).userId,
      });

      res.json({
        success: true,
        user: {
          id: user!.id,
          email: user!.email,
          name: user!.name,
          picture: user!.picture,
        },
      });
    });
  } catch (err) {
    error('[AuthExtended] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * Invite new user (admin only)
 * Sends invitation email, user must complete signup
 */

router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    if (!verifyPassword(user, currentPassword)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Update password
    updatePassword(userId, newPassword);

    // Send push notification to all admins
    if (user) {
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
    }

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] Password change error:', err);
    res.status(500).json({ error: 'Password change failed' });
  }
});

/**
 * Enable MFA - Step 1: Generate TOTP secret and QR code
 */

export default router;
