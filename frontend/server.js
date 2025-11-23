import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { error, info, warn, debug } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory cache for JSON files
const jsonCache = new Map();
const JSON_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

// In-memory cache for pre-rendered homepage HTML
let homepageHTMLCache = null;
let homepageHTMLCacheTime = 0;

// Configuration paths and defaults
const dataDir = process.env.DATA_DIR || path.join(__dirname, "../data");
const configPath = path.join(dataDir, "config.json");
const envApiUrl = process.env.API_URL || process.env.BACKEND_DOMAIN;

// Load initial configuration
let configFile;
let config;
let isSetupMode = false;

/**
 * Load configuration from disk
 */
function loadConfig() {
  if (fs.existsSync(configPath)) {
    configFile = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config = configFile.environment;

    // Override API URL from environment if provided
    if (envApiUrl) {
      config.frontend.apiUrl = envApiUrl;
    }

    info("[Frontend] Configuration reloaded");
  }
}

// Load initial config
if (fs.existsSync(configPath)) {
  loadConfig();
} else {
  // Setup mode - use defaults
  info("[Frontend] config.json not found - using defaults for setup mode");
  isSetupMode = true;
  configFile = {
    analytics: {},
  };
  config = {
    frontend: {
      port: 3000,
      apiUrl: envApiUrl || "http://localhost:3001",
    },
    security: {
      allowedHosts: ["localhost:3000", "127.0.0.1:3000"],
      redirectFrom: [],
      redirectTo: null,
    },
  };
}

// Watch config file for changes and reload automatically
if (!isSetupMode) {
  fs.watch(configPath, (eventType) => {
    if (eventType === "change") {
      // Debounce: wait a bit for write to complete
      setTimeout(() => {
        try {
          loadConfig();
        } catch (err) {
          error("[Frontend] Failed to reload config:", err);
        }
      }, 100);
    }
  });
  info("[Frontend] Watching config.json for changes");
}

const app = express();
const port = process.env.PORT || config.frontend.port;

// Security headers middleware (except CSP which needs runtime API URL)
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");
  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Enable XSS protection
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions policy
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()"
  );
  // CSP is set in catch-all route to use runtime API URL
  next();
});

// Allowed hosts for security (prevent open redirect attacks)
// Include both config.json values and FRONTEND_DOMAIN from environment
const allowedHosts = [...config.security.allowedHosts];

// Add FRONTEND_DOMAIN from environment if set
if (process.env.FRONTEND_DOMAIN && process.env.FRONTEND_DOMAIN !== "-") {
  try {
    const frontendUrl = new URL(process.env.FRONTEND_DOMAIN);
    const frontendHost = frontendUrl.host; // includes port if present
    if (!allowedHosts.includes(frontendHost)) {
      allowedHosts.push(frontendHost);
      info(`[Security] Added FRONTEND_DOMAIN to allowedHosts: ${frontendHost}`);
    }
  } catch (e) {
    warn(
      `[Security] Invalid FRONTEND_DOMAIN URL: ${process.env.FRONTEND_DOMAIN}`
    );
  }
}

// HTTPS redirect middleware (only in production)
app.use((req, res, next) => {
  const host = req.get("host");

  // Skip host validation during setup mode (OOBE)
  if (!isSetupMode) {
    // Validate host to prevent open redirect attacks
    // Allow IP addresses for direct container access (e.g., Unraid WebUI)
    const ipPattern = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;
    const isIpAddress = ipPattern.test(host);
    const isLocalhost =
      host && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));

    if (!allowedHosts.includes(host) && !isIpAddress && !isLocalhost) {
      warn(`[Security] Invalid host header: ${host}`);
      warn(`[Security] Allowed hosts: ${allowedHosts.join(", ")}`);
      return res.status(400).send("Invalid host header");
    }
  }

  // Redirect to HTTPS if apiUrl uses https (production/remote dev)
  // Skip HTTPS redirect for IP addresses (e.g., direct Docker access)
  const ipPattern = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;
  const isIpAddress = ipPattern.test(host);
  const isProduction = config.frontend.apiUrl.startsWith("https://");
  if (
    isProduction &&
    req.headers["x-forwarded-proto"] !== "https" &&
    !isIpAddress
  ) {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  next();
});

