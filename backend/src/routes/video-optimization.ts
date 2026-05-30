/**
 * Video optimization routes for regenerating video playlists and settings.
 */

import express from "express";
import { csrfProtection } from "../security.js";
import path from "path";
import { fileURLToPath } from "url";
import { error, warn, info } from '../utils/logger.js';
import { requireManager } from '../auth/middleware.js';
import { sendNotificationToUser } from '../push-notifications.js';
import { translateNotification } from '../i18n-backend.js';
import { JobManager } from "../services/job-runner.js";

const router = express.Router();

// Apply CSRF protection to all routes in this router
router.use(csrfProtection);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface VideoOptimizationJobState {
  videoCount?: { generated: number; skipped: number; errors: number };
}

const videoOptimizationJobs = new JobManager<VideoOptimizationJobState>({
  cacheControl: 'no-cache, no-transform'
});

const gpuDiagnosticJobs = new JobManager({
  cacheControl: 'no-cache, no-transform',
  onClientDisconnect: (remainingClients) => {
    if (remainingClients === 0 && gpuDiagnosticJobs.isRunning) {
      info('[GPU Test] Client disconnected, cleaning up');
      gpuDiagnosticJobs.stop(JSON.stringify({ type: 'error', message: 'GPU diagnostic cancelled' }));
    }
  }
});

function formatDuration(duration: number): string {
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes > 0
    ? `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`
    : `${seconds} second${seconds !== 1 ? 's' : ''}`;
}

/**
 * POST /api/video-optimization/regenerate
 * Regenerate video master playlists with current configuration
 * Streams progress via SSE
 */
router.post('/regenerate', requireManager, (req, res) => {
  const { job, reconnected } = videoOptimizationJobs.connectOrStart(req, res, {
    videoCount: { generated: 0, skipped: 0, errors: 0 }
  });

  if (reconnected) {
    info('[VideoOptimization] Client connecting to existing job');
    return;
  }

  info('[VideoOptimization] Starting video playlist regeneration');

  const scriptPath = path.resolve(__dirname, '../../../scripts/generate-master-playlists.js');
  
  videoOptimizationJobs.startProcess(job, {
    command: 'node',
    args: [scriptPath],
    spawnOptions: {
      cwd: path.resolve(__dirname, '../../../'),
      env: { ...process.env, TERM: 'dumb' } // Disable terminal colors/animations
    },
    onStdoutLine: (line, runningJob) => {
      info(`[VideoOptimization] ${line}`);

      // Parse video counts from script output
      if (runningJob.state.videoCount) {
        const generatedMatch = line.match(/✅ Generated: (\d+)/);
        const skippedMatch = line.match(/⏭️  Skipped: (\d+)/);
        const errorsMatch = line.match(/❌ Errors: (\d+)/);

        if (generatedMatch) runningJob.state.videoCount.generated = parseInt(generatedMatch[1], 10);
        if (skippedMatch) runningJob.state.videoCount.skipped = parseInt(skippedMatch[1], 10);
        if (errorsMatch) runningJob.state.videoCount.errors = parseInt(errorsMatch[1], 10);
      }

      return JSON.stringify({ type: 'stdout', message: line });
    },
    onStderrLine: (line) => {
      warn(`[VideoOptimization] ${line}`);
      return JSON.stringify({ type: 'stderr', message: line });
    },
    onClose: (code, runningJob) => {
      const duration = Date.now() - runningJob.startTime;
      const timeStr = formatDuration(duration);
      const counts = runningJob.state.videoCount;

      const videoCountStr = counts
        ? ` • ${counts.generated} processed${counts.skipped > 0 ? `, ${counts.skipped} skipped` : ''}${counts.errors > 0 ? `, ${counts.errors} failed` : ''}`
        : '';

      const message = code === 0
        ? `✓ Video playlist regeneration complete (${timeStr})${videoCountStr}`
        : `✗ Video playlist regeneration failed with code ${code}`;

      info(`[VideoOptimization] ${message}`);

      const completeOutput = JSON.stringify({
        type: 'complete',
        exitCode: code,
        message
      });

      return completeOutput;
    },
    onComplete: async (code, runningJob) => {
      const duration = Date.now() - runningJob.startTime;
      const timeStr = formatDuration(duration);

      // Send push notification to user
      if (req.user && 'id' in req.user) {
        const userId = (req.user as any).id;
        const titleKey = code === 0 ? 'notifications.backend.videoProcessingComplete' : 'notifications.backend.videoProcessingFailed';
        const bodyKey = code === 0 ? 'notifications.backend.videoPlaylistRegenerationCompleteBody' : 'notifications.backend.videoPlaylistRegenerationFailedBody';

        const batchCounts = runningJob.state.videoCount ?? { generated: 0, skipped: 0, errors: 0 };
        const variables = code === 0
          ? { duration: timeStr, generated: batchCounts.generated, skipped: batchCounts.skipped, errors: batchCounts.errors }
          : { error: `Exit code ${code}` };
        
        const title = await translateNotification(titleKey, variables);
        const body = await translateNotification(bodyKey, variables);
        
        sendNotificationToUser(userId, {
          title,
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'video-optimization',
          requireInteraction: false
        }).catch(err => {
          warn('[VideoOptimization] Failed to send push notification:', err);
        });
      }
    },
    onError: (err) => {
      error('[VideoOptimization] Failed to start script:', err);
      const message = `✗ Failed to start video playlist regeneration: ${err.message}`;

      return JSON.stringify({
        type: 'error',
        message
      });
    }
  });
});

/**
 * POST /api/video-optimization/reprocess
 * Re-encode all videos with current quality settings
 * Streams progress via SSE
 */
