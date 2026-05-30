/**
 * Auth (extended) — admin user management sub-router.
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

router.post('/users/:userId/reset-mfa', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.mfa_enabled) {
      return res.status(400).json({ error: 'User does not have MFA enabled' });
    }

    // Disable MFA
    disableMFA(userId);

    info(`[Admin] MFA disabled for user ${user.email} (ID: ${userId})`);

    // Send push notification to all admins
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

    res.json({
      success: true,
      message: 'MFA has been disabled',
    });
  } catch (err) {
    error('[AuthExtended] Reset MFA error:', err);
    res.status(500).json({ error: 'Failed to reset MFA' });
  }
});

// Send password reset email (admin-initiated)
router.post('/users/:userId/send-password-reset', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const user = getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user uses password authentication
    const authMethods = user.auth_methods || [];
    if (!authMethods.includes('credentials')) {
      return res.status(400).json({ error: 'User does not use password authentication' });
    }

    // Generate password reset token
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
      error('[Admin] Failed to send password reset email');
      return res.status(500).json({ 
        error: 'Failed to send password reset email. Please check your SMTP configuration.'
      });
    }

    // Only save reset token if email was sent successfully
    setPasswordResetToken(userId, resetToken, expiresAt.toISOString());

    info(`[Admin] Password reset email sent to ${user.email} (ID: ${userId})`);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.adminPasswordResetTitle',
      'notifications.backend.adminPasswordResetBody',
      'admin-password-reset',
      'adminPasswordReset',
      {
        adminName: (req.user as any).name || (req.user as any).email,
        targetUserEmail: user.email
      }
    ).catch(err => error('[AuthExtended] Failed to send admin password reset notification:', err));

    res.json({
      success: true,
      emailSent,
      message: 'Password reset email has been sent',
    });
  } catch (err) {
    error('[AuthExtended] Send password reset error:', err);
    res.status(500).json({ error: 'Failed to send password reset email' });
  }
});

/**
 * Change password
 */