// Domain redirect middleware (optional, for redirecting old domains)
app.use((req, res, next) => {
  const host = req.get("host");
  const redirectFrom = config.security.redirectFrom || [];
  const redirectTo = config.security.redirectTo;

  if (redirectFrom.length > 0 && redirectFrom.includes(host) && redirectTo) {
    return res.redirect(301, `https://${redirectTo}${req.originalUrl}`);
  }
  next();
});

// Serve primes page BEFORE React app (prevents React router from catching it)
// Handle both /primes and /primes/ with directory index support
app.use(
  "/primes",
  express.static(path.join(__dirname, "dist", "primes"), {
    index: "index.html",
  })
);

// Serve albums-data JSON files with no caching (must always be fresh)
// Express 5 changed wildcard syntax - use parameter instead
app.get("/albums-data/:filename", (req, res, next) => {
  // Only allow .json files
  if (!req.params.filename.endsWith('.json')) {
    return next();
  }
  
  const jsonPath = path.join(__dirname, "dist", "albums-data", req.params.filename);

  // Always read fresh from disk (no caching)
  fs.readFile(jsonPath, "utf8", (err, data) => {
    if (err) {
      return next(); // Fall through to express.static
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"); // Never cache
    res.setHeader("X-Cache", "NONE");
    res.send(data);
  });
});

// Health check endpoint (must come before static files to avoid conflicts)
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Frontend server is running" });
});

// Proxy all /api/* requests to backend
app.use("/api", express.json(), async (req, res, next) => {
  const apiUrl = config.frontend.apiUrl;
  const targetUrl = `${apiUrl}${req.originalUrl}`;
  
  try {
    // Forward the request to the backend
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': req.headers.cookie || '',
        'X-CSRF-Token': req.headers['x-csrf-token'] || '',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    });
    
    // Forward the response back to the client
    const contentType = response.headers.get('content-type');
    
    // Set status and headers
    res.status(response.status);
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    
    // Handle different content types
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const data = await response.text();
      res.send(data);
    }
  } catch (err) {
    error(`[API Proxy] Failed to proxy request to ${targetUrl}:`, err);
    res.status(500).json({ error: 'Proxy error', message: err.message });
  }
});

