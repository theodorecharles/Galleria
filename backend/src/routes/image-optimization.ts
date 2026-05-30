/**
 * Image optimization routes for managing optimization settings and running optimization scripts.
 */

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { csrfProtection } from "../security.js";
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import { JobManager } from "../services/job-runner.js";

const router = express.Router();

// Apply CSRF protection to all routes in this router
router.use(csrfProtection);

const optimizationJobs = new JobManager();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { DATA_DIR, reloadConfig } from '../config.js';
import { requireAuth, requireAdmin, requireManager } from '../auth/middleware.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';

// Path to config.json
const configPath = path.join(DATA_DIR, 'config.json');

// GET /api/image-optimization/settings - Get current optimization settings
router.get('/settings', requireAuth, (req, res) => {
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    const settings = {
      concurrency: config.environment?.optimization?.concurrency || 4,
      images: config.environment?.optimization?.images || {
        thumbnail: { quality: 60, maxDimension: 512 },
        modal: { quality: 90, maxDimension: 2048 },
        download: { quality: 100, maxDimension: 4096 }
      }
    };
    
    res.json(settings);
  } catch (err) {
    error('[ImageOptimization] Failed to read optimization settings:', err);
    res.status(500).json({ error: 'Failed to read optimization settings' });
  }
});

// PUT /api/image-optimization/settings - Update optimization settings
router.put('/settings', requireAdmin, (req, res) => {
  try {
    const { concurrency, images } = req.body;
    
    // Validate input - accept either nested (images.thumbnail) or flat (thumbnail) format
    const thumbnail = images?.thumbnail || req.body.thumbnail;
    const modal = images?.modal || req.body.modal;
    const download = images?.download || req.body.download;
    
    if (!thumbnail || !modal || !download) {
      res.status(400).json({ error: 'Missing required settings' });
      return;
    }
    
    // Read current config
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    // Ensure the optimization path exists
    if (!config.environment.optimization) {
      config.environment.optimization = {};
    }
    
    // Update concurrency
    if (concurrency !== undefined) {
      config.environment.optimization.concurrency = Math.max(1, Math.min(16, parseInt(concurrency) || 4));
    }
    
    // Update image settings
    config.environment.optimization.images = {
      thumbnail: {
        quality: Math.max(0, Math.min(100, parseInt(thumbnail.quality) || 60)),
        maxDimension: Math.max(128, Math.min(4096, parseInt(thumbnail.maxDimension) || 512))
      },
      modal: {
        quality: Math.max(0, Math.min(100, parseInt(modal.quality) || 90)),
        maxDimension: Math.max(512, Math.min(8192, parseInt(modal.maxDimension) || 2048))
      },
      download: {
        quality: Math.max(0, Math.min(100, parseInt(download.quality) || 100)),
        maxDimension: Math.max(1024, Math.min(16384, parseInt(download.maxDimension) || 4096))
      }
    };
    
    // Write back to config
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    // Reload config cache in memory
    reloadConfig();
    info("[ImageOptimization] Config reloaded after optimization settings update");
    
    res.json({ success: true, settings: config.environment.optimization });
  } catch (err) {
    error('[ImageOptimization] Failed to update optimization settings:', err);
    res.status(500).json({ error: 'Failed to update optimization settings' });
  }
});

// GET /api/image-optimization/status - Check if optimization is running
router.get('/status', requireAuth, (req, res) => {
  res.json(optimizationJobs.getStatus());
});

// POST /api/image-optimization/stop - Stop running optimization job
router.post('/stop', requireManager, (req: any, res: any) => {
  const runningJob = optimizationJobs.current;

  if (!runningJob || runningJob.isComplete) {
    return res.json({ success: false, message: 'No running job to stop' });
  }
  
  try {
    const stopMsg = JSON.stringify({ type: 'error', message: 'Job stopped by user' });
    optimizationJobs.stop(stopMsg);
    info('[Optimization] Job stopped by user');
    
    res.json({ success: true, message: 'Job stopped successfully' });
  } catch (err: any) {
    error('[Optimization] Error stopping job:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/image-optimization/optimize - Run optimization script with SSE
router.post('/optimize', requireManager, (req, res) => {
  const { force } = req.body;
  const { job, reconnected } = optimizationJobs.connectOrStart(req, res, {});
  
  if (reconnected) {
    info('[Optimization] Reconnecting to existing job');
    return;
  }
  
  // Send initial connection message
  const connectMsg = '{"type":"connected","message":"Connected to optimization stream"}';
  optimizationJobs.append(job, connectMsg);
  
  // Build command
  const scriptPath = path.resolve(__dirname, '../../../scripts/optimize_all_images.js');
  const args = force ? ['--force'] : [];
  
  // Check if script exists
  if (!fs.existsSync(scriptPath)) {
    optimizationJobs.complete(
      job,
      '{"type":"error","message":"Optimization script not found"}',
      { closeClients: true }
    );
    return;
  }
  
  optimizationJobs.startProcess(job, {
    command: 'node',
    args: [scriptPath, ...args],
    spawnOptions: {
      cwd: path.resolve(__dirname, '../../../'),
      env: { ...process.env, TERM: 'dumb' } // Disable terminal colors/animations
    },
    onStdoutLine: (line) => {
      let output = '';

      // Parse progress from lines like: [150/3000] (5%) Album/image.jpg [type]
      const progressMatch = line.match(/^\[(\d+)\/(\d+)\]\s*\((\d+)%\)/);
      if (progressMatch) {
        const [, current, total, percent] = progressMatch;
        output = JSON.stringify({
          type: 'progress',
          current: parseInt(current),
          total: parseInt(total),
          percent: parseInt(percent),
          message: line
        });
        // Log progress to file (verbose level)
        verbose(`[Optimization] ${line}`);
      } else {
        output = JSON.stringify({ type: 'stdout', message: line });
        // Log stdout to file (info level)
        info(`[Optimization] ${line}`);
      }

      return output;
    },
    onStderrLine: (line) => {
      // Log stderr to file (warn level)
      warn(`[Optimization] ${line}`);
      return JSON.stringify({ type: 'stderr', message: line });
    },
    onClose: (code) => {
      info(`[Optimization] Process completed with exit code ${code}`);

      return JSON.stringify({
        type: 'complete',
        message: `Process exited with code ${code}`,
        exitCode: code
      });
    },
    onComplete: async (code) => {
      // Send push notification to user
      if (req.user && 'id' in req.user) {
        const userId = (req.user as any).id;
        const duration = Date.now() - job.startTime;
        const durationMin = (duration / 1000 / 60).toFixed(1);
        
        const titleKey = code === 0 ? 'notifications.backend.imageOptimizationComplete' : 'notifications.backend.imageOptimizationFailed';
        const bodyKey = code === 0 ? 'notifications.backend.imageOptimizationCompleteBody' : 'notifications.backend.imageOptimizationFailedBody';
        
        const variables = code === 0 
          ? { imagesOptimized: (job as any).totalImages || 0 }
          : { error: (job as any).error || `Exit code ${code}` };
        
        const title = await translateNotification(titleKey, variables);
        const body = await translateNotification(bodyKey, variables);
        
        sendNotificationToUser(userId, {
          title,
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'image-optimization',
          requireInteraction: false
        }).catch(err => {
          warn('[Optimization] Failed to send push notification:', err);
        });
      }
    },
    onError: (err) => {
      error(`[Optimization] Failed to start process:`, err);

      return JSON.stringify({
        type: 'error',
        message: `Failed to start process: ${err.message}`
      });
    },
    closeClientsOnComplete: true,
    closeClientsOnError: true
  });
});

export default router;
