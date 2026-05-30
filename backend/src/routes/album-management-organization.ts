/**
 * Album Management — sort order & move sub-router.
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

export default router;
