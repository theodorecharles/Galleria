/**
 * Auth (extended) — passkeys sub-router.
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

router.post('/passkey/register-options', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const options = await generatePasskeyRegistrationOptions(
      user.id,
      user.email,
      user.name || user.email,
      user.passkeys || []
    );

    info('[Passkey Registration] Generated options:', {
      challengeLength: options.challenge.length,
      challenge: options.challenge,
      userId: options.user.id,
      userIdLength: options.user.id.length,
      userName: options.user.name,
      rpId: options.rp.id,
      rpName: options.rp.name,
      excludeCredentialsCount: options.excludeCredentials?.length || 0,
    });

    // Store challenge
    const challengeKey = `passkey-reg-${userId}`;
    challenges.set(challengeKey, {
      challenge: options.challenge,
      userId,
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    res.json(options);
  } catch (err) {
    error('[AuthExtended] Passkey registration options error:', err);
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

/**
 * Verify passkey registration
 */
router.post('/passkey/register-verify', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const { credential, name } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Missing credential' });
    }

    // Get stored challenge
    const challengeKey = `passkey-reg-${userId}`;
    const stored = challenges.get(challengeKey);
    
    if (!stored || stored.userId !== userId || stored.expires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }

    // Verify registration
    const verification = await verifyPasskeyRegistration(credential, stored.challenge);

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    // Save passkey
    // Convert Uint8Array to base64url (URL-safe base64 without padding)
    const credentialIDBase64 = Buffer.from(verification.registrationInfo.credential.id)
      .toString('base64url');
    
    const credentialPublicKeyBase64 = Buffer.from(verification.registrationInfo.credential.publicKey)
      .toString('base64url');
    
    const passkey = {
      id: crypto.randomUUID(),
      name: name || `Passkey ${Date.now()}`,
      credentialID: credentialIDBase64,
      credentialPublicKey: credentialPublicKeyBase64,
      counter: verification.registrationInfo.credential.counter,
      transports: credential.response.transports,
    };

    addPasskey(userId, passkey);
    challenges.delete(challengeKey);

    // Get user info for notification
    const user = getUserById(userId);

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.userCreatedPasskeyTitle',
        'notifications.backend.userCreatedPasskeyBody',
        'user-created-passkey',
        'passkeyCreated',
        {
          userName: user.name || user.email,
          passkeyName: passkey.name
        }
      ).catch(err => error('[AuthExtended] Failed to send passkey creation notification:', err));
    }

    res.json({ success: true, passkey: { id: passkey.id, name: passkey.name } });
  } catch (err: any) {
    error('[AuthExtended] Passkey registration verification error:', err);
    error('[AuthExtended] Error stack:', err.stack);
    error('[AuthExtended] Error message:', err.message);
    res.status(500).json({ error: err.message || 'Passkey registration failed' });
  }
});

/**
 * Get authentication options for passkey login
 */
router.post('/passkey/auth-options', passkeyAuthOptionsLimiter, async (req: Request, res: Response) => {
  try {
    const options = await generatePasskeyAuthenticationOptions();

    // Store challenge
    const sessionId = crypto.randomUUID();
    challenges.set(`passkey-auth-${sessionId}`, {
      challenge: options.challenge,
      expires: Date.now() + 5 * 60 * 1000,
    });

    res.json({ ...options, sessionId });
  } catch (err) {
    error('[AuthExtended] Passkey auth options error:', err);
    res.status(500).json({ error: 'Failed to generate auth options' });
  }
});

/**
 * Verify passkey authentication
 */
