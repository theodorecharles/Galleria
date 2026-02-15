/**
 * Branding management routes
 * Handles site branding configuration including site name, colors, logo, etc.
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import multer from "multer";
import os from "os";
import sharp from "sharp";
import { spawn } from "child_process";
import { requireManager } from "../auth/middleware.js";
import { csrfProtection } from "../security.js";
import { error, warn, info, debug, verbose } from "../utils/logger.js";
import { generateHomepageHTML } from "./homepage-html.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Configure multer for avatar upload
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
      cb(null, `avatar-${Date.now()}${path.extname(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    // Accept all image types (including HEIC) - will be converted to PNG
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Apply CSRF protection to all routes in this router
router.use(csrfProtection);

// Path to config file - go up from backend/src/routes to project root, then into config
import { DATA_DIR, reloadConfig } from "../config.js";

const configPath = path.join(DATA_DIR, "config.json");
info("[Branding Routes] Config path resolved to:", configPath);
info("[Branding Routes] __dirname is:", __dirname);

interface BrandingConfig {
  siteName: string;
  avatarPath: string;
  headerAvatarPath: string;
  avatarCacheBust: number;
  primaryColor: string;
  secondaryColor: string;
  metaDescription: string;
  metaKeywords: string;
  faviconPath: string;
  shuffleHomepage?: boolean;
  photoLicense?: string;
  language?: string;
  enableAnimatedBackground?: boolean;
  headerTheme?: 'light' | 'dark' | 'custom';
  headerBackgroundColor?: string;
  headerTextColor?: string;
  headerOpacity?: number;
  headerBlur?: number;
  headerBorderColor?: string;
  headerBorderOpacity?: number;
  headerDropdownTheme?: 'light' | 'dark';
  photoGridTheme?: 'light' | 'dark';
  customCSS?: string;
  gridColumns600?: number;
  gridColumns900?: number;
  gridColumns1200?: number;
  gridColumns1600?: number;
}

// Get current branding configuration
router.get("/", (req: Request, res: Response) => {
  try {
    const configContent = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configContent);
    const branding = config.branding || {};

    // Set defaults if not present
    const brandingConfig: BrandingConfig = {
      siteName: branding.siteName || "Galleria",
      avatarPath: branding.avatarPath || "/photos/avatar.png",
      headerAvatarPath: branding.headerAvatarPath || "/photos/avatar-header.webp",
      avatarCacheBust: branding.avatarCacheBust || 0,
      primaryColor: branding.primaryColor || "#4ade80",
      secondaryColor: branding.secondaryColor || "#22c55e",
      metaDescription: branding.metaDescription || "Galleria",
      metaKeywords: branding.metaKeywords || "photography, portfolio",
      faviconPath: branding.faviconPath || "/favicon.ico",
      shuffleHomepage: branding.shuffleHomepage ?? true,
      photoLicense: branding.photoLicense || "cc-by",
      language: branding.language || "en",
      enableAnimatedBackground: branding.enableAnimatedBackground ?? true,
      headerTheme: branding.headerTheme || "light",
      headerBackgroundColor: branding.headerBackgroundColor || "#e7e7e7",
      headerTextColor: branding.headerTextColor || "#1e1e1e",
      headerOpacity: branding.headerOpacity ?? 1,
      headerBlur: branding.headerBlur ?? 0,
      headerBorderColor: branding.headerBorderColor || "#1e1e1e",
      headerBorderOpacity: branding.headerBorderOpacity ?? 0.2,
      headerDropdownTheme: branding.headerDropdownTheme || "light",
      photoGridTheme: branding.photoGridTheme || "dark",
      customCSS: branding.customCSS || "",
      gridColumns600: branding.gridColumns600,
      gridColumns900: branding.gridColumns900,
      gridColumns1200: branding.gridColumns1200,
      gridColumns1600: branding.gridColumns1600,
    };

    res.json(brandingConfig);
  } catch (err) {
    error("[Branding] Failed to read branding config:", err);
    res.status(500).json({ error: "Failed to read branding configuration" });
  }
});

// Update branding configuration
router.put("/", requireManager, (req: Request, res: Response) => {
  try {
    const updates: Partial<BrandingConfig> = req.body;

    // Validate input
    if (!updates || typeof updates !== "object") {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    // Validate each field if provided
    const validFields = [
      "siteName",
      "avatarPath",
      "headerAvatarPath",
      "avatarCacheBust",
      "primaryColor",
      "secondaryColor",
      "metaDescription",
      "metaKeywords",
      "faviconPath",
      "shuffleHomepage",
      "photoLicense",
      "language",
      "enableAnimatedBackground",
      "headerTheme",
      "headerBackgroundColor",
      "headerTextColor",
      "headerOpacity",
      "headerBlur",
      "headerBorderColor",
      "headerBorderOpacity",
      "headerDropdownTheme",
      "photoGridTheme",
      "customCSS",
      "gridColumns600",
      "gridColumns900",
      "gridColumns1200",
      "gridColumns1600",
    ];
    for (const [key, value] of Object.entries(updates)) {
      if (!validFields.includes(key)) {
        res.status(400).json({ error: `Invalid field: ${key}` });
        return;
      }

      // Type validation based on field
      if (key === "shuffleHomepage" || key === "enableAnimatedBackground") {
        if (typeof value !== "boolean") {
          res.status(400).json({ error: `Field ${key} must be a boolean` });
          return;
        }
      } else if (key === "avatarCacheBust") {
        if (typeof value !== "number") {
          res.status(400).json({ error: "avatarCacheBust must be a number" });
          return;
        }
      } else if (key === "headerOpacity") {
        if (typeof value !== "number" || value < 0 || value > 1) {
          res.status(400).json({ error: "Header opacity must be a number between 0 and 1" });
          return;
        }
      } else if (key === "headerBlur") {
        // Handle backward compatibility: convert old boolean values to numbers
        if (typeof value === "boolean") {
          updates.headerBlur = value ? 10 : 0; // true -> 10px, false -> 0px
        } else if (typeof value !== "number" || value < 0 || value > 20) {
          res.status(400).json({ error: "Header blur must be a number between 0 and 20" });
          return;
        }
      } else if (key === "gridColumns600" || key === "gridColumns900" || key === "gridColumns1200" || key === "gridColumns1600") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8) {
          res.status(400).json({ error: `${key} must be an integer between 1 and 8` });
          return;
        }
      } else if (key === "headerBorderOpacity") {
        if (typeof value !== "number" || value < 0 || value > 1) {
          res.status(400).json({ error: "Header border opacity must be a number between 0 and 1" });
          return;
        }
      } else {
        if (typeof value !== "string") {
          res.status(400).json({ error: `Field ${key} must be a string` });
          return;
        }

        // Length limits (only for strings, but language is short)
        if (key === "language") {
          // Language code should be 2-5 characters (e.g., 'en', 'es', 'fr', 'en-US')
          if (value.length > 10) {
            res
              .status(400)
              .json({ error: `Field ${key} is too long (max 10 characters)` });
            return;
          }
        } else if (key === "headerTheme") {
          // headerTheme must be 'light', 'dark', or 'custom'
          if (value !== "light" && value !== "dark" && value !== "custom") {
            res
              .status(400)
              .json({ error: "Header theme must be 'light', 'dark', or 'custom'" });
            return;
          }
        } else if (key === "headerDropdownTheme" || key === "photoGridTheme") {
          // Must be 'light' or 'dark'
          if (value !== "light" && value !== "dark") {
            res
              .status(400)
              .json({ error: `${key} must be 'light' or 'dark'` });
            return;
          }
        } else if (key === "headerBackgroundColor" || key === "headerTextColor" || key === "headerBorderColor") {
          // Validate hex color format
          if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
            res
              .status(400)
              .json({ error: `${key} must be a valid hex color (e.g., #FF0000)` });
            return;
          }
        } else if (key === "customCSS") {
          // Custom CSS has a larger limit (50KB)
          if (value.length > 50000) {
            res
              .status(400)
              .json({ error: "Custom CSS is too long (max 50KB)" });
            return;
          }
        } else if (value.length > 500) {
          res
            .status(400)
            .json({ error: `Field ${key} is too long (max 500 characters)` });
          return;
        }
      }
    }

    // Validate color format if provided
    if (
      updates.primaryColor &&
      !/^#[0-9A-Fa-f]{6}$/.test(updates.primaryColor)
    ) {
      res
        .status(400)
        .json({
          error: "Primary color must be a valid hex color (e.g., #FF0000)",
        });
      return;
    }

    if (
      updates.secondaryColor &&
      !/^#[0-9A-Fa-f]{6}$/.test(updates.secondaryColor)
    ) {
      res
        .status(400)
        .json({
          error: "Secondary color must be a valid hex color (e.g., #FF0000)",
        });
      return;
    }

    // Read current config
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    // Initialize branding section if it doesn't exist
    if (!config.branding) {
      config.branding = {};
    }

    // Update branding configuration
    Object.assign(config.branding, updates);

    // Write back to file
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Reload config cache in memory (important for language changes!)
    reloadConfig();
    info("[Branding] Config reloaded after branding update");

    // Send push notification to all admins about branding update
    (async () => {
      try {
        const { sendNotificationToUser } = await import('../push-notifications.js');
        const { translateNotification } = await import('../i18n-backend.js');
        const { getAllUsers } = await import('../database-users.js');
        
        const admins = getAllUsers().filter(u => u.role === 'admin');
        for (const admin of admins) {
          const title = await translateNotification('notifications.backend.brandingUpdatedTitle', {
            updatedBy: (req.user as any).name || (req.user as any).email
          });
          const body = await translateNotification('notifications.backend.brandingUpdatedBody', {
            updatedBy: (req.user as any).name || (req.user as any).email
          });
          
          sendNotificationToUser(admin.id, {
            title,
            body,
            tag: 'branding-updated',
            requireInteraction: false
          }, 'brandingUpdated');
        }
      } catch (err) {
        error('[Branding] Failed to send branding update notification:', err);
      }
    })();

    // Regenerate homepage HTML if branding changed (affects meta tags and initial data)
    const appRoot = req.app.get('appRoot');
    generateHomepageHTML(appRoot).then(result => {
      if (result.success) {
        info("[Branding] Homepage HTML regenerated after branding update");
      } else {
        error("[Branding] Failed to regenerate homepage HTML:", result.error);
      }
    }).catch(err => {
      error("[Branding] Error regenerating homepage HTML:", err);
    });

    // Reload frontend if siteName, avatarPath, or metaDescription changed (affects HTML placeholders)
    const needsFrontendReload =
      updates.siteName || updates.avatarPath || updates.metaDescription;
    if (needsFrontendReload) {
      reloadFrontend();
    }

    res.json({
      success: true,
      message: "Branding configuration updated successfully",
      branding: config.branding,
    });
  } catch (err) {
    error("[Branding] Failed to update branding config:", err);
    res.status(500).json({ error: "Failed to update branding configuration" });
  }
});

/**
 * Reload frontend PM2 process to pick up config changes
 */
