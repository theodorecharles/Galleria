/**
 * Optimizely Event Tracking Utilities
 * Tracks when users enable/configure different features
 */

import { ReactSDKClient } from '@optimizely/react-sdk';

// Event names for feature configuration
export const OPTIMIZELY_EVENTS = {
  OPENAI_CONFIGURED: 'openai_configured',
  ANALYTICS_CONFIGURED: 'analytics_configured',
  GOOGLE_OAUTH_CONFIGURED: 'google_oauth_configured',
  EMAIL_CONFIGURED: 'email_configured',
  NOTIFICATIONS_ENABLED: 'notifications_enabled',
} as const;

/**
 * Track an Optimizely event
 * This function safely handles tracking even if Optimizely is not available
 */
export function trackOptimizelyEvent(
  eventName: string,
  optimizely?: ReactSDKClient | null
): void {
  try {
    if (optimizely && typeof optimizely.track === 'function') {
      optimizely.track(eventName);
      console.log(`[Optimizely] Tracked event: ${eventName}`);
    } else {
      console.warn(`[Optimizely] Client not available, skipping event: ${eventName}`);
    }
  } catch (error) {
    console.error(`[Optimizely] Failed to track event ${eventName}:`, error);
  }
}

/**
 * Check if a feature is being enabled (transition from disabled to enabled)
 */
export function isFeatureBeingEnabled(
  newValue: boolean,
  oldValue: boolean
): boolean {
  return newValue === true && oldValue === false;
}

/**
 * Check if a required field is being set for the first time
 */
export function isFeatureBeingConfigured(
  newValue: string | undefined,
  oldValue: string | undefined
): boolean {
  return !!newValue && !oldValue;
}