router.post('/passkey/auth-verify', async (req: Request, res: Response) => {
  try {
    const { credential, sessionId } = req.body;

    if (!credential || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get stored challenge
    const stored = challenges.get(`passkey-auth-${sessionId}`);
    if (!stored || stored.expires < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired challenge' });
    }

    // Find passkey by credential ID
    const result = getPasskeyByCredentialId(credential.id);
    if (!result) {
      return res.status(400).json({ error: 'Passkey not found' });
    }

    const { user, passkey } = result;

    // Reject deactivated accounts before doing any crypto work. Mirrors the
    // is_active gate in the credential /login handler so that disabling a user
    // also revokes their passkey-based access.
    if (!user.is_active) {
      return res.status(401).json({ error: 'Account is disabled' });
    }

    // Verify authentication
    const verification = await verifyPasskeyAuthentication(
      credential,
      stored.challenge,
      passkey.credentialPublicKey,
      passkey.counter
    );

    if (!verification.verified) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    // Compare-and-swap on the credential counter. If another assertion won
    // the race and already advanced the stored counter past what we verified
    // against, treat this as a replay and reject — accepting it would mean
    // two assertions succeeded against the same stored counter, which is
    // exactly what the WebAuthn signature counter is designed to prevent.
    const counterAdvanced = updatePasskeyCounter(
      user.id,
      passkey.id,
      passkey.counter,
      verification.authenticationInfo.newCounter
    );
    if (!counterAdvanced) {
      warn('[Passkey Login] Counter CAS failed — possible replay', {
        userId: user.id,
        passkeyId: passkey.id,
      });
      return res.status(401).json({ error: 'Passkey verification failed' });
    }
    challenges.delete(`passkey-auth-${sessionId}`);

    // Create session
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

    info('[Passkey Login] Creating session for user:', {
      userId: user.id,
      email: user.email,
      role: user.role,
      mfa_enabled: user.mfa_enabled,
      sessionID: req.sessionID,
    });

    // Save session explicitly
    req.session.save((err) => {
      if (err) {
        error('[Passkey Login] Session save error:', err);
        return res.status(500).json({ error: 'Session creation failed' });
      }

      info('[Passkey Login] ✅ Session saved successfully');
      
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
        },
      });
    });
  } catch (err) {
    error('[AuthExtended] Passkey auth verification error:', err);
    res.status(500).json({ error: 'Passkey authentication failed' });
  }
});

/**
 * List user's passkeys
 */
router.get('/passkey/list', requireAuth, (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const user = getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const passkeys = (user.passkeys || []).map(pk => ({
      id: pk.id,
      name: pk.name,
      created_at: pk.created_at,
    }));

    res.json({ passkeys });
  } catch (err) {
    error('[AuthExtended] Passkey list error:', err);
    res.status(500).json({ error: 'Failed to list passkeys' });
  }
});

/**
 * Remove a passkey
 */
router.delete('/passkey/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const passkeyId = req.params.id;

    // Get user info before deleting
    const user = getUserById(userId);
    
    // Get passkey name before deletion
    let passkeyName = 'Passkey';
    if (user && user.passkeys) {
      const passkey = user.passkeys.find((pk: any) => pk.id === passkeyId);
      if (passkey) {
        passkeyName = passkey.name;
      }
    }

    const success = removePasskey(userId, passkeyId);

    if (!success) {
      return res.status(404).json({ error: 'Passkey not found' });
    }

    // Send push notification to all admins
    if (user) {
      await notifyAllAdmins(
        'notifications.backend.passkeyDeletedTitle',
        'notifications.backend.passkeyDeletedBody',
        'passkey-deleted',
        'passkeyDeleted',
        {
          userName: user.name || user.email,
          passkeyName
        }
      ).catch(err => error('[AuthExtended] Failed to send passkey deletion notification:', err));
    }

    res.json({ success: true });
  } catch (err) {
    error('[AuthExtended] Passkey removal error:', err);
    res.status(500).json({ error: 'Failed to remove passkey' });
  }
});

/**
 * List all users (admin only)
 *
 * SECURITY: This endpoint MUST NOT return `invite_token` for any user. The
 * invite token is sufficient on its own to complete the invitation and take
 * over the invited account (see POST /invite/:token/complete, which is
 * unauthenticated by design), so disclosing it on every page-load of the
 * admin user list — even to admins — needlessly widens the blast radius of a
 * compromised admin session and blocks future token-rotation / one-time-use
 * controls. Admins fetch the token on demand via
 * GET /users/:userId/invite-link when they explicitly click "Copy Link".
 *
 * Endpoint also stays gated by requireAdmin — downgrading to requireAuth
 * would expose user metadata (roles, auth methods, MFA state, etc.) to
 * viewers/managers.
 */

export default router;
