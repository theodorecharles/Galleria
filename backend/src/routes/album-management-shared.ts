/**
 * Album Management — shared helpers, multer config, sanitizers and path utils.
 * Extracted from album-management.ts (ticket #1506) without behaviour changes.
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

export const execFileAsync = promisify(execFile);

/**
 * Helper to send push notification to all admin users
 */
export async function notifyAllAdmins(title: string, body: string, tag: string, notificationType?: any, variables?: Record<string, any>): Promise<void> {
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

export const uploadBatches = new Map<string, UploadBatch>();
export const LARGE_UPLOAD_THRESHOLD = 50; // 50 photos
export const BATCH_WINDOW = 5 * 60 * 1000; // 5 minutes

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
export async function trackPhotoUpload(album: string, userName: string): Promise<void> {
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
export function toTitleCase(str: string): string {
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
export async function generateAITitleForImageAsync(
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
export async function generateAITitleForImage(
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
export const upload = multer({
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

export const cleanupUploadedTempFile = async (file?: Express.Multer.File): Promise<void> => {
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
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

/**
 * Sanitize album/photo name - allows letters, numbers, spaces, hyphens, and underscores
 */
export const sanitizeName = (name: string): string | null => {
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
export const sanitizePhotoName = (name: string): string | null => {
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
export const isVideoFile = (filename: string): boolean => {
  return /\.(mp4|mov|avi|mkv|webm)$/i.test(filename);
};

export const isPathWithinDirectory = (baseDir: string, targetPath: string): boolean => {
  const relativePath = path.relative(baseDir, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
};
