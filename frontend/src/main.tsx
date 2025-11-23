import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OptimizelyProvider, createInstance } from '@optimizely/react-sdk'
import App from './App.tsx'
import { ANALYTICS_ENABLED } from './config'
import { initAnalytics } from './utils/analytics'
import { registerServiceWorker } from './utils/serviceWorker'
import { OPTIMIZELY_SDK_KEY } from './optimizely-config'
import { getOptimizelyUserId, cleanUserParamFromUrl } from './utils/optimizelyUser'
import './i18n/config' // Initialize i18n

// Initialize analytics
initAnalytics(ANALYTICS_ENABLED);

// Register service worker for caching
registerServiceWorker();

// Get or generate Optimizely user ID (checks for ?user=new)
const { userId, shouldCleanUrl } = getOptimizelyUserId();

// Clean URL if ?user=new was used
if (shouldCleanUrl) {
  cleanUserParamFromUrl();
}

// Initialize Optimizely SDK with datafile options
const optimizelyClient = createInstance({
  sdkKey: OPTIMIZELY_SDK_KEY,
  datafileOptions: {
    autoUpdate: true,
    updateInterval: 300000, // 5 minutes
  },
});

// Log when datafile is ready
optimizelyClient.onReady().then(() => {
  console.log('[Optimizely] Client ready, datafile loaded successfully');
}).catch((error) => {
  console.error('[Optimizely] Failed to load datafile:', error);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OptimizelyProvider
      optimizely={optimizelyClient}
      user={{ id: userId }}
    >
      <App />
    </OptimizelyProvider>
  </StrictMode>,
)
