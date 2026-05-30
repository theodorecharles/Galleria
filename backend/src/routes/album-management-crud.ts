/**
 * Album Management — album CRUD & metadata sub-router.
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
    // migrate-share-links-cascade.js migration.
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

export default router;
