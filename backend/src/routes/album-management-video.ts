/**
 * Album Management — video thumbnails sub-router.
 * Extracted from album-management.ts (ticket #1506).
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
import {
  notifyAllAdmins,
  trackPhotoUpload,
  toTitleCase,
  generateAITitleForImageAsync,
  generateAITitleForImage,
  upload,
  cleanupUploadedTempFile,
  sanitizeName,
  sanitizePhotoName,
  isVideoFile,
  isPathWithinDirectory,
  execFileAsync,
  __dirname,
  __filename,
} from "./album-management-shared.js";

const router = Router();

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
