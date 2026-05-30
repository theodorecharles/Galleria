/**
 * Album Management Routes
 * Authenticated routes for creating, deleting albums and managing photos
 */

import { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import multer from "multer";
import os from "os";
import sharp from "sharp";
import { csrfProtection } from "../security.js";
import { requireAuth, requireAdmin, requireManager } from '../auth/middleware.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { getAllUsers } from '../database-users.js';
import { 
  deleteAlbumMetadata, 
  deleteImageMetadata, 
  saveAlbum, 
  deleteAlbumState,
  setAlbumPublished,
  setAlbumShowOnHomepage,
  setAlbumDescription,
  updateImageSortOrder,
  saveImageMetadata,
  updateAlbumSortOrder,
  getAlbumState,
  getDatabase,
  setAlbumFolder,
  getAlbumsInFolder,
  setFolderPublished,
  renameAlbum
} from "../database.js";
import { processVideo, VideoProcessingProgress } from "../utils/video-processor.js";
import { invalidateAlbumCache } from "./albums.js";
import { generateStaticJSONFiles } from "./static-json.js";
import { generateHomepageHTML } from "./homepage-html.js";
import { broadcastOptimizationUpdate, queueOptimizationJob } from "./optimization-stream.js";
import OpenAI from "openai";
import { error, warn, info, debug, verbose } from '../utils/logger.js';

const router = Router();
const execFileAsync = promisify(execFile);

// Apply CSRF protection to all routes in this router
router.use(csrfProtection);

/**
 * Helper to send push notification to all admin users
 */
async function notifyAllAdmins(title: string, body: string, tag: string, notificationType?: any, variables?: Record<string, any>): Promise<void> {
  try {
    const admins = getAllUsers().filter(u => u.role === 'admin');
    
    for (const admin of admins) {
      const translatedTitle = await translateNotification(title, variables);
      const translatedBody = await translateNotification(body, variables);
      
      await sendNotificationToUser(admin.id, {
        title: translatedTitle,
        body: translatedBody,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag,
        requireInteraction: false
      }, notificationType);
    }
  } catch (err) {
    error('[AlbumManagement] Failed to send admin notification:', err);
  }
}

/**
 * Track photo uploads for large batch detection
 */
interface UploadBatch {
  album: string;
  uploads: Array<{ timestamp: number; user: string }>;
  notified: boolean;
}

const uploadBatches = new Map<string, UploadBatch>();
const LARGE_UPLOAD_THRESHOLD = 50; // 50 photos
const BATCH_WINDOW = 5 * 60 * 1000; // 5 minutes

// Clean up old upload tracking every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [album, batch] of uploadBatches.entries()) {
    const lastUpload = batch.uploads[batch.uploads.length - 1]?.timestamp || 0;
    if (now - lastUpload > BATCH_WINDOW) {
      uploadBatches.delete(album);
    }
  }
}, 10 * 60 * 1000);

/**
 * Track upload and send notification if batch threshold reached
 */
async function trackPhotoUpload(album: string, userName: string): Promise<void> {
  const now = Date.now();
  let batch = uploadBatches.get(album);
  
  if (!batch) {
    batch = { album, uploads: [], notified: false };
    uploadBatches.set(album, batch);
  }
  
  // Remove old uploads outside the time window
  batch.uploads = batch.uploads.filter(u => now - u.timestamp < BATCH_WINDOW);
  
  // Add current upload
  batch.uploads.push({ timestamp: now, user: userName });
  
  // Send notification if threshold reached and not already notified
  if (batch.uploads.length >= LARGE_UPLOAD_THRESHOLD && !batch.notified) {
    batch.notified = true;
    
    try {
      await notifyAllAdmins(
        'notifications.backend.largePhotoUploadTitle',
        'notifications.backend.largePhotoUploadBody',
        'large-photo-upload',
        'largePhotoUpload',
        {
          uploadedBy: userName,
          photoCount: batch.uploads.length,
          albumName: album
        }
      );
      info(`[AlbumManagement] Large upload notification sent: ${batch.uploads.length} photos to ${album}`);
    } catch (err) {
      error('[AlbumManagement] Failed to send large upload notification:', err);
    }
  }
}

/**
 * Convert text to title case
 * Capitalizes first letter of each word, except for common small words (unless first/last)
 */
