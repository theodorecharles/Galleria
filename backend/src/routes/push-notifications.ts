/**
 * Push Notifications Routes
 * 
 * API endpoints for managing Web Push API subscriptions.
 * Only accessible to managers and admins (users who can run processing jobs).
 */

import express from 'express';
import webPush from 'web-push';
import fs from 'fs';
import { join } from 'path';
import { csrfProtection } from '../security.js';
import { requireManager } from '../auth/middleware.js';
import {
  initializePushNotifications,
  isPushNotificationsEnabled,
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  getUserSubscriptions,
  sendNotificationToUser,
  type PushSubscription
} from '../push-notifications.js';
import { DATA_DIR, reloadConfig } from '../config.js';
import { getDatabase } from '../database.js';
import { info, error, warn } from '../utils/logger.js';
import { translateNotification } from '../i18n-backend.js';

const router = express.Router();

// Note: initializePushNotifications() is called from server.ts after database initialization

/**
 * GET /api/push-notifications/config
 * Get push notification configuration (enabled status and VAPID public key)
 * Only accessible to managers and admins
 */
router.get('/config', requireManager, (req, res) => {
  const enabled = isPushNotificationsEnabled();
  const vapidPublicKey = enabled ? getVapidPublicKey() : null;

  res.json({
    enabled,
    vapidPublicKey
  });
});

/**
 * POST /api/push-notifications/subscribe
 * Register a new push notification subscription
 * Only accessible to managers and admins
 */
router.post('/subscribe', csrfProtection, requireManager, (req, res) => {
  if (!isPushNotificationsEnabled()) {
    return res.status(503).json({
      success: false,
      message: 'Push notifications are not enabled on this server'
    });
  }

  const { subscription } = req.body;
  
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({
      success: false,
      message: 'Invalid subscription object'
    });
  }

  const userId = (req.user as any).id;
  const userAgent = req.headers['user-agent'] || 'Unknown';

  try {
    const success = saveSubscription(userId, subscription as PushSubscription, userAgent);
    
    if (success) {
      info(`[PushNotifications] User ${(req.user as any).email} subscribed to push notifications`);
      res.json({
        success: true,
        message: 'Subscription saved successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to save subscription'
      });
    }
  } catch (err: any) {
    error('[PushNotifications] Error saving subscription:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Internal server error'
    });
  }
});

/**
 * POST /api/push-notifications/unsubscribe
 * Remove a push notification subscription
 * Only accessible to managers and admins
 */
router.post('/unsubscribe', csrfProtection, requireManager, (req, res) => {
  const { endpoint } = req.body;
  
  if (!endpoint) {
    return res.status(400).json({
      success: false,
      message: 'Endpoint is required'
    });
  }

  try {
    const success = removeSubscription(endpoint);
    
    if (success) {
      info(`[PushNotifications] User ${(req.user as any).email} unsubscribed from push notifications`);
      res.json({
        success: true,
        message: 'Subscription removed successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Subscription not found'
      });
    }
  } catch (err: any) {
    error('[PushNotifications] Error removing subscription:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Internal server error'
    });
  }
});

/**
 * GET /api/push-notifications/subscriptions
 * Get all push subscriptions for the current user
 * Only accessible to managers and admins
 */
router.get('/subscriptions', requireManager, (req, res) => {
  try {
    const userId = (req.user as any).id;
    const subscriptions = getUserSubscriptions(userId);
    
    // Return just the endpoints (don't expose keys to client)
    const endpoints = subscriptions.map(sub => sub.endpoint);
    
    res.json({
      success: true,
      subscriptions: endpoints
    });
  } catch (err: any) {
    error('[PushNotifications] Error fetching subscriptions:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Internal server error'
    });
  }
});

/**
 * POST /api/push-notifications/generate-keys
 * Generate new VAPID keys (admin only)
 */
router.post('/generate-keys', csrfProtection, requireManager, (req, res) => {
  try {
    const keys = webPush.generateVAPIDKeys();
    
    // Get first admin user's email from database
    const db = getDatabase();
    const adminUser = db.prepare(`
      SELECT email FROM users 
      WHERE role = 'admin' 
      ORDER BY id ASC 
      LIMIT 1
    `).get() as { email: string } | undefined;
    
    const adminEmail = adminUser?.email || 'admin@example.com';
    info(`[PushNotifications] VAPID keys generated, using admin email: ${adminEmail}`);
    
    // Auto-save keys to the configured data directory
    const configPath = join(DATA_DIR, 'config.json');
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    if (!configData.pushNotifications) {
      configData.pushNotifications = {};
    }
    
    configData.pushNotifications.enabled = true;
    configData.pushNotifications.vapidPublicKey = keys.publicKey;
    configData.pushNotifications.vapidPrivateKey = keys.privateKey;
    configData.pushNotifications.vapidSubject = `mailto:${adminEmail}`;
    
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
    
    // Reload config in memory
    reloadConfig();
    
    // Re-initialize push notifications with new keys
    initializePushNotifications();
    
    // Clear all existing subscriptions since they're now invalid with new VAPID keys
    const deleteStmt = db.prepare('DELETE FROM push_subscriptions');
    const deleteResult = deleteStmt.run();
    info(`[PushNotifications] Cleared ${deleteResult.changes} existing subscription(s) - users will need to re-subscribe`);
    
    res.json({
      success: true,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      vapidSubject: `mailto:${adminEmail}`,
      clearedSubscriptions: deleteResult.changes
    });
  } catch (err: any) {
    error('[PushNotifications] Error generating VAPID keys:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to generate VAPID keys'
    });
  }
});

/**
 * POST /api/push-notifications/test
 * Send a test notification to the current user
 * Only accessible to managers and admins (for testing their subscription)
 */
router.post('/test', csrfProtection, requireManager, async (req, res) => {
  if (!isPushNotificationsEnabled()) {
    return res.status(503).json({
      success: false,
      message: 'Push notifications are not enabled on this server'
    });
  }

  try {
    const userId = (req.user as any).id;
    const userName = (req.user as any).name || (req.user as any).email;
    
    const title = await translateNotification('notifications.backend.testNotificationTitle', { userName });
    const body = await translateNotification('notifications.backend.testNotificationBody', { userName });
    
    await sendNotificationToUser(userId, {
      title,
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'test-notification',
      requireInteraction: false
    });
    
    info(`[PushNotifications] Test notification sent to user ${(req.user as any).email}`);
    
    res.json({
      success: true,
      message: 'Test notification sent'
    });
  } catch (err: any) {
    error('[PushNotifications] Error sending test notification:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to send test notification'
    });
  }
});

export default router;