function reloadFrontend() {
  try {
    // Check if PM2 is available
    const pm2Available =
      require("child_process").spawnSync("which", ["pm2"]).status === 0;

    if (pm2Available) {
      info("[Branding] Reloading frontend to apply branding changes...");

      const reload = spawn("pm2", ["reload", "frontend"], {
        detached: true,
        stdio: "ignore",
      });

      reload.on("error", (err) => {
        error("[Branding] Failed to reload frontend:", err);
      });

      reload.on("exit", (code) => {
        if (code === 0) {
          info("[Branding] ✓ Frontend reloaded successfully");
        } else {
          warn(`[Branding] Frontend reload exited with code ${code}`);
        }
      });

      reload.unref();
    }
  } catch (err) {
    error("[Branding] Error reloading frontend:", err);
  }
}

// Upload avatar
router.post(
  "/upload-avatar",
  requireManager,
  upload.single("avatar"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      // Determine paths
      const projectRoot = path.resolve(__dirname, "../../..");
      const dataDir = process.env.DATA_DIR || path.join(projectRoot, "data");
      const photosDir = path.join(dataDir, "photos");
      const iconsDir = path.join(dataDir, "icons");

      // Ensure directories exist
      if (!fs.existsSync(photosDir)) {
        fs.mkdirSync(photosDir, { recursive: true });
      }
      if (!fs.existsSync(iconsDir)) {
        fs.mkdirSync(iconsDir, { recursive: true });
      }

      // Use .png extension for consistency
      const avatarFilename = "avatar.png";
      const headerAvatarFilename = "avatar-header.webp";
      const avatarPath = path.join(photosDir, avatarFilename);
      const headerAvatarPath = path.join(photosDir, headerAvatarFilename);
      const faviconPngPath = path.join(iconsDir, "favicon.png");
      const faviconIcoPath = path.join(iconsDir, "favicon.ico");

      // Use Sharp to process the avatar image
      try {
        // Process and save avatar.png (512x512) for settings page display
        await sharp(file.path)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(512, 512, { fit: "cover" })
          .png()
          .toFile(avatarPath);

        // Generate header avatar (80x80 WebP) for fast header loading
        await sharp(file.path)
          .rotate()
          .resize(80, 80, { fit: "cover" })
          .webp({ quality: 85 })
          .toFile(headerAvatarPath);

        // Update icon files so they stay in sync with avatar
        const icon192Path = path.join(iconsDir, "icon-192.png");
        const icon512Path = path.join(iconsDir, "icon-512.png");
        const appleTouchIconPath = path.join(iconsDir, "apple-touch-icon.png");

        // Generate icon-192.png (192x192)
        await sharp(file.path)
          .rotate()
          .resize(192, 192, { fit: "cover" })
          .png()
          .toFile(icon192Path);

        // Generate icon-512.png (512x512)
        await sharp(file.path)
          .rotate()
          .resize(512, 512, { fit: "cover" })
          .png()
          .toFile(icon512Path);

        // Generate apple-touch-icon.png (192x192)
        await sharp(file.path)
          .rotate()
          .resize(192, 192, { fit: "cover" })
          .png()
          .toFile(appleTouchIconPath);

        // Create favicon.png (same as avatar)
        await sharp(file.path)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(512, 512, { fit: "cover" })
          .png()
          .toFile(faviconPngPath);

        // Generate favicon.ico (32x32) using Sharp
        await sharp(file.path)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(32, 32, { fit: "cover" })
          .toFormat("png")
          .toFile(faviconIcoPath);

        info("[Avatar Upload] Generated avatar.png, avatar-header.webp, icon files, and favicons");
      } catch (err: any) {
        error("[Avatar Upload] Failed to process avatar with Sharp:", err);
        res.status(500).json({ error: "Failed to process avatar image" });
        return;
      }

      // Clean up temp file
      fs.unlinkSync(file.path);

      // Update config
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (!config.branding) {
        config.branding = {};
      }
      const cacheBust = Date.now();
      config.branding.avatarPath = `/photos/${avatarFilename}`;
      config.branding.headerAvatarPath = `/photos/${headerAvatarFilename}`;
      config.branding.avatarCacheBust = cacheBust;
      config.branding.faviconPath = "/favicon.ico";

      // Write synchronously and force flush to disk
      const fd = fs.openSync(configPath, "w");
      fs.writeSync(fd, JSON.stringify(config, null, 2));
      fs.fsyncSync(fd); // Force flush to disk
      fs.closeSync(fd);

      // Verify the write succeeded
      const verifyConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (verifyConfig.branding?.avatarPath !== `/photos/${avatarFilename}`) {
        throw new Error("Avatar path verification failed after config update");
      }

      // Regenerate homepage HTML since avatar changed (affects meta tags and branding)
      const appRoot = req.app.get('appRoot');
      generateHomepageHTML(appRoot).then(result => {
        if (result.success) {
          info("[Avatar Upload] Homepage HTML regenerated after avatar change");
        } else {
          error("[Avatar Upload] Failed to regenerate homepage HTML:", result.error);
        }
      }).catch(err => {
        error("[Avatar Upload] Error regenerating homepage HTML:", err);
      });

      res.json({
        success: true,
        avatarPath: `/photos/${avatarFilename}`,
        headerAvatarPath: `/photos/${headerAvatarFilename}`,
        avatarCacheBust: cacheBust,
        faviconPath: "/favicon.ico",
      });
    } catch (err) {
      error("[Branding] Failed to upload avatar:", err);
      res.status(500).json({ error: "Failed to upload avatar" });
    }
  }
);

export default router;
