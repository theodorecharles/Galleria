/**
 * Album Management — photo & media upload sub-router.
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

export default router;