router.post('/reprocess', requireManager, (req, res) => {
  const { job, reconnected } = videoOptimizationJobs.connectOrStart(req, res, {});

  if (reconnected) {
    info('[VideoReprocessing] Client connecting to existing job');
    return;
  }

  info('[VideoReprocessing] Starting video reprocessing with current settings');

  const projectRoot = path.resolve(__dirname, '../../../');
  const scriptPath = path.join(projectRoot, 'scripts/reprocess_all_videos.js');
  const tsNodeLoader = path.join(projectRoot, 'node_modules/ts-node/esm.mjs');
  
  videoOptimizationJobs.startProcess(job, {
    command: 'node',
    args: ['--no-warnings', '--loader', tsNodeLoader, scriptPath],
    spawnOptions: {
      cwd: projectRoot,
      env: { ...process.env, TERM: 'dumb', TS_NODE_PROJECT: path.join(projectRoot, 'backend/tsconfig.json') }
    },
    onStdoutLine: (line) => {
      info(`[VideoReprocessing] ${line}`);
      return JSON.stringify({ type: 'stdout', message: line });
    },
    onStderrLine: (line) => {
      warn(`[VideoReprocessing] ${line}`);
      return JSON.stringify({ type: 'stderr', message: line });
    },
    onClose: (code, runningJob) => {
      const duration = Date.now() - runningJob.startTime;
      const timeStr = formatDuration(duration);

      const message = code === 0
        ? `✓ Video reprocessing complete (${timeStr})`
        : `✗ Video reprocessing failed with code ${code}`;

      info(`[VideoReprocessing] ${message}`);

      const completeOutput = JSON.stringify({
        type: 'complete',
        exitCode: code,
        message
      });

      return completeOutput;
    },
    onComplete: async (code, runningJob) => {
      const duration = Date.now() - runningJob.startTime;
      const timeStr = formatDuration(duration);

      // Send push notification to user
      if (req.user && 'id' in req.user) {
        const userId = (req.user as any).id;
        const titleKey = code === 0 ? 'notifications.backend.videoReprocessingComplete' : 'notifications.backend.videoReprocessingFailed';
        const bodyKey = code === 0 ? 'notifications.backend.videoReprocessingBatchCompleteBody' : 'notifications.backend.videoReprocessingBatchFailedBody';

        const variables = code === 0
          ? { duration: timeStr }
          : { error: `Exit code ${code}` };
        
        const title = await translateNotification(titleKey, variables);
        const body = await translateNotification(bodyKey, variables);
        
        sendNotificationToUser(userId, {
          title,
          body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'video-reprocessing',
          requireInteraction: false
        }).catch(err => {
          warn('[VideoReprocessing] Failed to send push notification:', err);
        });
      }
    },
    onError: (err) => {
      error('[VideoReprocessing] Failed to start script:', err);
      const errorMessage = err?.message || err?.toString() || 'Unknown error';
      const message = `✗ Failed to start video reprocessing: ${errorMessage}`;

      return JSON.stringify({
        type: 'error',
        message
      });
    }
  });
});

/**
 * POST /api/video-optimization/stop
 * Stop the running video optimization job
 */
router.post('/stop', requireManager, (req, res) => {
  const runningJob = videoOptimizationJobs.current;

  if (!runningJob || runningJob.isComplete) {
    res.json({ success: false, message: 'No video optimization job running' });
    return;
  }

  try {
    const message = '⏹ Video reprocessing stopped by user';
    videoOptimizationJobs.stop(message, 'SIGTERM', false);
    
    info('[VideoOptimization] Job stopped by user');
    res.json({ success: true, message: 'Video optimization stopped' });
  } catch (err) {
    error('[VideoOptimization] Failed to stop job:', err);
    res.status(500).json({ success: false, message: 'Failed to stop video optimization' });
  }
});

/**
 * POST /api/video-optimization/test-gpu
 * Test NVIDIA GPU hardware acceleration support
 * Streams diagnostic output via SSE
 */
router.post('/test-gpu', requireManager, (req, res) => {
  const { job, reconnected } = gpuDiagnosticJobs.connectOrStart(req, res, {});

  if (reconnected) {
    info('[GPU Test] Client connecting to existing diagnostic');
    return;
  }

  info('[GPU Test] Starting NVIDIA GPU diagnostic test');

  const scriptPath = path.resolve(__dirname, '../../../scripts/test-nvidia-hardware.sh');
  
  gpuDiagnosticJobs.startProcess(job, {
    command: '/bin/bash',
    args: [scriptPath],
    spawnOptions: {
      cwd: path.resolve(__dirname, '../../../'),
      env: { ...process.env }
    },
    onStdoutLine: (line) => {
      info(`[GPU Test] ${line}`);
      return JSON.stringify({ type: 'stdout', message: line });
    },
    onStderrLine: (line) => {
      warn(`[GPU Test] ${line}`);
      return JSON.stringify({ type: 'stderr', message: line });
    },
    onClose: (code) => {
      const exitCode = code || 0;
      const completeMessage = JSON.stringify({
        type: 'complete',
        exitCode,
        message: exitCode === 0
          ? '✓ GPU diagnostic test completed'
          : '✗ GPU diagnostic test completed with errors'
      });

      info(`[GPU Test] Diagnostic completed with exit code: ${exitCode}`);
      return completeMessage;
    },
    onError: (err) => {
      error('[GPU Test] Failed to start diagnostic script:', err);
      return JSON.stringify({
        type: 'error',
        message: `Failed to start GPU test: ${err.message}`
      });
    },
    closeClientsOnComplete: true,
    closeClientsOnError: true
  });
});

export default router;
