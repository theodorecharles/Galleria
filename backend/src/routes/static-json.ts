/**
 * Route handler for static JSON generation.
 * Generates static JSON files for all albums to improve frontend loading performance.
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getAllAlbums, getImagesInAlbum, getImagesForHomepage } from "../database.js";
import { requireAuth, requireAdmin, requireManager } from '../auth/middleware.js';
import { invalidateAlbumCache } from './albums.js';
import { DATA_DIR } from '../config.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';

const router = Router();

/**
 * Get the output directory for static JSON files
 */
function getOutputDir(appRoot: string): string {
  return path.join(appRoot, 'frontend', 'dist', 'albums-data');
}

/**
 * Ensure output directory exists
 */
function ensureOutputDir(outputDir: string): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

/**
 * Write JSON file to dist directory
 */
async function writeJSON(outputDir: string, filename: string, data: any): Promise<void> {
  const jsonString = JSON.stringify(data, null, 2);
  const filePath = path.join(outputDir, filename);
  await fs.promises.writeFile(filePath, jsonString);
}

/**
 * Transform database image to optimized array format
 * Album format: [filename, title, media_type, description, downloads_enabled]
 * Homepage format: [filename, title, album, media_type, description, downloads_enabled]
 * media_type: 0 = photo, 1 = video
 * downloads_enabled: 0 = disabled, 1 = enabled
 */
function transformImageToArray(
  img: any,
  album: string,
  includeAlbum: boolean = false,
  downloadsEnabled: boolean = true
) {
  const defaultTitle = img.filename
    .replace(/\.[^/.]+$/, '') // Remove extension
    .replace(/[-_]/g, ' '); // Replace hyphens and underscores with spaces

  const title = img.title || defaultTitle;
  const mediaType = img.media_type === 'video' ? 1 : 0;
  const description = img.description || null;
  
  if (includeAlbum) {
    return [img.filename, title, album, mediaType, description, downloadsEnabled ? 1 : 0];
  }
  return [img.filename, title, mediaType, description, downloadsEnabled ? 1 : 0];
}

/**
 * Generate static JSON files for all albums
 */
export async function generateStaticJSONFiles(appRoot: string): Promise<{ success: boolean; error?: string; albumCount?: number }> {
  try {
    const outputDir = getOutputDir(appRoot);
    ensureOutputDir(outputDir);

    // Get ALL albums (published + unpublished) - admins need fast access to unpublished albums too
    const albumsData = getAllAlbums();
    const albums = albumsData
      .filter(a => a.name !== 'homepage')
      .map(a => a.name);

    // Clean up stale JSON files for DELETED albums only (keep unpublished albums)
    if (fs.existsSync(outputDir)) {
      const existingFiles = fs.readdirSync(outputDir);
      const albumJsonFiles = existingFiles.filter(f => f.endsWith('.json') && f !== 'homepage.json' && f !== 'albums-list.json' && f !== '_metadata.json');
      
      for (const file of albumJsonFiles) {
        const albumName = file.replace('.json', '');
        if (!albums.includes(albumName)) {
          // This JSON file corresponds to a DELETED album (not just unpublished)
          const filePath = path.join(outputDir, file);
          fs.unlinkSync(filePath);
        }
      }
    }

    // Generate JSON for each album in parallel (optimized array format)
    await Promise.all(
      albums.map(async (album) => {
        try {
          const albumState = albumsData.find(a => a.name === album);
          const images = getImagesInAlbum(album);
          const photos = images.map((img) =>
            transformImageToArray(img, album, false, albumState?.downloads_enabled ?? true)
          );
          await writeJSON(outputDir, `${album}.json`, photos);
        } catch (err) {
          error(`[StaticJSON] Error generating JSON for album "${album}":`, err);
        }
      })
    );

    // Generate homepage JSON (photos from albums with show_on_homepage enabled, in order)
    try {
      // Load shuffle setting from config
      const configPath = path.join(DATA_DIR, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const shuffleHomepage = config.branding?.shuffleHomepage ?? true;
      
      const homepageImages = getImagesForHomepage();
      
      // Keep photos in order (by album sort order, then by photo sort order)
      // Frontend will shuffle if shuffle setting is enabled
      const photos = homepageImages.map((img) => 
        transformImageToArray(img, img.album, true, (img as any).downloads_enabled ?? true)
      );
      
      // Include shuffle setting in homepage JSON
      const homepageData = {
        shuffle: shuffleHomepage,
        photos: photos
      };
      
      await writeJSON(outputDir, 'homepage.json', homepageData);
    } catch (err) {
      error('[StaticJSON] Error generating homepage.json:', err);
    }

    // Generate albums list and metadata file in parallel
    const metadata = {
      generatedAt: new Date().toISOString(),
      albumCount: albums.length,
      albums: albums
    };
    
    await Promise.all([
      writeJSON(outputDir, 'albums-list.json', albums),
      writeJSON(outputDir, '_metadata.json', metadata)
    ]);

    info(`[StaticJSON] Generation complete! (${albums.length} albums)`);
    return { success: true, albumCount: albums.length };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    error('[StaticJSON] Generation failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * POST /api/static-json/generate
 * Trigger static JSON generation (admin only)
 */
router.post("/generate", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const appRoot = req.app.get('appRoot');
  const result = await generateStaticJSONFiles(appRoot);
  
  // Invalidate all album caches after regeneration
  invalidateAlbumCache();
  
  if (result.success) {
    res.json({ 
      success: true, 
      message: `Generated static JSON for ${result.albumCount} albums`,
      albumCount: result.albumCount
    });
  } else {
    res.status(500).json({ 
      success: false, 
      error: result.error 
    });
  }
});

/**
 * POST /api/static-json/regenerate
 * Trigger static JSON regeneration after batch uploads (manager access)
 */
router.post("/regenerate", requireManager, async (req: Request, res: Response): Promise<void> => {
  const appRoot = req.app.get('appRoot');
  const result = await generateStaticJSONFiles(appRoot);
  
  // Invalidate all album caches after regeneration
  // This ensures fresh data is served after batch uploads
  invalidateAlbumCache();
  
  if (result.success) {
    res.json({ 
      success: true, 
      message: `Regenerated static JSON for ${result.albumCount} albums` 
    });
  } else {
    res.status(500).json({ 
      success: false, 
      error: result.error 
    });
  }
});

/**
 * GET /api/static-json/status
 * Get status of static JSON files
 */
router.get("/status", async (req: Request, res: Response): Promise<void> => {
  try {
    const appRoot = req.app.get('appRoot');
    const outputDir = getOutputDir(appRoot);
    const metadataPath = path.join(outputDir, '_metadata.json');
    
    if (!fs.existsSync(metadataPath)) {
      res.json({ 
        exists: false,
        message: 'Static JSON files have not been generated yet'
      });
      return;
    }
    
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    res.json({ 
      exists: true,
      ...metadata
    });
  } catch (err) {
    res.status(500).json({ 
      error: 'Failed to read static JSON status' 
    });
  }
});

export default router;