function toTitleCase(str: string): string {
  const smallWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with'
  ]);
  
  const words = str.split(' ');
  
  return words.map((word, index) => {
    // Always capitalize first and last word
    if (index === 0 || index === words.length - 1) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    
    // Keep small words lowercase
    const lowerWord = word.toLowerCase();
    if (smallWords.has(lowerWord)) {
      return lowerWord;
    }
    
    // Capitalize other words
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

/**
 * Generate AI title for a single image (async, broadcasts to optimization stream)
 */
async function generateAITitleForImageAsync(
  apiKey: string,
  album: string,
  filename: string,
  projectRoot: string,
  jobId: string,
  language: string = 'en'
): Promise<void> {
  try {
    const openai = new OpenAI({ apiKey });
    const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
    const photosDir = path.join(dataDir, 'photos');
    const imagePath = path.join(photosDir, album, filename);

    if (!fs.existsSync(imagePath)) {
      throw new Error('Image not found');
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const extension = path.extname(filename).toLowerCase().substring(1);
    const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;

    // Language names for prompt
    const languageNames: Record<string, string> = {
      en: 'English',
      ja: 'Japanese',
      es: 'Spanish',
      fr: 'French',
      de: 'German',
      it: 'Italian',
      pt: 'Portuguese',
      ru: 'Russian',
      zh: 'Chinese',
      ko: 'Korean',
      nl: 'Dutch',
      pl: 'Polish',
      tr: 'Turkish',
      sv: 'Swedish',
      no: 'Norwegian',
      ro: 'Romanian',
      vi: 'Vietnamese',
      id: 'Indonesian',
      tl: 'Tagalog'
    };
    
    const languageName = languageNames[language] || 'English';
    const promptText = `Generate a concise, descriptive title for this image in ${languageName}. The title should be 3-8 words and capture the essence of the image. Output ONLY the title in ${languageName}, nothing else.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: "low"
              }
            }
          ]
        }
      ],
      max_tokens: 50
    });

    let title = response.choices[0]?.message?.content?.trim() || '';

    // Clean the title: remove quotes and convert to title case
    title = title.replace(/^["']|["']$/g, '');
    title = title.trim();
    title = toTitleCase(title);

    // Update database
    saveImageMetadata(album, filename, title, null);

    // Broadcast success
    broadcastOptimizationUpdate(jobId, {
      album,
      filename,
      progress: 100,
      state: 'complete',
      title
    });

    // info(`AI title generated for ${album}/${filename}: "${title}"`);
  } catch (err: any) {
    error(`AI title generation failed for ${album}/${filename}:`, err);
    broadcastOptimizationUpdate(jobId, {
      album,
      filename,
      progress: 100,
      state: 'complete',
      error: `AI error: ${err.message}`
    });
  }
}

/**
 * Generate AI title for a single image (legacy SSE version)
 */
async function generateAITitleForImage(
  apiKey: string,
  album: string,
  filename: string,
  projectRoot: string,
  res: Response
): Promise<void> {
  try {
    const openai = new OpenAI({ apiKey });
    
    // Path to the thumbnail image
    const thumbnailPath = path.join(projectRoot, 'optimized', 'thumbnail', album, filename);
    
    if (!fs.existsSync(thumbnailPath)) {
      res.write(`data: ${JSON.stringify({ 
        type: 'ai-error', 
        filename,
        error: 'Thumbnail not found' 
      })}\n\n`);
      return;
    }
    
    // Read the thumbnail image and convert to base64
    const imageBuffer = fs.readFileSync(thumbnailPath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = thumbnailPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    
    res.write(`data: ${JSON.stringify({ 
      type: 'ai-processing', 
      filename 
    })}\n\n`);
    
    // Call OpenAI Vision API
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Generate a short, descriptive title for this photograph (maximum 8 words). Be specific and descriptive, capturing the key subject and mood. Return only the title, no quotes or extra text."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: "low"
              }
            }
          ]
        }
      ],
      max_tokens: 50
    });
    
    let title = response.choices[0]?.message?.content?.trim();
    
    if (!title) {
      res.write(`data: ${JSON.stringify({ 
        type: 'ai-error', 
        filename,
        error: 'Empty response from OpenAI' 
      })}\n\n`);
      return;
    }
    
    // Remove surrounding quotes if present
    title = title.replace(/^["']|["']$/g, '');
    title = title.trim();
    
    // Save to database
    saveImageMetadata(album, filename, title, null);
    
    res.write(`data: ${JSON.stringify({ 
      type: 'ai-complete', 
      filename,
      title 
    })}\n\n`);
    
  } catch (err: any) {
    error(`Error generating AI title for ${album}/${filename}:`, err);
    res.write(`data: ${JSON.stringify({ 
      type: 'ai-error', 
      filename,
      error: err.message || 'Failed to generate AI title' 
    })}\n\n`);
  }
}

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // Use temp directory for initial upload
      cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
      // Keep original filename
      cb(null, file.originalname);
    }
  }),
  limits: {
    // No file size limit - allow uploads of any size
    fieldSize: 10 * 1024, // 10KB for field values (form data)
    fields: 10 // Maximum 10 non-file fields
  },
  fileFilter: (req, file, cb) => {
    // Allow image and video files
    if (file.mimetype.match(/^image\/(jpeg|jpg|png|gif)$/) || file.mimetype.match(/^video\/(mp4|quicktime|x-msvideo|x-matroska|webm)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  }
});

const cleanupUploadedTempFile = async (file?: Express.Multer.File): Promise<void> => {
  if (!file?.path) {
    return;
  }

  try {
    await fs.promises.unlink(file.path);
  } catch (err: any) {
    error(`[Upload] Failed to clean up temp file ${file.path}:`, err.message);
  }
};

// Get the current directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Sanitize album/photo name - allows letters, numbers, spaces, hyphens, and underscores
 */
const sanitizeName = (name: string): string | null => {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return null;
  }
  // Allow alphanumeric characters, spaces, hyphens, and underscores
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
    return null;
  }
  return name.trim();
};

/**
 * Sanitize photo/video filename by removing/replacing invalid characters
 * Converts to Title Case for consistency
 */
const sanitizePhotoName = (name: string): string | null => {
  if (!name) {
    return null;
  }
  
  // Block path traversal attempts
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return null;
  }
  
  // Extract extension
  const lastDotIndex = name.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return null; // No extension
  }
  
  const extension = name.substring(lastDotIndex + 1).toLowerCase();
  const validExtensions = ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'avi', 'mkv', 'webm'];
  
  if (!validExtensions.includes(extension)) {
    return null; // Invalid extension
  }
  
  let baseName = name.substring(0, lastDotIndex);
  
  // Replace special characters with spaces or remove them
  baseName = baseName
    .replace(/[&,]/g, ' and ') // & and , become "and"
    .replace(/[@#$%]/g, '') // Remove symbols
    .replace(/[()[\]]/g, '') // Remove brackets
    .replace(/[_-]/g, ' ') // Underscores and hyphens become spaces
    .replace(/[^a-zA-Z0-9 ]/g, '') // Remove any other special chars
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
  
  if (!baseName) {
    return null; // Nothing left after sanitization
  }
  
  // Convert to Title Case
  baseName = baseName
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  
  return `${baseName}.${extension}`;
};

/**
 * Check if a file is a video based on extension
 */
const isVideoFile = (filename: string): boolean => {
  return /\.(mp4|mov|avi|mkv|webm)$/i.test(filename);
};

const isPathWithinDirectory = (baseDir: string, targetPath: string): boolean => {
  const relativePath = path.relative(baseDir, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
};

/**
 * Create a new album
 */
router.post("/", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, folder_id } = req.body;
    
    if (!name) {
      res.status(400).json({ error: 'Album name is required' });
      return;
    }

    const sanitizedName = sanitizeName(name);
    if (!sanitizedName) {
      res.status(400).json({ error: 'Invalid album name. Use only letters, numbers, spaces, hyphens, and underscores.' });
      return;
    }

    // Prevent "homepage" as an album name (reserved for homepage feature)
    if (sanitizedName.toLowerCase() === 'homepage') {
      res.status(400).json({ 
        error: 'RESERVED_NAME',
        message: 'The name "homepage" is reserved for the homepage feature. Use the homepage toggle on individual albums instead.' 
      });
      return;
    }

    const photosDir = req.app.get("photosDir");
    const albumPath = path.join(photosDir, sanitizedName);

    if (fs.existsSync(albumPath)) {
      res.status(400).json({ error: 'Album already exists' });
      return;
    }

    // Create album directory
    fs.mkdirSync(albumPath, { recursive: true });

    // Create album in database as unpublished by default
    saveAlbum(sanitizedName, false);
    info(`Created unpublished album: ${sanitizedName}`);
    
    // Set folder if provided
    if (folder_id !== undefined && folder_id !== null) {
      setAlbumFolder(sanitizedName, folder_id);
      info(`Assigned album "${sanitizedName}" to folder ID: ${folder_id}`);
    }

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.albumCreatedTitle',
      'notifications.backend.albumCreatedBody',
      'album-created',
      'albumCreated',
      {
        albumName: sanitizedName,
        createdBy: (req.user as any).name || (req.user as any).email
      }
    ).catch(err => error('[AlbumManagement] Failed to send album creation notification:', err));

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);

    res.json({ success: true, album: sanitizedName });
  } catch (err) {
    error('[AlbumManagement] Failed to create album:', err);
    res.status(500).json({ error: 'Failed to create album' });
  }
});

/**
 * Rename an album
 */
router.put("/:album/rename", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    const { newName } = req.body;
    
    const sanitizedOldName = sanitizeName(album);
    if (!sanitizedOldName) {
      res.status(400).json({ errorCode: 'INVALID_ALBUM_NAME', error: 'Invalid album name' });
      return;
    }
    
    if (!newName || typeof newName !== 'string') {
      res.status(400).json({ errorCode: 'NAME_REQUIRED', error: 'New name is required' });
      return;
    }
    
    const sanitizedNewName = sanitizeName(newName);
    if (!sanitizedNewName) {
      res.status(400).json({ errorCode: 'INVALID_NEW_NAME', error: 'Invalid new album name' });
      return;
    }
    
    if (sanitizedOldName === sanitizedNewName) {
      res.status(400).json({ errorCode: 'NAME_UNCHANGED', error: 'New name is the same as old name' });
      return;
    }
    
    const photosDir = req.app.get("photosDir");
    const optimizedDir = req.app.get("optimizedDir");
    
    const oldAlbumPath = path.join(photosDir, sanitizedOldName);
    const newAlbumPath = path.join(photosDir, sanitizedNewName);
    
    // Check if old album exists
    if (!fs.existsSync(oldAlbumPath)) {
      res.status(404).json({ errorCode: 'ALBUM_NOT_FOUND', error: 'Album not found' });
      return;
    }
    
    // Check if new name already exists
    if (fs.existsSync(newAlbumPath)) {
      res.status(409).json({ errorCode: 'ALBUM_EXISTS', error: 'An album with that name already exists' });
      return;
    }
    
    // Rename photos directory
    fs.renameSync(oldAlbumPath, newAlbumPath);
    info(`[AlbumManagement] Renamed photos directory: ${sanitizedOldName} → ${sanitizedNewName}`);
    
    // Rename optimized directories
    ['thumbnail', 'modal', 'download'].forEach(dir => {
      const oldOptimizedPath = path.join(optimizedDir, dir, sanitizedOldName);
      const newOptimizedPath = path.join(optimizedDir, dir, sanitizedNewName);
      if (fs.existsSync(oldOptimizedPath)) {
        fs.renameSync(oldOptimizedPath, newOptimizedPath);
      }
    });
    
    // Rename video directory if it exists
    const videoDir = req.app.get("videoDir");
    let videoRenamed = false;
    if (videoDir) {
      const oldVideoPath = path.join(videoDir, sanitizedOldName);
      const newVideoPath = path.join(videoDir, sanitizedNewName);
      if (fs.existsSync(oldVideoPath)) {
        fs.renameSync(oldVideoPath, newVideoPath);
        videoRenamed = true;
        info(`[AlbumManagement] Renamed video directory: ${sanitizedOldName} → ${sanitizedNewName}`);
      }
    }
    
    // Update database
    const success = renameAlbum(sanitizedOldName, sanitizedNewName);
    if (!success) {
      // Rollback filesystem changes
      fs.renameSync(newAlbumPath, oldAlbumPath);
      ['thumbnail', 'modal', 'download'].forEach(dir => {
        const oldOptimizedPath = path.join(optimizedDir, dir, sanitizedOldName);
        const newOptimizedPath = path.join(optimizedDir, dir, sanitizedNewName);
        if (fs.existsSync(newOptimizedPath)) {
          fs.renameSync(newOptimizedPath, oldOptimizedPath);
        }
      });
      // Rollback video directory if it was renamed
      if (videoRenamed && videoDir) {
        const oldVideoPath = path.join(videoDir, sanitizedOldName);
        const newVideoPath = path.join(videoDir, sanitizedNewName);
        if (fs.existsSync(newVideoPath)) {
          fs.renameSync(newVideoPath, oldVideoPath);
        }
      }
      res.status(500).json({ errorCode: 'DATABASE_UPDATE_FAILED', error: 'Failed to update database' });
      return;
    }
    
    info(`[AlbumManagement] Renamed album in database: ${sanitizedOldName} → ${sanitizedNewName}`);
    
    // Invalidate cache for both old and new names
    invalidateAlbumCache(sanitizedOldName);
    invalidateAlbumCache(sanitizedNewName);
    
    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    res.json({ success: true, newName: sanitizedNewName });
  } catch (err) {
    error('[AlbumManagement] Failed to rename album:', err);
    res.status(500).json({ errorCode: 'RENAME_FAILED', error: 'Failed to rename album' });
  }
});

/**
 * Delete an album and all its photos
 */
router.delete("/:album", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    const photosDir = req.app.get("photosDir");
    const optimizedDir = req.app.get("optimizedDir");
    
    const albumPath = path.join(photosDir, sanitizedAlbum);
    
    // Delete from photos directory (if it exists)
    if (fs.existsSync(albumPath)) {
      fs.rmSync(albumPath, { recursive: true, force: true });
      info(`[AlbumManagement] Deleted directory: ${sanitizedAlbum}`);
    } else {
      info(`[AlbumManagement] Directory not found (already deleted?): ${sanitizedAlbum}`);
    }

    // Delete from optimized directory (if exists)
    ['thumbnail', 'modal', 'download'].forEach(dir => {
      const optimizedPath = path.join(optimizedDir, dir, sanitizedAlbum);
      if (fs.existsSync(optimizedPath)) {
        fs.rmSync(optimizedPath, { recursive: true, force: true });
      }
    });

    // Delete from video directory (if exists)
    const videoDir = req.app.get("videoDir");
    if (videoDir) {
      const videoPath = path.join(videoDir, sanitizedAlbum);
      if (fs.existsSync(videoPath)) {
        fs.rmSync(videoPath, { recursive: true, force: true });
        info(`[AlbumManagement] Deleted video directory: ${sanitizedAlbum}`);
      }
    }

    // Cancel share link expiry timers before deleting (cascade delete will remove share links)
    try {
      const { getShareLinksForAlbum } = await import('../database.js');
      const { cancelShareLinkExpiryTimer } = await import('../services/share-link-expiry-tracker.js');
      const existingLinks = getShareLinksForAlbum(sanitizedAlbum);
      for (const link of existingLinks) {
        cancelShareLinkExpiryTimer(link.id);
      }
      if (existingLinks.length > 0) {
        info(`[AlbumManagement] Cancelled ${existingLinks.length} share link expiry timer(s)`);
      }
    } catch (err) {
      error('[AlbumManagement] Failed to cancel share link timers:', err);
    }

    // Delete all metadata for this album from database
    const deletedCount = deleteAlbumMetadata(sanitizedAlbum);
    info(`[AlbumManagement] Deleted ${deletedCount} metadata entries for album: ${sanitizedAlbum}`);

    // Delete album state from database (cascade delete will also remove share_links)
    const albumDeleted = deleteAlbumState(sanitizedAlbum);
    if (albumDeleted) {
      info(`[AlbumManagement] Deleted album state for: ${sanitizedAlbum}`);
    } else {
      info(`[AlbumManagement] Album state not found in database: ${sanitizedAlbum}`);
    }

    // Send push notification to all admins
    await notifyAllAdmins(
      'notifications.backend.albumDeletedTitle',
      'notifications.backend.albumDeletedBody',
      'album-deleted',
      'albumDeleted',
      {
        albumName: sanitizedAlbum,
        deletedBy: (req.user as any).name || (req.user as any).email
      }
    ).catch(err => error('[AlbumManagement] Failed to send album deletion notification:', err));

    // Invalidate cache for this album
    invalidateAlbumCache(sanitizedAlbum);

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    // Regenerate homepage HTML (in case deleted album was on homepage)
    generateHomepageHTML(appRoot);
    info(`[AlbumManagement] Regenerated homepage HTML after album deletion`);

    res.json({ success: true });
  } catch (err) {
    error('[AlbumManagement] Failed to delete album:', err);
    res.status(500).json({ error: 'Failed to delete album' });
  }
});

/**
 * Delete a photo from an album
 */
router.delete("/:album/photos/:photo", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album, photo } = req.params;
    
    const sanitizedAlbum = sanitizeName(album);
    const sanitizedPhoto = sanitizePhotoName(photo);
    
    if (!sanitizedAlbum || !sanitizedPhoto) {
      res.status(400).json({ error: 'Invalid album or photo name' });
      return;
    }

    const photosDir = req.app.get("photosDir");
    const optimizedDir = req.app.get("optimizedDir");
    const videoDir = req.app.get("videoDir");

    const photoPath = path.join(photosDir, sanitizedAlbum, sanitizedPhoto);

    if (!fs.existsSync(photoPath)) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    // Delete from photos directory
    fs.unlinkSync(photoPath);

    if (isVideoFile(sanitizedPhoto)) {
      // Videos store their optimized posters as .jpg (not the original .mp4 name)
      const posterName = sanitizedPhoto.replace(/\.[^.]+$/, '.jpg');
      ['thumbnail', 'modal', 'download'].forEach(dir => {
        const posterPath = path.join(optimizedDir, dir, sanitizedAlbum, posterName);
        if (fs.existsSync(posterPath)) {
          fs.unlinkSync(posterPath);
        }
      });

      // Remove the per-video HLS output (master.m3u8, per-resolution playlists, .ts segments).
      // The HLS folder is named with the full filename, matching processVideo / the video route.
      if (videoDir) {
        const hlsPath = path.join(videoDir, sanitizedAlbum, sanitizedPhoto);
        fs.rmSync(hlsPath, { recursive: true, force: true });
      }
    } else {
      // Delete from optimized directories
      ['thumbnail', 'modal', 'download'].forEach(dir => {
        const optimizedPath = path.join(optimizedDir, dir, sanitizedAlbum, sanitizedPhoto);
        if (fs.existsSync(optimizedPath)) {
          fs.unlinkSync(optimizedPath);
        }
      });
    }

    // Delete metadata from database
    const deleted = deleteImageMetadata(sanitizedAlbum, sanitizedPhoto);
    if (deleted) {
      info(`Deleted metadata for photo: ${sanitizedAlbum}/${sanitizedPhoto}`);
    }

    // Invalidate cache for this album
    invalidateAlbumCache(sanitizedAlbum);

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    // Check if this album is on homepage and regenerate homepage HTML if needed
    const albumState = getAlbumState(sanitizedAlbum);
    if (albumState?.show_on_homepage) {
      info(`[AlbumManagement] Photo deleted from homepage album - regenerating homepage HTML`);
      generateHomepageHTML(appRoot);
    }

    res.json({ success: true });
  } catch (err) {
    error('[AlbumManagement] Failed to delete photo:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

/**
 * Upload a single photo or video to an album with SSE progress updates
 */
router.post("/:album/upload", requireManager, (req: Request, res: Response, next: NextFunction) => {
  // Handle Multer errors before the upload middleware
  upload.single('photo')(req, res, (err: any) => {
    if (err) {
      // Multer errors are client errors (400), not server errors (500)
      if (err.code === 'LIMIT_FILE_SIZE') {
        // This should never happen since we removed the file size limit
        error(`[Upload] File too large (unexpected): ${req.file?.originalname || 'unknown'}`);
        return res.status(400).json({ 
          error: `File upload error: ${err.message}`,
          code: 'LIMIT_FILE_SIZE'
        });
      }
      if (err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FIELD_KEY') {
        error(`[Upload] Form field error: ${err.message}`);
        return res.status(400).json({ 
          error: 'Invalid form data',
          code: err.code
        });
      }
      // Other Multer errors
      error(`[Upload] Multer error: ${err.message}`);
      return res.status(400).json({ 
        error: err.message || 'File upload error',
        code: err.code
      });
    }
    next();
  });
}, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    const { language = 'en' } = req.body;
    const file = req.file as Express.Multer.File | undefined;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      await cleanupUploadedTempFile(file);
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // SECURITY: Sanitize filename to prevent path traversal attacks
    const sanitizedFilename = sanitizePhotoName(file.originalname);
    if (!sanitizedFilename) {
      await cleanupUploadedTempFile(file);
      res.status(400).json({ error: 'Invalid filename. Use only alphanumeric characters, spaces, hyphens, underscores, and valid image/video extensions.' });
      return;
    }

    const photosDir = req.app.get("photosDir");
    const albumPath = path.join(photosDir, sanitizedAlbum);
    
    if (!fs.existsSync(albumPath)) {
      await cleanupUploadedTempFile(file);
      res.status(404).json({ error: 'Album not found' });
      return;
    }

    const destPath = path.join(albumPath, sanitizedFilename);
    const isVideo = isVideoFile(sanitizedFilename);
    const mediaType = isVideo ? 'video' : 'photo';
    
    if (isVideo) {
      // For videos, copy file then delete temp (rename doesn't work across filesystems in Docker)
      try {
        await fs.promises.copyFile(file.path, destPath);
        await fs.promises.unlink(file.path);
      } catch (err: any) {
        error(`[Upload] Failed to move video ${file.originalname}:`, err.message);
        try {
          fs.unlinkSync(file.path);
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
        res.status(500).json({ error: `Failed to save video: ${err.message}` });
        return;
      }
    } else {
      // For images, use sharp to auto-rotate based on EXIF orientation
      try {
        const sharpTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Sharp processing timeout')), 120000) // 2 minute timeout
        );
        
        await Promise.race([
          sharp(file.path)
            .rotate() // Auto-rotate based on EXIF
            .toFile(destPath),
          sharpTimeout
        ]);
    
        // Clean up temp file
        fs.unlinkSync(file.path);
      } catch (err: any) {
        error(`[Upload] Failed to process ${file.originalname}:`, err.message);
        try {
          fs.unlinkSync(file.path);
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
        res.status(500).json({ error: `Failed to save file: ${err.message}` });
        return;
      }
    }

    // Track photo upload for large batch detection (photos only, not videos)
    if (!isVideo) {
      const userName = (req.session as any)?.user?.name || 'Unknown User';
      trackPhotoUpload(sanitizedAlbum, userName).catch(err => {
        error('[AlbumManagement] Failed to track photo upload:', err);
      });
    }

    // Send success response immediately (don't keep connection open)
    res.json({ success: true, filename: sanitizedFilename, mediaType });

    const projectRoot = path.resolve(__dirname, '../../../');
    const jobId = `${sanitizedAlbum}/${sanitizedFilename}`;

    if (isVideo) {
      // Process video: rotation, HLS encoding, thumbnails
      (async () => {
        try {
          const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
          
          await processVideo(
            destPath,
            sanitizedAlbum,
            sanitizedFilename,
            dataDir,
            (update: VideoProcessingProgress) => {
              broadcastOptimizationUpdate(jobId, {
                album: sanitizedAlbum,
                filename: sanitizedFilename,
                progress: update.progress,
                state: update.stage,
                message: update.message
              });
            }
          );

          // Add video to database
          saveImageMetadata(sanitizedAlbum, sanitizedFilename, null, null, 'video');

          broadcastOptimizationUpdate(jobId, {
            album: sanitizedAlbum,
            filename: sanitizedFilename,
            progress: 100,
            state: 'complete'
          });

          // Regenerate static JSON
          try {
            info(`[AlbumManagement] Video uploaded to album "${sanitizedAlbum}" - regenerating static JSON`);
            const appRoot = req.app.get('appRoot');
            generateStaticJSONFiles(appRoot);
            invalidateAlbumCache();
            
            // Check if this album is on homepage and regenerate homepage HTML if needed
            const albumState = getAlbumState(sanitizedAlbum);
            if (albumState?.show_on_homepage) {
              info(`[AlbumManagement] Video uploaded to homepage album - regenerating homepage HTML`);
              generateHomepageHTML(appRoot);
            }
          } catch (err) {
            error('[AlbumManagement] Failed to regenerate static JSON after video upload:', err);
          }
        } catch (err: any) {
          error('[AlbumManagement] Video processing failed:', err);
          broadcastOptimizationUpdate(jobId, {
            album: sanitizedAlbum,
            filename: sanitizedFilename,
            progress: 0,
            state: 'error',
            error: err.message || 'Video processing failed'
          });
        }
      })();
    } else {
      // Queue image optimization job (will process sequentially)
      const scriptPath = path.join(projectRoot, 'scripts', 'optimize_new_image.js');

      if (fs.existsSync(scriptPath)) {
        queueOptimizationJob(
          jobId,
          sanitizedAlbum,
          sanitizedFilename,
          scriptPath,
          projectRoot,
          // onProgress callback
          (progress: number) => {
            broadcastOptimizationUpdate(jobId, {
              album: sanitizedAlbum,
              filename: sanitizedFilename,
              progress,
              state: 'optimizing'
            });
          },
          // onComplete callback
          async () => {
            // Add image to database (with null title initially)
            saveImageMetadata(sanitizedAlbum, sanitizedFilename, null, null, 'photo');
            
            broadcastOptimizationUpdate(jobId, {
              album: sanitizedAlbum,
              filename: sanitizedFilename,
              progress: 100,
              state: 'complete'
            });
            
            // Check if auto-generate AI titles is enabled (only for photos)
            try {
              const dataDir = process.env.DATA_DIR || path.join(projectRoot, 'data');
              const configPath = path.join(dataDir, 'config.json');
              const configData = fs.readFileSync(configPath, 'utf8');
              const config = JSON.parse(configData);
              
              if (config.ai?.autoGenerateTitlesOnUpload && config.openai?.apiKey) {
                broadcastOptimizationUpdate(jobId, {
                  album: sanitizedAlbum,
                  filename: sanitizedFilename,
                  progress: 100,
                  state: 'generating-title'
                });
                
                await generateAITitleForImageAsync(
                  config.openai.apiKey,
                  sanitizedAlbum,
                  sanitizedFilename,
                  projectRoot,
                  jobId,
                  language
                );
              }
            } catch (err) {
              error('[AlbumManagement] Failed with AI title generation:', err);
            }
            
            // Regenerate static JSON
            try {
              info(`[AlbumManagement] Photo uploaded to album "${sanitizedAlbum}" - regenerating static JSON`);
              const appRoot = req.app.get('appRoot');
              generateStaticJSONFiles(appRoot);
              invalidateAlbumCache();
              
              // Check if this album is on homepage and regenerate homepage HTML if needed
              const albumState = getAlbumState(sanitizedAlbum);
              if (albumState?.show_on_homepage) {
                info(`[AlbumManagement] Photo uploaded to homepage album - regenerating homepage HTML`);
                generateHomepageHTML(appRoot);
              }
            } catch (err) {
              error('[AlbumManagement] Failed to regenerate static JSON after photo upload:', err);
            }
          },
          // onError callback
          (error: string) => {
            broadcastOptimizationUpdate(jobId, {
              album: sanitizedAlbum,
              filename: sanitizedFilename,
              progress: 0,
              state: 'error',
              error
            });
          }
        );
      } else {
        broadcastOptimizationUpdate(jobId, {
          album: sanitizedAlbum,
          filename: sanitizedFilename,
          progress: 0,
          state: 'error',
          error: 'Optimization script not found'
        });
      }
    }
  } catch (err) {
    error('[AlbumManagement] Failed to upload file:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

/**
 * Rename an album (updates database and moves directories)
 */
router.patch("/:album/rename", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    const { newName } = req.body;
    
    const sanitizedOldName = sanitizeName(album);
    if (!sanitizedOldName) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    if (!newName || typeof newName !== 'string') {
      res.status(400).json({ error: 'New album name is required' });
      return;
    }

    const sanitizedNewName = sanitizeName(newName);
    if (!sanitizedNewName) {
      res.status(400).json({ error: 'Invalid new album name. Use only letters, numbers, spaces, hyphens, and underscores.' });
      return;
    }

    // Check if old album name equals new album name
    if (sanitizedOldName === sanitizedNewName) {
      res.status(400).json({ error: 'New name must be different from current name' });
      return;
    }

    const photosDir = req.app.get("photosDir");
    const optimizedDir = req.app.get("optimizedDir");
    
    const oldAlbumPath = path.join(photosDir, sanitizedOldName);
    const newAlbumPath = path.join(photosDir, sanitizedNewName);
    
    // Check if old album exists
    if (!fs.existsSync(oldAlbumPath)) {
      res.status(404).json({ error: 'Album not found' });
      return;
    }

    // Check if new album name already exists
    if (fs.existsSync(newAlbumPath)) {
      res.status(400).json({ error: 'An album with that name already exists' });
      return;
    }

    // Get album state before renaming
    const albumState = getAlbumState(sanitizedOldName);
    if (!albumState) {
      res.status(404).json({ error: 'Album not found in database' });
      return;
    }

    // Rename filesystem directories FIRST, tracking each successful rename
    // so we can roll back on a later filesystem or database failure. This
    // keeps the album consistent across DB and disk: either every rename
    // sticks or none of them do.
    const renamedPaths: Array<{ from: string; to: string }> = [];
    const rollbackFsRenames = () => {
      for (const { from, to } of [...renamedPaths].reverse()) {
        try {
          if (fs.existsSync(to)) {
            fs.renameSync(to, from);
          }
        } catch (rollbackErr) {
          error('[AlbumManagement] Failed to rollback filesystem rename', { from, to, err: rollbackErr });
        }
      }
    };

    const videoDir = req.app.get("videoDir");

    try {
      // Rename photos directory
      fs.renameSync(oldAlbumPath, newAlbumPath);
      renamedPaths.push({ from: oldAlbumPath, to: newAlbumPath });
      info(`Renamed photos directory: ${sanitizedOldName} -> ${sanitizedNewName}`);

      // Rename optimized directories
      for (const dir of ['thumbnail', 'modal', 'download']) {
        const oldOptimizedPath = path.join(optimizedDir, dir, sanitizedOldName);
        const newOptimizedPath = path.join(optimizedDir, dir, sanitizedNewName);
        if (fs.existsSync(oldOptimizedPath)) {
          fs.renameSync(oldOptimizedPath, newOptimizedPath);
          renamedPaths.push({ from: oldOptimizedPath, to: newOptimizedPath });
          info(`Renamed optimized/${dir}: ${sanitizedOldName} -> ${sanitizedNewName}`);
        }
      }

      // Rename video directory if it exists
      if (videoDir) {
        const oldVideoPath = path.join(videoDir, sanitizedOldName);
        const newVideoPath = path.join(videoDir, sanitizedNewName);
        if (fs.existsSync(oldVideoPath)) {
          fs.renameSync(oldVideoPath, newVideoPath);
          renamedPaths.push({ from: oldVideoPath, to: newVideoPath });
          info(`Renamed video directory: ${sanitizedOldName} -> ${sanitizedNewName}`);
        }
      }
    } catch (fsErr) {
      error('[AlbumManagement] Filesystem rename failed, rolling back partial renames', fsErr);
      rollbackFsRenames();
      res.status(500).json({ error: 'Failed to rename album directories' });
      return;
    }

    // Update database after all filesystem renames have succeeded.
    // If the transaction throws, roll back every filesystem rename so the
    // album is left in its original on-disk state.
    const db = getDatabase();

    // share_links.album has ON UPDATE CASCADE (see database.ts), so renaming
    // the album row cascades automatically. The explicit share_links UPDATE
    // below is kept as a safety net for older databases that pre-date the
    // share_links_on_update_cascade schema migration (see migrations.ts).
    const transaction = db.transaction(() => {
      // Update albums table
      const result = db.prepare(`
        UPDATE albums
        SET name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE name = ?
      `).run(sanitizedNewName, sanitizedOldName);

      if (result.changes === 0) {
        throw new Error('Album not found in database');
      }

      // Update image_metadata table
      db.prepare(`
        UPDATE image_metadata
        SET album = ?, updated_at = CURRENT_TIMESTAMP
        WHERE album = ?
      `).run(sanitizedNewName, sanitizedOldName);

      // Update share_links table
      db.prepare(`
        UPDATE share_links
        SET album = ?
        WHERE album = ?
      `).run(sanitizedNewName, sanitizedOldName);
    });

    try {
      transaction();
      info(`Updated database: ${sanitizedOldName} -> ${sanitizedNewName}`);
    } catch (dbErr) {
      error('[AlbumManagement] Database transaction failed, rolling back filesystem renames', dbErr);
      rollbackFsRenames();
      res.status(500).json({ error: 'Failed to update database' });
      return;
    }

    // Invalidate cache for both old and new album names
    invalidateAlbumCache(sanitizedOldName);
    invalidateAlbumCache(sanitizedNewName);

    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);

    res.json({ 
      success: true, 
      oldName: sanitizedOldName,
      newName: sanitizedNewName
    });
  } catch (err) {
    error('[AlbumManagement] Failed to rename album:', err);
    res.status(500).json({ error: 'Failed to rename album' });
  }
});

/**
 * Toggle album published state
 */
router.patch("/:album/publish", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    const { published } = req.body;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    if (typeof published !== 'boolean') {
      res.status(400).json({ error: 'Published state must be a boolean' });
      return;
    }

    const photosDir = req.app.get("photosDir");
    const albumPath = path.join(photosDir, sanitizedAlbum);
    
    if (!fs.existsSync(albumPath)) {
      res.status(404).json({ error: 'Album not found' });
      return;
    }

    // Update or create album state
    saveAlbum(sanitizedAlbum, published);
    info(`[AlbumManagement] Set album "${sanitizedAlbum}" published state to: ${published}`);
    
    // Verify the state was saved correctly
    const albumState = getAlbumState(sanitizedAlbum);
    if (!albumState) {
      error(`[AlbumManagement] Failed to save album state for "${sanitizedAlbum}"`);
      res.status(500).json({ error: 'Failed to save album state' });
      return;
    }
    info(`[AlbumManagement] Verified album state in DB: published=${albumState.published}`);

    // Send push notification to all admins
    const userName = (req.user as any).name || (req.user as any).email;
    if (published) {
      await notifyAllAdmins(
        'notifications.backend.albumPublishedTitle',
        'notifications.backend.albumPublishedBody',
        'album-published',
        'albumPublished',
        {
          albumName: sanitizedAlbum,
          publishedBy: userName
        }
      ).catch(err => error('[AlbumManagement] Failed to send album publish notification:', err));
    } else {
      await notifyAllAdmins(
        'notifications.backend.albumUnpublishedTitle',
        'notifications.backend.albumUnpublishedBody',
        'album-unpublished',
        'albumUnpublished',
        {
          albumName: sanitizedAlbum,
          unpublishedBy: userName
        }
      ).catch(err => error('[AlbumManagement] Failed to send album unpublish notification:', err));
    }

    // Regenerate static JSON files
    info(`[Publish] Regenerating static JSON files...`);
    const appRoot = req.app.get('appRoot');
    const result = await generateStaticJSONFiles(appRoot);
    if (result.success) {
      info(`[Publish] Static JSON regenerated (${result.albumCount} albums)`);
    } else {
      error(`[Publish] Failed to regenerate static JSON:`, result.error);
    }

    // Regenerate pre-rendered homepage HTML
    const htmlResult = await generateHomepageHTML(appRoot);
    if (htmlResult.success) {
      info(`[Publish] Homepage HTML regenerated`);
    } else {
      error(`[Publish] Failed to regenerate homepage HTML:`, htmlResult.error);
    }

    res.json({ 
      success: true, 
      album: sanitizedAlbum,
      published 
    });
  } catch (err) {
    error('[AlbumManagement] Failed to update album published state:', err);
    res.status(500).json({ error: 'Failed to update album published state' });
  }
});

/**
 * Toggle album show_on_homepage state
 */
router.patch("/:album/show-on-homepage", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    const { showOnHomepage } = req.body;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    if (typeof showOnHomepage !== 'boolean') {
      res.status(400).json({ error: 'Show on homepage state must be a boolean' });
      return;
    }

    const photosDir = req.app.get("photosDir");
    const albumPath = path.join(photosDir, sanitizedAlbum);
    
    if (!fs.existsSync(albumPath)) {
      res.status(404).json({ error: 'Album not found' });
      return;
    }

    // Check if album is published
    const albumState = getAlbumState(sanitizedAlbum);
    if (!albumState) {
      res.status(404).json({ error: 'Album not found in database' });
      return;
    }

    if (!albumState.published) {
      res.status(400).json({ error: 'Cannot set homepage visibility for unpublished album' });
      return;
    }

    // Update show_on_homepage state
    const success = setAlbumShowOnHomepage(sanitizedAlbum, showOnHomepage);
    if (!success) {
      error(`[AlbumManagement] Failed to update show_on_homepage for "${sanitizedAlbum}"`);
      res.status(500).json({ error: 'Failed to update show on homepage state' });
      return;
    }
    
    info(`[AlbumManagement] Set album "${sanitizedAlbum}" show_on_homepage state to: ${showOnHomepage}`);

    // Send push notification to all admins
    const userName = (req.user as any).name || (req.user as any).email;
    const action = showOnHomepage ? 'added' : 'removed';
    const preposition = showOnHomepage ? 'to' : 'from';
    await notifyAllAdmins(
      'notifications.backend.homepageUpdatedTitle',
      'notifications.backend.homepageUpdatedBody',
      'homepage-updated',
      'homepageUpdated',
      {
        updatedBy: userName,
        albumName: sanitizedAlbum,
        action,
        preposition
      }
    ).catch(err => error('[AlbumManagement] Failed to send homepage update notification:', err));

    // Regenerate static JSON files (specifically homepage.json)
    info(`[Homepage] Regenerating static JSON files...`);
    const appRoot = req.app.get('appRoot');
    const result = await generateStaticJSONFiles(appRoot);
    if (result.success) {
      info(`[Homepage] Static JSON regenerated (${result.albumCount} albums)`);
    } else {
      error(`[Homepage] Failed to regenerate static JSON:`, result.error);
    }

    // Regenerate pre-rendered homepage HTML
    const htmlResult = await generateHomepageHTML(appRoot);
    if (htmlResult.success) {
      info(`[Homepage] Homepage HTML regenerated`);
    } else {
      error(`[Homepage] Failed to regenerate homepage HTML:`, htmlResult.error);
    }

    res.json({
      success: true,
      album: sanitizedAlbum,
      showOnHomepage
    });
  } catch (err) {
    error('[AlbumManagement] Failed to update album show_on_homepage state:', err);
    res.status(500).json({ error: 'Failed to update album show on homepage state' });
  }
});

/**
 * Update album description (caption shown beneath the title on the public page).
 * Pass null or an empty string to clear the description.
 */
const ALBUM_DESCRIPTION_MAX_LENGTH = 2000;

router.patch("/:album/description", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    const { description } = req.body;

    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    if (description !== null && typeof description !== 'string') {
      res.status(400).json({ error: 'Description must be a string or null' });
      return;
    }

    if (typeof description === 'string' && description.length > ALBUM_DESCRIPTION_MAX_LENGTH) {
      res.status(400).json({
        error: `Description exceeds maximum length of ${ALBUM_DESCRIPTION_MAX_LENGTH} characters`
      });
      return;
    }

    const albumState = getAlbumState(sanitizedAlbum);
    if (!albumState) {
      res.status(404).json({ error: 'Album not found' });
      return;
    }

    const success = setAlbumDescription(sanitizedAlbum, description ?? null);
    if (!success) {
      error(`[AlbumManagement] Failed to update description for "${sanitizedAlbum}"`);
      res.status(500).json({ error: 'Failed to update album description' });
      return;
    }

    info(`[AlbumManagement] Updated description for album "${sanitizedAlbum}"`);

    // Invalidate album cache and regenerate static JSON so the public page picks up the change
    invalidateAlbumCache(sanitizedAlbum);
    const appRoot = req.app.get('appRoot');
    const result = await generateStaticJSONFiles(appRoot);
    if (!result.success) {
      error(`[AlbumDescription] Failed to regenerate static JSON:`, result.error);
    }

    // Re-read so we return the normalized (trimmed / null) value to the client
    const updated = getAlbumState(sanitizedAlbum);
    res.json({
      success: true,
      album: sanitizedAlbum,
      description: updated?.description ?? null,
    });
  } catch (err) {
    error('[AlbumManagement] Failed to update album description:', err);
    res.status(500).json({ error: 'Failed to update album description' });
  }
});

/**
 * Trigger optimization for all albums
 */
router.post("/:album/optimize", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    // Get project root (two levels up from backend/src)
    const projectRoot = path.resolve(__dirname, '../../../');
    const scriptPath = path.join(projectRoot, 'scripts', 'optimize_all_images.js');

    if (!fs.existsSync(scriptPath)) {
      res.status(500).json({ error: 'Optimization script not found' });
      return;
    }

    // Run optimization script in the background using execFile to prevent command injection
    // Don't wait for it to complete
    const photosDir = req.app.get("photosDir");
    const albumPath = path.join(photosDir, sanitizedAlbum);
    
    execFile('node', [scriptPath, albumPath], (err, stdout, stderr) => {
      if (err) {
        error('[AlbumManagement] Optimization error:', err);
      } else {
        info('[AlbumManagement] Optimization complete for album:', sanitizedAlbum);
      }
    });

    res.json({ 
      success: true, 
      message: 'Optimization started in background' 
    });
  } catch (err) {
    error('[AlbumManagement] Failed to trigger optimization:', err);
    res.status(500).json({ error: 'Failed to trigger optimization' });
  }
});

/**
 * Update photo order in an album
 */
router.post("/:album/photo-order", requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { album } = req.params;
    const { photoOrder } = req.body;
    
    const sanitizedAlbum = sanitizeName(album);
    if (!sanitizedAlbum) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    // Validate photoOrder array
    if (!Array.isArray(photoOrder)) {
      res.status(400).json({ error: 'photoOrder must be an array' });
      return;
    }

    // Validate photo filenames - DON'T sanitize, use exact names from database
    const imageOrders = photoOrder.map((item, index) => {
      const filename = item.filename;
      
      // Basic security validation only
      if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error(`Invalid photo filename: ${filename}`);
      }
      
      return {
        filename: filename,  // Use EXACT filename, no modifications
        sort_order: index
      };
    });

    // Update the sort order in the database
    const success = updateImageSortOrder(sanitizedAlbum, imageOrders);
    
    if (!success) {
      res.status(500).json({ error: 'Failed to update photo order' });
      return;
    }

    // Invalidate cache for this album
    invalidateAlbumCache(sanitizedAlbum);
    
    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    info(`[AlbumManagement] Updated photo order for album: ${sanitizedAlbum} (${imageOrders.length} photos)`);

    res.json({ success: true });
  } catch (err) {
    error('[AlbumManagement] Failed to update photo order:', err);
    res.status(500).json({ error: 'Failed to update photo order' });
  }
});

/**
 * Update album sort order
 */
router.put('/sort-order', requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { albumOrders } = req.body;
    
    if (!Array.isArray(albumOrders)) {
      res.status(400).json({ error: 'Invalid album orders data' });
      return;
    }
    
    // Validate each entry has name and sort_order
    for (const entry of albumOrders) {
      if (typeof entry.name !== 'string' || typeof entry.sort_order !== 'number') {
        res.status(400).json({ error: 'Each album must have name and sort_order' });
        return;
      }
    }
    
    const success = updateAlbumSortOrder(albumOrders);
    
    if (success) {
      info(`[AlbumManagement] Updated sort order for ${albumOrders.length} albums`);
      
      // Regenerate static JSON files
      const appRoot = req.app.get('appRoot');
      generateStaticJSONFiles(appRoot);
      
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to update album order' });
    }
  } catch (err) {
    error('[AlbumManagement] Failed to update album order:', err);
    res.status(500).json({ error: 'Failed to update album order' });
  }
});

/**
 * Move album to folder (or remove from folder)
 */
router.put('/:albumName/move', requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { albumName } = req.params;
    const { folderName, published } = req.body;
    
    if (!albumName) {
      res.status(400).json({ error: 'Album name is required' });
      return;
    }
    
    // Get the album's current state to track which folder it's being moved FROM
    const albumState = getAlbumState(albumName);
    if (!albumState) {
      res.status(404).json({ error: 'Album not found' });
      return;
    }
    
    const oldFolderId = (albumState as any).folder_id;
    
    // Get folder ID and published state if folderName is provided
    let folderId: number | null = null;
    let folderPublishedState: boolean | null = null;
    
    if (folderName) {
      const db = getDatabase();
      const folder = db.prepare('SELECT id, published FROM album_folders WHERE name = ?').get(folderName) as { id: number; published: number } | undefined;
      if (!folder) {
        res.status(404).json({ error: 'Folder not found' });
        return;
      }
      folderId = folder.id;
      folderPublishedState = folder.published === 1;
    }
    
    // Move album to folder (or remove from folder if folderId is null)
    const success = setAlbumFolder(albumName, folderId);
    
    if (!success) {
      res.status(500).json({ error: 'Failed to move album' });
      return;
    }
    
    // Sync published state with folder
    if (folderId !== null && folderPublishedState !== null) {
      // Moving into a folder - sync album's published state with folder's published state
      setAlbumPublished(albumName, folderPublishedState);
      info(`Set album "${albumName}" published state to ${folderPublishedState} (synced with folder)`);
    } else if (typeof published === 'boolean') {
      // Moving to uncategorized - use provided published state
      setAlbumPublished(albumName, published);
    }
    // If moving to uncategorized and no published state provided, keep current state
    
    info(`Moved album "${albumName}" to folder ${folderName || 'none'}`);
    
    // If the album was moved OUT of a folder, check if that old folder is now empty
    // If so, automatically unpublish it
    if (oldFolderId !== null && oldFolderId !== folderId) {
      const albumsInOldFolder = getAlbumsInFolder(oldFolderId);
      if (albumsInOldFolder.length === 0) {
        // Get the old folder's name to unpublish it
        const db = getDatabase();
        const oldFolder = db.prepare('SELECT name FROM album_folders WHERE id = ?').get(oldFolderId) as { name: string } | undefined;
        if (oldFolder) {
          setFolderPublished(oldFolder.name, false);
          info(`Auto-unpublished empty folder: ${oldFolder.name}`);
        }
      }
    }
    
    // Regenerate static JSON files
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    res.json({ success: true });
  } catch (err) {
    error('[AlbumManagement] Failed to move album:', err);
    res.status(500).json({ error: 'Failed to move album' });
  }
});

/**
 * POST /api/albums/:albumName/video/:filename/upload-thumbnail
 * Upload a custom thumbnail image for a video
 */
router.post('/:albumName/video/:filename/upload-thumbnail', requireManager, upload.single('thumbnail'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { albumName, filename } = req.params;
    
    if (!albumName || !filename) {
      res.status(400).json({ error: 'Album name and filename are required' });
      return;
    }

    const sanitizedAlbumName = sanitizeName(albumName);
    const sanitizedFilename = sanitizePhotoName(filename);

    if (!sanitizedAlbumName) {
      await cleanupUploadedTempFile(req.file);
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }

    if (!sanitizedFilename) {
      await cleanupUploadedTempFile(req.file);
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    
    // Check if file was uploaded
    if (!req.file) {
      res.status(400).json({ error: 'No thumbnail file uploaded' });
      return;
    }
    
    const appRoot = req.app.get('appRoot');
    const dataDir = process.env.DATA_DIR || path.join(appRoot, 'data');
    const optimizedDir = path.join(dataDir, 'optimized');
    const optimizedRoot = path.resolve(optimizedDir);
    const thumbnailPath = path.resolve(optimizedRoot, 'thumbnail', sanitizedAlbumName, sanitizedFilename.replace(/\.[^.]+$/, '.jpg'));
    const modalPath = path.resolve(optimizedRoot, 'modal', sanitizedAlbumName, sanitizedFilename.replace(/\.[^.]+$/, '.jpg'));

    if (!isPathWithinDirectory(optimizedRoot, thumbnailPath) || !isPathWithinDirectory(optimizedRoot, modalPath)) {
      await cleanupUploadedTempFile(req.file);
      res.status(400).json({ error: 'Invalid thumbnail path' });
      return;
    }
    
    // Generate thumbnail (512px)
    await sharp(req.file.path)
      .resize(512, 512, { 
        fit: 'inside',
        withoutEnlargement: true 
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);
    
    // Generate modal preview (2048px)
    await sharp(req.file.path)
      .resize(2048, 2048, { 
        fit: 'inside',
        withoutEnlargement: true 
      })
      .jpeg({ quality: 90 })
      .toFile(modalPath);
    
    // Clean up temporary file
    fs.unlinkSync(req.file.path);
    
    info(`[VideoThumbnail] Uploaded custom thumbnail for ${sanitizedAlbumName}/${sanitizedFilename}`);
    
    // Regenerate static JSON to reflect thumbnail update
    try {
      info(`[VideoThumbnail] Regenerating static JSON after thumbnail upload`);
      generateStaticJSONFiles(appRoot);
      invalidateAlbumCache(sanitizedAlbumName);
    } catch (err) {
      error('[VideoThumbnail] Failed to regenerate static JSON:', err);
    }
    
    res.json({ 
      success: true,
      message: 'Custom thumbnail uploaded successfully'
    });
  } catch (err) {
    error('[VideoThumbnail] Failed to upload custom thumbnail:', err);
    res.status(500).json({ error: 'Failed to upload custom thumbnail' });
  }
});

/**
 * POST /api/albums/:albumName/video/:filename/update-thumbnail
 * Update video thumbnail by extracting a frame at a specific timestamp
 */
router.post('/:albumName/video/:filename/update-thumbnail', requireManager, async (req: Request, res: Response): Promise<void> => {
  try {
    const { albumName, filename } = req.params;
    const { timestamp } = req.body; // timestamp in seconds
    
    info(`[VideoThumbnail] Request received - album: "${albumName}", filename: "${filename}", timestamp: ${timestamp}`);
    
    if (!albumName || !filename) {
      res.status(400).json({ error: 'Album name and filename are required' });
      return;
    }
    
    // Validate inputs to prevent shell injection and directory traversal
    // DON'T transform the names - use exact names from database
    const sanitizedAlbumName = sanitizeName(albumName);
    
    if (!sanitizedAlbumName) {
      res.status(400).json({ error: 'Invalid album name' });
      return;
    }
    
    // Basic security check for filename - no transformation
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    
    const sanitizedFilename = filename; // Use exact filename, no transformation
    
    if (typeof timestamp !== 'number' || timestamp < 0) {
      res.status(400).json({ error: 'Valid timestamp is required' });
      return;
    }
    
    const appRoot = req.app.get('appRoot');
    const dataDir = process.env.DATA_DIR || path.join(appRoot, 'data');
    const videoDir = path.join(dataDir, 'video', sanitizedAlbumName, sanitizedFilename);
    const optimizedDir = path.join(dataDir, 'optimized');
    const rotatedVideoPath = path.join(videoDir, 'original.mp4');
    
    info(`[VideoThumbnail] Looking for rotated video at: ${rotatedVideoPath}`);
    
    // Check if rotated video exists
    if (!fs.existsSync(rotatedVideoPath)) {
      // Log what files DO exist in the directory
      const parentDir = path.join(dataDir, 'video', sanitizedAlbumName);
      info(`[VideoThumbnail] Rotated video not found. Checking parent dir: ${parentDir}`);
      try {
        if (fs.existsSync(parentDir)) {
          const files = fs.readdirSync(parentDir);
          info(`[VideoThumbnail] Files in parent directory: ${JSON.stringify(files)}`);
        } else {
          info(`[VideoThumbnail] Parent directory does not exist`);
        }
      } catch (err) {
        error(`[VideoThumbnail] Error checking directory:`, err);
      }
      res.status(404).json({ error: 'Video not found or not yet processed', path: rotatedVideoPath });
      return;
    }
    
    // Format timestamp as HH:MM:SS
    const hours = Math.floor(timestamp / 3600);
    const minutes = Math.floor((timestamp % 3600) / 60);
    const seconds = Math.floor(timestamp % 60);
    const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    info(`[VideoThumbnail] ✓ Rotated video found! Extracting frame at ${timeString} for ${sanitizedAlbumName}/${sanitizedFilename}`);
    
    // Ensure output directories exist
    const thumbnailDir = path.join(optimizedDir, 'thumbnail', sanitizedAlbumName);
    const modalDir = path.join(optimizedDir, 'modal', sanitizedAlbumName);
    
    if (!fs.existsSync(thumbnailDir)) {
      info(`[VideoThumbnail] Creating thumbnail directory: ${thumbnailDir}`);
      fs.mkdirSync(thumbnailDir, { recursive: true });
    }
    if (!fs.existsSync(modalDir)) {
      info(`[VideoThumbnail] Creating modal directory: ${modalDir}`);
      fs.mkdirSync(modalDir, { recursive: true });
    }
    
    // Extract thumbnail (512px for thumbnail view)
    const thumbnailPath = path.join(optimizedDir, 'thumbnail', sanitizedAlbumName, sanitizedFilename.replace(/\.[^.]+$/, '.jpg'));
    info(`[VideoThumbnail] Starting ffmpeg extraction - output: ${thumbnailPath}`);
    info(`[VideoThumbnail] ffmpeg args: -ss ${timeString} -i ${rotatedVideoPath} -vframes 1 -vf scale=512:-2 -y ${thumbnailPath}`);
    
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-ss', timeString, // Seek to timestamp
        '-i', rotatedVideoPath,
        '-vframes', '1', // Extract 1 frame
        '-vf', 'scale=512:-2', // Scale to 512px width, maintain aspect ratio
        '-y', // Overwrite existing file
        thumbnailPath
      ];
      
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          error('[VideoThumbnail] Thumbnail extraction FAILED with code', code);
          error('[VideoThumbnail] ffmpeg stderr:', stderr);
          reject(new Error(`Thumbnail extraction failed: ${stderr}`));
        } else {
          info('[VideoThumbnail] ✓ Thumbnail extracted successfully (512px)');
          resolve();
        }
      });
      
      ffmpeg.on('error', (err) => {
        error('[VideoThumbnail] ffmpeg process error:', err);
        reject(err);
      });
    });
    
    // Extract modal preview (2048px for modal view)
    const modalPath = path.join(optimizedDir, 'modal', sanitizedAlbumName, sanitizedFilename.replace(/\.[^.]+$/, '.jpg'));
    info(`[VideoThumbnail] Modal preview output path: ${modalPath}`);
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-ss', timeString,
        '-i', rotatedVideoPath,
        '-vframes', '1',
        '-vf', 'scale=2048:-2',
        '-y',
        modalPath
      ];
      
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';
      
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          error('[VideoThumbnail] Modal preview extraction failed:', stderr);
          reject(new Error(`Modal preview extraction failed: ${stderr}`));
        } else {
          info('[VideoThumbnail] Modal preview extracted successfully');
          resolve();
        }
      });
      
      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
    
    info(`[VideoThumbnail] Updated thumbnails for ${sanitizedAlbumName}/${sanitizedFilename} at ${timeString}`);
    
    // Regenerate static JSON to reflect thumbnail update
    try {
      info(`[VideoThumbnail] Regenerating static JSON after thumbnail update`);
      generateStaticJSONFiles(appRoot);
      invalidateAlbumCache(sanitizedAlbumName);
    } catch (err) {
      error('[VideoThumbnail] Failed to regenerate static JSON:', err);
    }
    
    res.json({ 
      success: true,
      message: 'Thumbnail updated successfully',
      timestamp: timeString
    });
  } catch (err) {
    error('[VideoThumbnail] Failed to update video thumbnail:', err);
    res.status(500).json({ error: 'Failed to update video thumbnail' });
  }
});

export default router;