router.get('/users', requireAdmin, (req: Request, res: Response) => {
  try {
    const users = getAllUsers();

    // Remove sensitive data and add computed fields
    const sanitizedUsers = users.map((user: User) => {
      // Determine display status based on user state
      let displayStatus = null;

      if (user.status === 'invited') {
        // Check if invite has expired
        if (user.invite_expires_at) {
          const expiresAt = new Date(user.invite_expires_at);
          if (expiresAt < new Date()) {
            displayStatus = 'invite_expired';
          } else {
            displayStatus = 'invited';
          }
        } else {
          displayStatus = 'invited';
        }
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        auth_methods: user.auth_methods,
        mfa_enabled: user.mfa_enabled,
        passkey_count: user.passkeys?.length || 0,
        is_active: user.is_active,
        status: displayStatus, // Only show status if invited or expired
        // invite_token is intentionally NOT returned here — see SECURITY note above.
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      };
    });

    res.json({ users: sanitizedUsers });
  } catch (err) {
    error('[AuthExtended] List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

/**
 * Fetch the outstanding invitation link for a single invited user (admin only).
 *
 * Separated from GET /users so that the raw `invite_token` is only disclosed
 * in response to an explicit admin action (clicking "Copy Invite Link"),
 * rather than being baked into every list response. Admins must request tokens
 * one at a time, and only admins can.
 */
router.get('/users/:userId/invite-link', requireAdmin, (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.status !== 'invited' || !user.invite_token) {
      return res.status(400).json({ error: 'User does not have an outstanding invitation' });
    }

    let expired = false;
    if (user.invite_expires_at) {
      const expiresAt = new Date(user.invite_expires_at);
      if (expiresAt < new Date()) {
        expired = true;
      }
    }

    return res.json({
      inviteUrl: generateInvitationUrl(user.invite_token),
      inviteToken: user.invite_token,
      expired,
      expiresAt: user.invite_expires_at || null,
    });
  } catch (err) {
    error('[AuthExtended] Get invite link error:', err);
    return res.status(500).json({ error: 'Failed to get invite link' });
  }
});

/**
 * Delete user (admin only - can't delete yourself)
 */
router.delete('/users/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const currentUserId = getUserIdFromRequest(req);
    
    if (!currentUserId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    // Prevent deleting yourself
    if (userId === currentUserId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    
    // Get target user
    const targetUser = getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Delete user from database
    const success = deleteUser(userId);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete user' });
    }

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userDeletedTitle',
      'notifications.backend.userDeletedBody',
      'user-deleted',
      'userDeleted',
      {
        userEmail: targetUser.email,
        deletedBy: (req.user as any).name || (req.user as any).email
      }
    ).catch(err => error('[AuthExtended] Failed to send user deletion notification:', err));
    
    // Invalidate all sessions for this user
    const sessionStore = req.sessionStore;
    if (sessionStore && sessionStore.all) {
      sessionStore.all((err: Error | null, sessions: any) => {
        if (err) {
          error('[AuthExtended] Failed to getting sessions:', err);
          return;
        }
        
        // Destroy sessions belonging to the deleted user.
        // Sessions can be created by three auth flows, each storing the user
        // identifier in a different shape:
        //   - credential login (/login):           session.userId = <db id>
        //   - passkey auth-verify:                  session.userId = <db id>
        //                                           session.user.id  = <db id>
        //   - Passport / Google OAuth:             session.passport.user = { id: googleProfileId, email, ... }
        // Match all of them. Numeric ids are normalized via Number() in case a
        // session store serialized ids as strings; OAuth sessions are matched
        // by email since session.passport.user.id is the Google profile id,
        // not the database user id.
        if (sessions) {
          const targetId = Number(userId);
          const targetEmail = targetUser.email ? targetUser.email.toLowerCase() : null;
          Object.keys(sessions).forEach((sid) => {
            const session = sessions[sid];
            if (!session) return;

            const credentialUserId = session.userId !== undefined ? Number(session.userId) : NaN;
            const sessionUserObjId = session.user?.id !== undefined ? Number(session.user.id) : NaN;
            const passportUser = session.passport?.user;
            const passportUserId =
              passportUser && typeof passportUser === 'object' && passportUser.id !== undefined
                ? Number(passportUser.id)
                : typeof passportUser === 'number'
                  ? passportUser
                  : NaN;
            const passportEmail =
              passportUser && typeof passportUser === 'object' && typeof passportUser.email === 'string'
                ? passportUser.email.toLowerCase()
                : null;
            const sessionUserEmail =
              typeof session.user?.email === 'string' ? session.user.email.toLowerCase() : null;

            const belongsToDeletedUser =
              credentialUserId === targetId ||
              sessionUserObjId === targetId ||
              passportUserId === targetId ||
              (targetEmail !== null &&
                (passportEmail === targetEmail || sessionUserEmail === targetEmail));

            if (belongsToDeletedUser) {
              sessionStore.destroy(sid, (destroyErr) => {
                if (destroyErr) {
                  error(`Failed to destroy session ${sid}:`, destroyErr);
                } else {
                  info(`[Session] Destroyed session ${sid} for deleted user ${userId}`);
                }
              });
            }
          });
        }
      });
    }
    
    info(`[User Management] User ${targetUser.email} (ID: ${userId}) deleted by user ID: ${currentUserId}`);
    
    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (err) {
    error('[AuthExtended] Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * Update user role (Admin only)
 */
router.patch('/users/:userId/role', requireAdmin, async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.userId);
    const { role } = req.body;
    const currentUserId = getUserIdFromRequest(req);
    
    if (!currentUserId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    // Validate role
    const validRoles = ['admin', 'manager', 'viewer'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, manager, or viewer' });
    }
    
    // Get target user
    const targetUser = getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Prevent changing your own role
    if (userId === currentUserId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    
    // Update user role
    updateUser(userId, { role });
    
    info(`[User Management] User ${targetUser.email} (ID: ${userId}) role changed to ${role} by user ID: ${currentUserId}`);

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.userRoleChangedTitle',
      'notifications.backend.userRoleChangedBody',
      'user-role-changed',
      'userRoleChanged',
      {
        userName: targetUser.name || targetUser.email,
        userEmail: targetUser.email,
        oldRole: targetUser.role,
        newRole: role
      }
    ).catch(err => error('[AuthExtended] Failed to send role change notification:', err));
    
    res.json({
      success: true,
      message: 'User role updated successfully',
      role,
    });
  } catch (err) {
    error('[AuthExtended] Update user role error:', err);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

/**
 * Get user's enabled auth methods
 */
router.get('/user/methods', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      authMethods: user.auth_methods,
      mfaEnabled: user.mfa_enabled,
      passkeyCount: user.passkeys?.length || 0,
      hasPassword: !!user.password_hash,
      hasGoogleLinked: !!user.google_id,
    });
  } catch (err) {
    error('[AuthExtended] Auth methods error:', err);
    res.status(500).json({ error: 'Failed to get auth methods' });
  }
});


export default router;
