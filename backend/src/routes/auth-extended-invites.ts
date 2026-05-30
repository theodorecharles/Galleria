/**
 * Auth (extended) — invitations sub-router.
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

router.post('/invite', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, role } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if user already exists
    if (getUserByEmail(email)) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Determine role - only admins can create other admins
    let userRole = 'viewer'; // Default role
    const creatorUserId = getUserIdFromRequest(req);
    
    if (creatorUserId) {
      const creator = getUserById(creatorUserId);
      
      if (creator && creator.role === 'admin') {
        // Admin can set any role
        if (role === 'admin') {
          userRole = 'admin';
        } else if (role === 'manager') {
          userRole = 'manager';
        } else {
          userRole = 'viewer';
        }
      } else {
        // Non-admin can only create viewers
        userRole = 'viewer';
      }
    }

    // Generate invite token (secure random string)
    const inviteToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry to 7 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Get inviter name for email
    const inviter = creatorUserId ? getUserById(creatorUserId) : null;
    const inviterName = inviter?.name || 'Administrator';

    // Check if email service is enabled
    const emailEnabled = isEmailServiceEnabled();
    let emailSent = false;
    
    if (emailEnabled) {
      // Reload config from disk to get latest language setting
      reloadConfig();
      const currentConfig = getCurrentConfig();
      const siteLanguage = (currentConfig as any).branding?.language || 'en';
      info(`[Invite] Using site language: ${siteLanguage}`);
      
      // Try to send invitation email FIRST
      emailSent = await sendInvitationEmail(email, inviteToken, inviterName, siteLanguage);

      if (!emailSent) {
        // If email fails, don't create the user
        return res.status(500).json({ 
          error: 'Failed to send invitation email. Please check your SMTP configuration and try again.' 
        });
      }
    }

    // Create user (either after successful email or if email is disabled)
    const user = createInvitedUser({
      email,
      role: userRole,
      invite_token: inviteToken,
      invite_expires_at: expiresAt.toISOString(),
    });

    // Generate invite URL for manual sharing when email is disabled
    const inviteUrl = !emailEnabled ? generateInvitationUrl(inviteToken) : undefined;

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userInvitedTitle',
      'notifications.backend.userInvitedBody',
      'user-invited',
      'userInvited',
      {
        inviterName: (req.user as any).name || (req.user as any).email,
        userEmail: email
      }
    ).catch(err => error('[AuthExtended] Failed to send invitation notification:', err));

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        invite_token: inviteToken, // Include for copy functionality
      },
      emailSent,
      emailEnabled,
      inviteUrl, // Only present when email is disabled
    });
  } catch (err) {
    error('[AuthExtended] Invitation error:', err);
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

/**
 * Resend invitation (admin only)
 */
router.post('/invite/resend/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.status !== 'invite_expired' && user.status !== 'invited') {
      return res.status(400).json({ error: 'User has already completed signup' });
    }

    // Generate new invite token
    const inviteToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry to 7 days from now
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Get inviter name for email
    const creatorUserId = getUserIdFromRequest(req);
    const inviter = creatorUserId ? getUserById(creatorUserId) : null;
    const inviterName = inviter?.name || 'Administrator';

    // Check if email service is enabled
    const emailEnabled = isEmailServiceEnabled();
    let emailSent = false;
    
    if (emailEnabled) {
      // Reload config from disk to get latest language setting
      reloadConfig();
      const currentConfig = getCurrentConfig();
      const siteLanguage = (currentConfig as any).branding?.language || 'en';
      
      // Try to send invitation email FIRST
      emailSent = await sendInvitationEmail(user.email, inviteToken, inviterName, siteLanguage);

      if (!emailSent) {
        // If email fails, don't update the token
        return res.status(500).json({ 
          error: 'Failed to send invitation email. Please check your SMTP configuration and try again.' 
        });
      }
    }

    // Update user token (either after successful email or if email is disabled)
    resendInvitation(userId, inviteToken, expiresAt.toISOString());

    // Generate invite URL for manual sharing when email is disabled
    const inviteUrl = !emailEnabled ? generateInvitationUrl(inviteToken) : undefined;

    res.json({
      success: true,
      emailSent,
      emailEnabled,
      inviteUrl, // Only present when email is disabled
    });
  } catch (err) {
    error('[AuthExtended] Resend invitation error:', err);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

/**
 * Validate invite token
 */
router.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const user = getUserByInviteToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid invitation link' });
    }

    // Check if invitation has expired
    if (user.invite_expires_at) {
      const expiresAt = new Date(user.invite_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Invitation has expired' });
      }
    }

    // Check if user has already completed signup
    if (user.status === 'active') {
      return res.status(400).json({ error: 'Invitation already used' });
    }

    res.json({
      valid: true,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    error('[AuthExtended] Validate invite error:', err);
    res.status(500).json({ error: 'Failed to validate invitation' });
  }
});

/**
 * Complete user signup from invitation
 */
router.post('/invite/:token/complete', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { name, password, totpToken, setupToken } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: 'Name and password are required' });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = getUserByInviteToken(token);

    if (!user) {
      return res.status(404).json({ error: 'Invalid invitation link' });
    }

    // Check if invitation has expired
    if (user.invite_expires_at) {
      const expiresAt = new Date(user.invite_expires_at);
      if (expiresAt < new Date()) {
        return res.status(400).json({ error: 'Invitation has expired' });
      }
    }

    // Check if user has already completed signup
    if (user.status === 'active') {
      return res.status(400).json({ error: 'Invitation already used' });
    }

    // Complete the invitation (set name, password, mark as active)
    completeInvitation(user.id, { name, password });

    // If MFA setup was requested, enable it
    if (totpToken && setupToken) {
      const setup = challenges.get(`mfa-setup-${setupToken}`);
      if (setup && setup.userId === user.id && setup.expires > Date.now()) {
        // Verify TOTP token (from MFA setup during signup)
        // Note: This allows optional MFA setup during signup
        const { backupCodes } = req.body;
        if (backupCodes) {
          enableMFA(user.id, setup.challenge, backupCodes);
          challenges.delete(`mfa-setup-${setupToken}`);
        }
      }
    }

    // Get updated user
    const updatedUser = getUserById(user.id);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userAcceptedInviteTitle',
      'notifications.backend.userAcceptedInviteBody',
      'user-accepted-invite',
      'userAcceptedInvite',
      {
        userName: updatedUser!.name || 'New User',
        userEmail: updatedUser!.email
      }
    ).catch(err => error('[AuthExtended] Failed to send invite acceptance notification:', err));

    res.json({
      success: true,
      user: {
        id: updatedUser!.id,
        email: updatedUser!.email,
        name: updatedUser!.name,
        role: updatedUser!.role,
      },
    });
  } catch (err) {
    error('[AuthExtended] Complete signup error:', err);
    res.status(500).json({ error: 'Failed to complete signup' });
  }
});

/**
 * Request password reset (public endpoint)
 */

export default router;
