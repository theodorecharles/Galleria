/**
 * Image Metadata Routes
 * Provides endpoints for managing image titles and descriptions
 */

import express from 'express';
import { createRequire } from 'module';
import { csrfProtection } from '../security.js';
import { requireAuth, requireManager } from '../auth/middleware.js';
import { generateStaticJSONFiles } from './static-json.js';
import { invalidateAlbumCache } from './albums.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';

const require = createRequire(import.meta.url);

// Lazy import database functions to avoid loading better-sqlite3 at module init
let dbFunctions: any = null;
const getDbFunctions = async () => {
  if (!dbFunctions) {
    dbFunctions = await import('../database.js');
  }
  return dbFunctions;
};

const router = express.Router();

// Apply CSRF protection to all routes
router.use(csrfProtection);

/**
 * GET /api/image-metadata/:album/:filename
 * Get metadata for a specific image
 */
router.get('/:album/:filename', requireAuth, async (req, res) => {
  try {
    const { album, filename } = req.params;
    const db = await getDbFunctions();
    const metadata = db.getImageMetadata(album, filename);
    
    if (!metadata) {
      res.status(404).json({ error: 'Metadata not found' });
      return;
    }
    
    res.json(metadata);
  } catch (err) {
    error('[ImageMetadata] Failed to fetch image metadata:', err);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

/**
 * GET /api/image-metadata/album/:album
 * Get all metadata for an album
 */
router.get('/album/:album', requireAuth, async (req, res) => {
  try {
    const { album } = req.params;
    const db = await getDbFunctions();
    const metadata = db.getAlbumMetadata(album);
    res.json(metadata);
  } catch (err) {
    error('[ImageMetadata] Failed to fetch album metadata:', err);
    res.status(500).json({ error: 'Failed to fetch album metadata' });
  }
});

/**
 * GET /api/image-metadata/all
 * Get all image metadata
 */
router.get('/all', requireManager, async (req, res) => {
  try {
    const db = await getDbFunctions();
    const metadata = db.getAllMetadata();
    res.json(metadata);
  } catch (err) {
    error('[ImageMetadata] Failed to fetch all metadata:', err);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

/**
 * POST /api/image-metadata
 * Save or update image metadata
 */
router.post('/', requireManager, express.json(), async (req, res) => {
  try {
    const { album, filename, title, description } = req.body;
    
    if (!album || !filename) {
      res.status(400).json({ error: 'Album and filename are required' });
      return;
    }
    
    const db = await getDbFunctions();
    db.saveImageMetadata(album, filename, title || null, description || null);
    
    // Regenerate static JSON files (titles are included in JSON)
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    res.json({ 
      success: true, 
      message: 'Metadata saved successfully' 
    });
  } catch (err) {
    error('[ImageMetadata] Failed to save image metadata:', err);
    res.status(500).json({ error: 'Failed to save metadata' });
  }
});

/**
 * PUT /api/image-metadata/:album/:filename
 * Update image metadata
 */
router.put('/:album/:filename', requireManager, express.json(), async (req, res) => {
  try {
    const { album, filename } = req.params;
    const { title, description } = req.body;
    
    const db = await getDbFunctions();
    const success = db.updateImageMetadata(
      album, 
      filename, 
      title || null, 
      description || null
    );
    
    if (!success) {
      res.status(404).json({ error: 'Metadata not found' });
      return;
    }
    
    // Invalidate album cache so next request gets fresh data
    invalidateAlbumCache(album);
    
    // Regenerate static JSON files (titles are included in JSON)
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    res.json({ 
      success: true, 
      message: 'Metadata updated successfully' 
    });
  } catch (err) {
    error('[ImageMetadata] Failed to update image metadata:', err);
    res.status(500).json({ error: 'Failed to update metadata' });
  }
});

/**
 * DELETE /api/image-metadata/:album/:filename
 * Delete image metadata
 */
router.delete('/:album/:filename', requireManager, async (req, res) => {
  try {
    const { album, filename } = req.params;
    
    const db = await getDbFunctions();
    const success = db.deleteImageMetadata(album, filename);
    
    if (!success) {
      res.status(404).json({ error: 'Metadata not found' });
      return;
    }
    
    // Regenerate static JSON files (titles are included in JSON)
    const appRoot = req.app.get('appRoot');
    generateStaticJSONFiles(appRoot);
    
    res.json({ 
      success: true, 
      message: 'Metadata deleted successfully' 
    });
  } catch (err) {
    error('[ImageMetadata] Failed to delete image metadata:', err);
    res.status(500).json({ error: 'Failed to delete metadata' });
  }
});

export default router;

