/**
 * Extended Auth Routes
 * Login, invitations, password reset, MFA, passkeys and admin user management.
 *
 * This file is an aggregator: the handlers were split into cohesive sub-routers
 * (ticket #1506). All sub-routers are mounted on the same base router so the
 * public URLs under /api/auth-extended are unchanged.
 */
import { Router } from 'express';
import loginRouter from './auth-extended-login.js';
import invitesRouter from './auth-extended-invites.js';
import passwordResetRouter from './auth-extended-password-reset.js';
import mfaRouter from './auth-extended-mfa.js';
import passkeysRouter from './auth-extended-passkeys.js';
import usersRouter from './auth-extended-users.js';

const router = Router();

router.use(loginRouter);
router.use(invitesRouter);
router.use(passwordResetRouter);
router.use(mfaRouter);
router.use(passkeysRouter);
router.use(usersRouter);

export default router;