// Proxy for push notification endpoints (fixes Safari PWA content blocker)
// Safari blocks URLs containing /api/ even when same-origin, so we use /notifications/
app.use("/notifications", express.json(), async (req, res) => {
  const apiUrl = config.frontend.apiUrl;
  // Map /notifications/* to /api/push-notifications/* on backend
  const backendPath = req.path.replace(/^\//, '/api/push-notifications/');
  const targetUrl = `${apiUrl}${backendPath}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
  
  try {
    // Forward the request to the backend (using Node's built-in fetch)
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': req.headers.cookie || '',
        'X-CSRF-Token': req.headers['x-csrf-token'] || '',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    });
    
    // Forward the response back to the client
    const data = await response.text();
    res.status(response.status);
    
    // Copy relevant headers
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    
    res.send(data);
  } catch (err) {
    error(`[Proxy] Failed to proxy push notification request:`, err);
    res.status(500).json({ error: 'Proxy error', message: err.message });
  }
});

// Serve dynamic manifest.json with branding values
app.get("/manifest.json", (req, res) => {
  const siteName = configFile.branding?.siteName || "Galleria";
  const avatarPath = configFile.branding?.avatarPath || "/photos/avatar.png";

  // Derive site URL from API URL
  const apiUrl = config.frontend.apiUrl;
  let siteUrl;
  if (apiUrl.includes("localhost")) {
    siteUrl = apiUrl.replace(":3001", ":3000");
  } else {
    siteUrl = apiUrl.replace(/api(-dev)?\./, "www$1.");
  }

  // Build full avatar URL
  const avatarUrl = `${apiUrl}${avatarPath}`;

  const manifest = {
    name: siteName,
    short_name: siteName,
    description: `Photography portfolio by ${siteName}`,
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    orientation: "portrait-primary",
    icons: [
      {
        src: avatarUrl,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: avatarUrl,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: avatarUrl,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache"); // Don't cache - always fresh
  res.json(manifest);
});

// Serve dynamic apple-touch-icon for iOS home screen
app.get("/apple-touch-icon.png", (req, res) => {
  const apiUrl = config.frontend.apiUrl;
  const avatarPath = configFile.branding?.avatarPath || "/photos/avatar.png";
  const avatarUrl = `${apiUrl}${avatarPath}`;

  // Redirect to the avatar image
  res.redirect(307, avatarUrl);
});

// Serve static files from the dist directory
// But exclude index.html so we can inject runtime config
app.use(
  express.static(path.join(__dirname, "dist"), {
    index: false, // Don't serve index.html automatically - let catch-all handle it
  })
);

/**
 * Escape HTML special characters for safe insertion
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Replace runtime placeholders with current config values
 */
function replaceRuntimePlaceholders(html, apiUrl) {
  const siteName = configFile.branding?.siteName || "Galleria";
  const avatarPath = configFile.branding?.avatarPath || "/photos/avatar.png";
  const runtimeSiteUrl = apiUrl.includes("localhost")
    ? apiUrl.replace(":3001", ":3000")
    : apiUrl.replace(/api(-dev)?\./, "www$1.");

  return html
    .replace(/__RUNTIME_SITE_NAME__/g, escapeHtml(siteName))
    .replace(/__RUNTIME_AVATAR_PATH__/g, escapeHtml(avatarPath))
    .replace(/__RUNTIME_SITE_URL__/g, escapeHtml(runtimeSiteUrl));
}

/**
 * Set Content Security Policy header
 */
function setCSPHeader(res, apiUrl, configFile) {
  const apiDomainHttps = apiUrl.replace("http://", "https://");
  const analyticsScriptPath = configFile.analytics?.scriptPath || "";
  const analyticsScriptHost =
    analyticsScriptPath && analyticsScriptPath.startsWith("http")
      ? new URL(analyticsScriptPath).origin
      : "";

  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      `script-src 'self' 'unsafe-inline'${
        analyticsScriptHost ? " " + analyticsScriptHost : ""
      }; ` +
      "style-src 'self' 'unsafe-inline'; " +
      "worker-src 'self'; " +
      `img-src 'self' ${apiDomainHttps} ${apiUrl} data: blob: https://*.basemaps.cartocdn.com https://www.gravatar.com https://jumbe.zaius.com; ` +
      `media-src 'self' ${apiDomainHttps} ${apiUrl} blob:; ` +
      `connect-src 'self' ${apiDomainHttps} ${apiUrl} https://cdn.optimizely.com https://logx.optimizely.com https://jumbe.zaius.com; ` +
      "font-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'; " +
      "frame-ancestors 'none';"
  );
}

// Handle client-side routing (catch-all for React routes)
// This must come AFTER all other routes
// Express 5: use regex for catch-all routes
app.get(/^\/.*/, async (req, res) => {
  const indexPath = path.join(__dirname, "dist", "index.html");

  // Check if this is the homepage (root path)
  if (req.path === "/") {
    // Try to serve pre-rendered homepage HTML if it exists
    const prerenderedPath = path.join(__dirname, "dist", "homepage-prerendered.html");
    
    if (fs.existsSync(prerenderedPath)) {
      try {
        // Check if we have cached HTML template in memory
        const fileStats = fs.statSync(prerenderedPath);
        const fileModTime = fileStats.mtimeMs;
        
        let htmlTemplate;
        
        // Use cached template if available and file hasn't changed
        if (homepageHTMLCache && homepageHTMLCacheTime === fileModTime) {
          debug("[SSR] Using pre-rendered homepage template from memory cache");
          htmlTemplate = homepageHTMLCache;
        } else {
          // Read from disk and cache in memory
          htmlTemplate = fs.readFileSync(prerenderedPath, "utf8");
          homepageHTMLCache = htmlTemplate;
          homepageHTMLCacheTime = fileModTime;
          info("[SSR] Loaded pre-rendered homepage HTML template into memory cache");
        }
        
        // Determine runtime API URL (same logic as other routes)
        const protocol =
          req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
        const hostHeader =
          req.headers["x-forwarded-host"] ||
          req.headers["host"] ||
          "localhost:3000";
        const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
        let runtimeApiUrl;

        // Check if accessing via IP address (e.g., 192.168.1.219:3000)
        const ipPattern = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;
        if (ipPattern.test(host)) {
          // Direct IP access: use same IP with port 3001
          const ipAddress = host.split(":")[0];
          runtimeApiUrl = `${protocol}://${ipAddress}:3001`;
        } else if (host.includes("localhost")) {
          // Localhost development
          runtimeApiUrl = "http://localhost:3001";
        } else if (host.startsWith("www-")) {
          // Domain with www- prefix (e.g., www-dev.example.com -> api-dev.example.com)
          runtimeApiUrl = `${protocol}://api-${host.substring(4)}`;
        } else if (host.startsWith("www.")) {
          // Domain with www. prefix (e.g., www.example.com -> api.example.com)
          runtimeApiUrl = `${protocol}://api.${host.substring(4)}`;
        } else if (process.env.BACKEND_DOMAIN || process.env.API_URL) {
          // Fall back to environment variable if provided
          runtimeApiUrl = process.env.BACKEND_DOMAIN || process.env.API_URL;
        } else if (
          !isSetupMode &&
          config.frontend.apiUrl &&
          !config.frontend.apiUrl.includes("localhost")
        ) {
          // Use config file value if available
          runtimeApiUrl = config.frontend.apiUrl;
        } else {
          // Final fallback: derive from host
          runtimeApiUrl = `${protocol}://api.${host}`;
        }
        
        // Replace placeholder API URL with runtime-detected one
        const html = htmlTemplate.replace(
          /"http:\/\/localhost:3001"/g,
          `"${runtimeApiUrl}"`
        );
        
        // Set CSP and other security headers
        setCSPHeader(res, runtimeApiUrl, configFile);
        
        // Tell browsers NOT to cache (always fetch fresh from server)
        // But server caches template in memory for instant serving
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, private");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("X-Cache", "HIT"); // Indicate this came from server cache
        
        debug(`[SSR] Serving pre-rendered homepage with runtime API URL: ${runtimeApiUrl}`);
        return res.send(html);
      } catch (err) {
        error("[SSR] Failed to read pre-rendered homepage:", err);
        // Clear cache on error
        homepageHTMLCache = null;
        homepageHTMLCacheTime = 0;
        // Fall through to default handling
      }
    } else {
      warn("[SSR] Pre-rendered homepage not found, using default index.html");
      // Fall through to default handling
    }
  }

  // Check if this is a shared album link
  const sharedMatch = req.path.match(/^\/shared\/([a-f0-9]{64})$/i);
  if (sharedMatch) {
    const secretKey = sharedMatch[1];

    try {
      // Fetch shared album data from backend
      const apiUrl = config.frontend.apiUrl;
      const response = await fetch(`${apiUrl}/api/shared/${secretKey}`);

      if (response.ok) {
        const data = await response.json();
        const albumName = data.album;
        const photos = data.photos || [];

        // Get first photo as preview image
        const firstPhoto = photos[0];

        if (firstPhoto) {
          const safeAlbumName = escapeHtml(albumName);
          const albumTitleCase =
            albumName.charAt(0).toUpperCase() + albumName.slice(1);

          // Build URLs
          let siteUrl;
          if (apiUrl.includes("localhost")) {
            siteUrl = apiUrl.replace(":3001", ":3000");
          } else {
            siteUrl = apiUrl.replace(/api(-dev)?\./, "www$1.");
          }

          // Use 2x2 grid preview image
          const gridUrl = `${apiUrl}/api/preview-grid/shared/${secretKey}`;
          const pageUrl = `${siteUrl}/shared/${secretKey}`;

          // Log meta tag injection
          debug(`[Meta Injection] Shared album link detected:`);
          debug(`  Album: ${albumName}`);
          debug(`  Secret Key: ${secretKey}`);
          debug(`  Preview Image: ${gridUrl}`);
          debug(`  Page URL: ${pageUrl}`);

          // Get site name from branding
          const siteName = configFile.branding?.siteName || "Galleria";
          const safeSiteName = escapeHtml(siteName);

          // Read and modify index.html
          const html = fs.readFileSync(indexPath, "utf8");
          const modifiedHtml = html
            .replace(
              /<title>.*?<\/title>/,
              `<title>${safeAlbumName} - Shared Album - ${safeSiteName}</title>`
            )
            .replace(
              /<meta name="title" content=".*?" \/>/,
              `<meta name="title" content="${safeAlbumName} - Shared Album" />`
            )
            .replace(
              /<meta name="description" content=".*?" \/>/,
              `<meta name="description" content="View the ${safeAlbumName} album shared. ${
                photos.length
              } photo${photos.length !== 1 ? "s" : ""} available." />`
            )
            .replace(
              /<link rel="canonical" href=".*?" \/>/,
              `<link rel="canonical" href="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:type" content=".*?" \/>/,
              `<meta property="og:type" content="article" />`
            )
            .replace(
              /<meta property="og:url" content=".*?" \/>/,
              `<meta property="og:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:title" content=".*?" \/>/,
              `<meta property="og:title" content="${albumTitleCase} - Shared Album" />`
            )
            .replace(
              /<meta property="og:description" content=".*?" \/>/,
              `<meta property="og:description" content="View the ${albumTitleCase} album shared by. ${
                photos.length
              } photo${photos.length !== 1 ? "s" : ""} available." />`
            )
            .replace(
              /<meta property="og:image" content=".*?" \/>/,
              `<meta property="og:image" content="${gridUrl}" />\n    <meta property="og:image:secure_url" content="${gridUrl.replace(
                "http://",
                "https://"
              )}" />\n    <meta property="og:image:alt" content="${safeAlbumName} - Galleria" />\n    <meta property="og:image:type" content="image/jpeg" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />`
            )
            .replace(
              /<meta property="twitter:url" content=".*?" \/>/,
              `<meta property="twitter:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="twitter:title" content=".*?" \/>/,
              `<meta property="twitter:title" content="${albumTitleCase} - Shared Album" />`
            )
            .replace(
              /<meta property="twitter:description" content=".*?" \/>/,
              `<meta property="twitter:description" content="View the ${albumTitleCase} album shared. ${photos.length} photos available." />`
            )
            .replace(
              /<meta property="twitter:image" content=".*?" \/>/,
              `<meta property="twitter:image" content="${gridUrl}" />`
            );

          // Replace runtime placeholders
          const htmlWithPlaceholders = replaceRuntimePlaceholders(
            modifiedHtml,
            apiUrl
          );
          
          // Inject runtime config and branding
          const brandingData = {
            siteName: configFile.branding?.siteName || "Galleria",
            avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
            primaryColor: configFile.branding?.primaryColor || "#4ade80",
            secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
            language: configFile.branding?.language || "en"
          };
          
          const htmlWithBranding = htmlWithPlaceholders.replace(
            '<script type="module"',
            `<script>window.__RUNTIME_API_URL__ = "${apiUrl}"; window.__RUNTIME_BRANDING__ = ${JSON.stringify(brandingData)};</script>\n    <script type="module"`
          );
          
          return res.send(htmlWithBranding);
        }
      }
    } catch (error) {
      error("[MetaInjection] Failed to fetch shared album data:", error);
      // Fall through to default index.html
    }
  }

  // Check if this is an album route
  const urlPath = req.path;
  const photoParam = req.query.photo;
  const albumMatch = urlPath.match(/^\/album\/([^\/]+)$/);

  // Handle album page (without specific photo)
  if (albumMatch && !photoParam) {
    const albumName = albumMatch[1];
    const apiUrl = config.frontend.apiUrl;

    try {
      // Fetch album data to get photo count
      const response = await fetch(`${apiUrl}/api/albums/${albumName}/photos`);

      if (response.ok) {
        const photos = await response.json();

        if (photos.length > 0) {
          // Derive site URL
          let siteUrl;
          if (apiUrl.includes("localhost")) {
            siteUrl = apiUrl.replace(":3001", ":3000");
          } else {
            siteUrl = apiUrl.replace(/api(-dev)?\./, "www$1.");
          }

          // Use 2x2 grid preview image
          const gridUrl = `${apiUrl}/api/preview-grid/album/${albumName}`;
          const pageUrl = `${siteUrl}/album/${albumName}`;
          const albumTitleCase =
            albumName.charAt(0).toUpperCase() + albumName.slice(1);

          debug(`[Meta Injection] Album page detected:`);
          debug(`  Album: ${albumName}`);
          debug(`  Photos: ${photos.length}`);
          debug(`  Preview Image: ${gridUrl}`);
          debug(`  Page URL: ${pageUrl}`);

          const safeAlbumName = escapeHtml(albumTitleCase);

          // Get site name from branding
          const siteName = configFile.branding?.siteName || "Galleria";
          const safeSiteName = escapeHtml(siteName);

          // Read and modify HTML
          const html = fs.readFileSync(indexPath, "utf8");
          const modifiedHtml = html
            .replace(
              /<title>.*?<\/title>/,
              `<title>${safeAlbumName} - ${safeSiteName}</title>`
            )
            .replace(
              /<meta name="title" content=".*?" \/>/,
              `<meta name="title" content="${safeAlbumName} - Album" />`
            )
            .replace(
              /<meta name="description" content=".*?" \/>/,
              `<meta name="description" content="Explore ${
                photos.length
              } photo${
                photos.length !== 1 ? "s" : ""
              } from the ${safeAlbumName} album." />`
            )
            .replace(
              /<link rel="canonical" href=".*?" \/>/,
              `<link rel="canonical" href="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:type" content=".*?" \/>/,
              `<meta property="og:type" content="website" />`
            )
            .replace(
              /<meta property="og:url" content=".*?" \/>/,
              `<meta property="og:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="og:title" content=".*?" \/>/,
              `<meta property="og:title" content="${safeAlbumName} - Album" />`
            )
            .replace(
              /<meta property="og:description" content=".*?" \/>/,
              `<meta property="og:description" content="Explore ${
                photos.length
              } photo${
                photos.length !== 1 ? "s" : ""
              } from the ${safeAlbumName} album." />`
            )
            .replace(
              /<meta property="og:image" content=".*?" \/>/,
              `<meta property="og:image" content="${gridUrl}" />\n    <meta property="og:image:secure_url" content="${gridUrl.replace(
                "http://",
                "https://"
              )}" />\n    <meta property="og:image:alt" content="${safeAlbumName} - Galleria" />\n    <meta property="og:image:type" content="image/jpeg" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />`
            )
            .replace(
              /<meta property="twitter:url" content=".*?" \/>/,
              `<meta property="twitter:url" content="${pageUrl}" />`
            )
            .replace(
              /<meta property="twitter:title" content=".*?" \/>/,
              `<meta property="twitter:title" content="${safeAlbumName} - Album" />`
            )
            .replace(
              /<meta property="twitter:description" content=".*?" \/>/,
              `<meta property="twitter:description" content="Explore ${
                photos.length
              } photo${
                photos.length !== 1 ? "s" : ""
              } from the ${safeAlbumName} album." />`
            )
            .replace(
              /<meta property="twitter:image" content=".*?" \/>/,
              `<meta property="twitter:image" content="${gridUrl}" />`
            );

          // Replace runtime placeholders
          const htmlWithPlaceholders = replaceRuntimePlaceholders(
            modifiedHtml,
            apiUrl
          );
          
          // Inject runtime config and branding
          const brandingData = {
            siteName: configFile.branding?.siteName || "Galleria",
            avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
            primaryColor: configFile.branding?.primaryColor || "#4ade80",
            secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
            language: configFile.branding?.language || "en"
          };
          
          const htmlWithBranding = htmlWithPlaceholders.replace(
            '<script type="module"',
            `<script>window.__RUNTIME_API_URL__ = "${apiUrl}"; window.__RUNTIME_BRANDING__ = ${JSON.stringify(brandingData)};</script>\n    <script type="module"`
          );
          
          return res.send(htmlWithBranding);
        }
      }
    } catch (error) {
      error("[MetaInjection] Failed to fetch album data:", error);
      // Fall through to default handling
    }
  }

  // Handle photo permalink (album route with photo parameter)
  if (albumMatch && photoParam) {
    const albumName = albumMatch[1];
    const photoFilename = photoParam;
    const apiUrl = config.frontend.apiUrl;

    try {
      // Fetch album photos to get the actual image title from database
      const response = await fetch(`${apiUrl}/api/albums/${albumName}/photos`);

      if (response.ok) {
        const photos = await response.json();

        // Find the specific photo by filename
        const photo = photos.find(
          (p) => p.id === `${albumName}/${photoFilename}`
        );

        if (photo) {
          // Use the actual title from the database
          const photoTitle = photo.title;
          const safePhotoTitle = escapeHtml(photoTitle);

          // Derive site URL from API URL:
          // Production: https://api.example.com -> https://www.example.com
          // Development: http://localhost:3001 -> http://localhost:3000
          // Dev server: https://api-dev.example.com -> https://www-dev.example.com
          let siteUrl;
          if (apiUrl.includes("localhost")) {
            siteUrl = apiUrl.replace(":3001", ":3000");
          } else {
            // Handle both api. and api-dev. patterns
            siteUrl = apiUrl.replace(/api(-dev)?\./, "www$1.");
          }

          // Ensure thumbnail URL uses HTTPS for production
          // Use full URL with protocol for social media crawlers
          let thumbnailUrl = `${apiUrl}/optimized/thumbnail/${albumName}/${photoFilename}`;

          const pageUrl = `${siteUrl}/album/${albumName}?photo=${encodeURIComponent(
            photoFilename
          )}`;
          const albumTitleCase =
            albumName.charAt(0).toUpperCase() + albumName.slice(1);

          // Log meta tag injection for debugging
          debug(`[Meta Injection] Photo permalink detected:`);
          debug(`  Album: ${albumName}`);
          debug(`  Photo: ${photoFilename}`);
          debug(`  Title: ${photoTitle}`);
          debug(`  OG Image: ${thumbnailUrl}`);
          debug(
            `  OG Image (secure): ${thumbnailUrl.replace(
              "http://",
              "https://"
            )}`
          );
          debug(`  Page URL: ${pageUrl}`);

          // Get site name from branding
          const siteName = configFile.branding?.siteName || "Galleria";
          const safeSiteName = escapeHtml(siteName);

          // Read the index.html file
          const html = fs.readFileSync(indexPath, "utf8");

          // Replace meta tags with photo-specific content
          const modifiedHtml = html
            // Update page title
            .replace(
              /<title>.*?<\/title>/,
              `<title>${safePhotoTitle} - ${albumTitleCase} - ${safeSiteName}</title>`
            )
            // Update meta title
            .replace(
              /<meta name="title" content=".*?" \/>/,
              `<meta name="title" content="${safePhotoTitle} - ${albumTitleCase} - ${safeSiteName}" />`
            )
            // Update meta description
            .replace(
              /<meta name="description" content=".*?" \/>/,
              `<meta name="description" content="'${safePhotoTitle}' from the ${albumTitleCase} album" />`
            )
            // Update canonical URL
            .replace(
              /<link rel="canonical" href=".*?" \/>/,
              `<link rel="canonical" href="${pageUrl}" />`
            )
            // Update og:type to article for individual photos
            .replace(
              /<meta property="og:type" content=".*?" \/>/,
              `<meta property="og:type" content="article" />`
            )
            // Update og:url
            .replace(
              /<meta property="og:url" content=".*?" \/>/,
              `<meta property="og:url" content="${pageUrl}" />`
            )
            // Update og:title
            .replace(
              /<meta property="og:title" content=".*?" \/>/,
              `<meta property="og:title" content="${safePhotoTitle} - ${albumTitleCase}" />`
            )
            // Update og:description
            .replace(
              /<meta property="og:description" content=".*?" \/>/,
              `<meta property="og:description" content="'${safePhotoTitle}' from the ${albumTitleCase} album" />`
            )
            // Update og:image to the photo thumbnail
            .replace(
              /<meta property="og:image" content=".*?" \/>/,
              `<meta property="og:image" content="${thumbnailUrl}" />\n    <meta property="og:image:secure_url" content="${thumbnailUrl.replace(
                "http://",
                "https://"
              )}" />\n    <meta property="og:image:alt" content="${safePhotoTitle} - Galleria" />\n    <meta property="og:image:type" content="image/jpeg" />`
            )
            // Update twitter:url
            .replace(
              /<meta property="twitter:url" content=".*?" \/>/,
              `<meta property="twitter:url" content="${pageUrl}" />`
            )
            // Update twitter:title
            .replace(
              /<meta property="twitter:title" content=".*?" \/>/,
              `<meta property="twitter:title" content="${safePhotoTitle} - ${albumTitleCase}" />`
            )
            // Update twitter:description
            .replace(
              /<meta property="twitter:description" content=".*?" \/>/,
              `<meta property="twitter:description" content="'${safePhotoTitle}' from the ${albumTitleCase} album" />`
            )
            // Update twitter:image to the photo thumbnail
            .replace(
              /<meta property="twitter:image" content=".*?" \/>/,
              `<meta property="twitter:image" content="${thumbnailUrl}" />`
            );

          // Replace runtime placeholders
          const htmlWithPlaceholders = replaceRuntimePlaceholders(
            modifiedHtml,
            apiUrl
          );
          
          // Inject runtime config and branding
          const brandingData = {
            siteName: configFile.branding?.siteName || "Galleria",
            avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
            primaryColor: configFile.branding?.primaryColor || "#4ade80",
            secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
            language: configFile.branding?.language || "en"
          };
          
          const htmlWithBranding = htmlWithPlaceholders.replace(
            '<script type="module"',
            `<script>window.__RUNTIME_API_URL__ = "${apiUrl}"; window.__RUNTIME_BRANDING__ = ${JSON.stringify(brandingData)};</script>\n    <script type="module"`
          );
          
          return res.send(htmlWithBranding);
        }
      }
    } catch (error) {
      error("[MetaInjection] Failed to fetch photo data:", error);
      // Fall through to default handling
    }
  }

  // Default: serve the standard index.html
  // Inject runtime API URL for OOBE support
  fs.readFile(indexPath, "utf8", (err, html) => {
    if (err) {
      error("[Frontend] Failed to read index.html:", err);
      return res.sendFile(indexPath);
    }

    // Determine runtime API URL
    // Always auto-detect from request headers first (supports both IP and domain access)
    const protocol =
      req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
    const hostHeader =
      req.headers["x-forwarded-host"] ||
      req.headers["host"] ||
      "localhost:3000";
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    let runtimeApiUrl;

    // Check if accessing via IP address (e.g., 192.168.1.219:3000)
    const ipPattern = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;
    if (ipPattern.test(host)) {
      // Direct IP access: use same IP with port 3001
      const ipAddress = host.split(":")[0];
      runtimeApiUrl = `${protocol}://${ipAddress}:3001`;
    } else if (host.includes("localhost")) {
      // Localhost development
      runtimeApiUrl = "http://localhost:3001";
    } else if (host.startsWith("www-")) {
      // Domain with www- prefix (e.g., www-dev.example.com -> api-dev.example.com)
      runtimeApiUrl = `${protocol}://api-${host.substring(4)}`;
    } else if (host.startsWith("www.")) {
      // Domain with www. prefix (e.g., www.example.com -> api.example.com)
      runtimeApiUrl = `${protocol}://api.${host.substring(4)}`;
    } else if (process.env.BACKEND_DOMAIN || process.env.API_URL) {
      // Fall back to environment variable if provided
      runtimeApiUrl = process.env.BACKEND_DOMAIN || process.env.API_URL;
    } else if (
      !isSetupMode &&
      config.frontend.apiUrl &&
      !config.frontend.apiUrl.includes("localhost")
    ) {
      // Use config file value if available
      runtimeApiUrl = config.frontend.apiUrl;
    } else {
      // Final fallback: derive from host
      runtimeApiUrl = `${protocol}://api.${host}`;
    }

    // Set Content Security Policy with runtime API URL
    setCSPHeader(res, runtimeApiUrl, configFile);

    // Prevent caching of index.html to ensure placeholders are always fresh
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    // Get site name from branding and update title
    const siteName = configFile.branding?.siteName || "Galleria";
    const safeSiteName = escapeHtml(siteName);

    // Replace title tag with site name
    let modifiedHtml = html.replace(
      /<title>.*?<\/title>/,
      `<title>${safeSiteName}</title>`
    );

    // Replace runtime placeholders with current config values
    modifiedHtml = replaceRuntimePlaceholders(modifiedHtml, runtimeApiUrl);

    // Inject runtime config and branding before other scripts
    const brandingData = {
      siteName: configFile.branding?.siteName || "Galleria",
      avatarPath: configFile.branding?.avatarPath || "/photos/avatar.png",
      primaryColor: configFile.branding?.primaryColor || "#4ade80",
      secondaryColor: configFile.branding?.secondaryColor || "#3b82f6",
      language: configFile.branding?.language || "en"
    };
    
    modifiedHtml = modifiedHtml.replace(
      '<script type="module"',
      `<script>window.__RUNTIME_API_URL__ = "${runtimeApiUrl}"; window.__RUNTIME_BRANDING__ = ${JSON.stringify(brandingData)};</script>\n    <script type="module"`
    );

    res.send(modifiedHtml);
  });
});

// Listen on 0.0.0.0 for remote dev/production, 127.0.0.1 for localhost
// Allow HOST environment variable to override
const isLocalhost = config.frontend.apiUrl.includes("localhost");
const bindHost = process.env.HOST || (isLocalhost ? "127.0.0.1" : "0.0.0.0");

app.listen(port, bindHost, () => {
  info(`[Frontend] Server running on ${bindHost}:${port}`);
  info(`[Frontend] API URL: ${config.frontend.apiUrl}`);

  // Signal PM2 that app is ready (for zero-downtime reloads)
  if (process.send) {
    process.send("ready");
  }
});
