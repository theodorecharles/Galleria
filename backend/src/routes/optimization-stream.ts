/**
 * Optimization Stream Route
 * Provides a single SSE endpoint for tracking all photo optimizations
 */

import express from 'express';
import path from 'path';
import { requireAuth } from '../auth/middleware.js';
import { error } from '../utils/logger.js';
import { QueuedJobRunner, SseBroadcaster } from '../services/job-runner.js';

const router = express.Router();

// Track ongoing optimization jobs
interface OptimizationJob {
  album: string;
  filename: string;
  progress: number;
  state: 'queued' | 'optimizing' | 'generating-title' | 'complete' | 'error' | 'rotation' | '240p' | '360p' | '720p' | '1080p' | 'thumbnail' | 'modal-preview';
  error?: string;
  title?: string;
  message?: string;
  startTime: number;
}

// Map of jobId -> OptimizationJob
const optimizationJobs = new Map<string, OptimizationJob>();

const MAX_CONCURRENT_JOBS = 4; // Reduced from 8 to prevent memory exhaustion
const optimizationEvents = new SseBroadcaster({
  keepAliveSession: true,
  heartbeatMs: 30000
});
const optimizationRunner = new QueuedJobRunner({
  maxConcurrentJobs: MAX_CONCURRENT_JOBS
});

/**
 * Broadcast update to all connected clients
 */
export function broadcastOptimizationUpdate(jobId: string, update: Partial<OptimizationJob>) {
  const job = optimizationJobs.get(jobId);
  if (job) {
    Object.assign(job, update);
  } else {
    // Create new job if it doesn't exist
    optimizationJobs.set(jobId, {
      album: update.album!,
      filename: update.filename!,
      progress: update.progress || 0,
      state: update.state || 'optimizing',
      startTime: Date.now(),
      ...update
    });
  }
  
  // Broadcast to all clients
  const message = JSON.stringify({
    type: 'optimization-update',
    jobId,
    ...optimizationJobs.get(jobId)
  });
  
  optimizationEvents.broadcast(message);
}

/**
 * Add optimization job to queue
 */
export function queueOptimizationJob(
  jobId: string,
  album: string,
  filename: string,
  scriptPath: string,
  projectRoot: string,
  onProgress: (progress: number) => void,
  onComplete: () => void,
  onError: (error: string) => void
) {
  // Set initial state as queued before enqueueing because enqueueing may start immediately.
  broadcastOptimizationUpdate(jobId, {
    album,
    filename,
    progress: 0,
    state: 'queued'
  });

  optimizationRunner.enqueue({
    jobId,
    scriptPath,
    args: [album, filename],
    cwd: projectRoot,
    env: {
      ...process.env,
      DATA_DIR: process.env.DATA_DIR || path.join(projectRoot, 'data')
    },
    onStart: () => {
      broadcastOptimizationUpdate(jobId, {
        album,
        filename,
        progress: 0,
        state: 'optimizing'
      });
    },
    onStdout: (line: string) => {
      if (line.startsWith('PROGRESS:')) {
        const parts = line.substring(9).split(':');
        const progress = parseInt(parts[0]);
        onProgress(progress);
      }
    },
    onStderr: (errorOutput: string) => {
      error(`[${album}/${filename}] Optimization stderr:`, errorOutput);
    },
    onComplete,
    onError: (jobError: string) => {
      if (jobError === 'Optimization timed out') {
        error(`[OptimizationStream] Job ${jobId} timed out after 5 minutes, killing process`);
      } else {
        error(`[OptimizationStream] Failed ${jobId}: ${jobError}`);
      }
      onError(jobError);
    }
  });
  // info(`[OptimizationStream] Added ${jobId} to queue`);
}

/**
 * Clean up completed jobs after 5 minutes
 */
function cleanupOldJobs() {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  
  for (const [jobId, job] of optimizationJobs.entries()) {
    if ((job.state === 'complete' || job.state === 'error') && job.startTime < fiveMinutesAgo) {
      optimizationJobs.delete(jobId);
    }
  }
}

// Cleanup old jobs every minute
setInterval(cleanupOldJobs, 60 * 1000);

/**
 * GET /api/optimization-stream
 * SSE endpoint for optimization updates
 */
router.get('/', requireAuth, (req, res) => {
  optimizationEvents.attach(req, res, () => {
    // Send current state of all active jobs
    const activeJobs = Array.from(optimizationJobs.entries()).map(([jobId, job]) => ({
      jobId,
      ...job
    }));
    
    if (activeJobs.length > 0) {
      res.write(`data: ${JSON.stringify({ 
        type: 'initial-state',
        jobs: activeJobs
      })}\n\n`);
    }
  });
});

export default router;
