/**
 * Optimizely user ID management
 * Handles dynamic user ID generation for A/B testing bucketing
 */

const COOKIE_NAME = 'optimizely_user_id';
const COOKIE_EXPIRY_DAYS = 365;

/**
 * Generate a random user ID
 */
export function generateUserId(): string {
  return `user_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;
}

/**
 * Get a cookie value by name
 */
function getCookie(name: string): string | null {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) {
    return parts.pop()?.split(';').shift() || null;
  }
  return null;
}

/**
 * Set a cookie with expiry
 */
function setCookie(name: string, value: string, days: number): void {
  const date = new Date();
  date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = `expires=${date.toUTCString()}`;
  document.cookie = `${name}=${value};${expires};path=/;SameSite=Strict`;
}

/**
 * Get or create Optimizely user ID
 * Checks for ?user=new query parameter to force regeneration
 * Returns the user ID and whether the URL should be cleaned
 */
export function getOptimizelyUserId(): { userId: string; shouldCleanUrl: boolean } {
  const urlParams = new URLSearchParams(window.location.search);
  const userParam = urlParams.get('user');

  // Check if we should generate a new user ID
  if (userParam === 'new') {
    const newUserId = generateUserId();
    setCookie(COOKIE_NAME, newUserId, COOKIE_EXPIRY_DAYS);
    console.log('[Optimizely] Generated new user ID:', newUserId);
    return { userId: newUserId, shouldCleanUrl: true };
  }

  // Try to get existing user ID from cookie
  const existingUserId = getCookie(COOKIE_NAME);
  if (existingUserId) {
    console.log('[Optimizely] Using existing user ID:', existingUserId);
    return { userId: existingUserId, shouldCleanUrl: false };
  }

  // No cookie exists, generate a new one
  const newUserId = generateUserId();
  setCookie(COOKIE_NAME, newUserId, COOKIE_EXPIRY_DAYS);
  console.log('[Optimizely] Generated initial user ID:', newUserId);
  return { userId: newUserId, shouldCleanUrl: false };
}

/**
 * Remove the ?user=new query parameter from URL
 */
export function cleanUserParamFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('user');
  window.history.replaceState({}, '', url.toString());
  console.log('[Optimizely] Cleaned ?user parameter from URL');
}

