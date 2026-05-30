/**
 * Optimization Stream Route
 * Provides a single SSE endpoint for tracking all photo optimizations
 */

import express from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { requireAuth } from '../auth/middleware.js';
import { error, warn, info, debug, verbose } from '../utils/logger.js';
import {
  createOptimizationJob,
  getRecentOptimizationJobs,
  updateOptimizationJob
} from '../database.js';

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

// Set of all connected SSE clients
const clients = new Set<express.Response>();

// Job queue for sequential optimization
interface QueuedJob {
  jobId: string;
  album: string;
  filename: string;
  scriptPath: string;
  projectRoot: string;
  onProgress: (progress: number) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

const optimizationQueue: QueuedJob[] = [];
const activeJobs: Set<ChildProcess> = new Set();
const MAX_CONCURRENT_JOBS = 4; // Reduced from 8 to prevent memory exhaustion
const optimizationLocks = new Map<string, string>();

export function acquireOptimizationLock(scope: string, owner: string): boolean {
  if (scope === '*') {
    if (optimizationLocks.size > 0) return false;
  } else if (optimizationLocks.has('*') || optimizationLocks.has(scope)) {
    return false;
  }

  optimizationLocks.set(scope, owner);
  return true;
}

export function releaseOptimizationLock(scope: string, owner: string): void {
  if (optimizationLocks.get(scope) === owner) {
    optimizationLocks.delete(scope);
    queueMicrotask(() => {
      processQueue().catch(err => {
        error('[OptimizationStream] Failed to process queue after lock release:', err);
      });
    });
  }
}

export function getOptimizationLockConflict(scope: string): string | null {
  if (scope === '*') {
    const activeOwner = optimizationLocks.values().next().value;
    return activeOwner ?? null;
  }

  return optimizationLocks.get('*') ?? optimizationLocks.get(scope) ?? null;
}

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
  
  clients.forEach(client => {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (err) {
      // Client disconnected, will be cleaned up
    }
  });

  if (update.progress !== undefined || update.state === 'complete' || update.state === 'error') {
    const status = update.state === 'complete'
      ? 'complete'
      : update.state === 'error'
        ? 'failed'
        : update.state === 'queued'
          ? 'queued'
          : 'running';
    updateOptimizationJob(jobId, {
      status,
      progress: update.progress ?? null,
      error: update.error ?? null
    });
  }
}

/**
 * Process the optimization queue (up to MAX_CONCURRENT_JOBS at a time)
 */
async function processQueue() {
  // Process jobs while we have space and jobs in queue
  while (activeJobs.size < MAX_CONCURRENT_JOBS && optimizationQueue.length > 0) {
    const job = optimizationQueue.shift()!;
    const lockScope = job.album;
    if (!acquireOptimizationLock(lockScope, job.jobId)) {
      optimizationQueue.unshift(job);
      break;
    }

    // info(`[OptimizationStream] Starting ${job.jobId} (${activeJobs.size + 1}/${MAX_CONCURRENT_JOBS} active, ${optimizationQueue.length} queued)`);

    // Update job state to optimizing
    broadcastOptimizationUpdate(job.jobId, {
      album: job.album,
      filename: job.filename,
      progress: 0,
      state: 'optimizing'
    });

    // Spawn optimization process with DATA_DIR environment variable
    const childProcess = spawn('node', [job.scriptPath, job.album, job.filename], {
      cwd: job.projectRoot,
      env: {
        ...process.env,
        DATA_DIR: process.env.DATA_DIR || path.join(job.projectRoot, 'data')
      }
    });

    activeJobs.add(childProcess);
    updateOptimizationJob(job.jobId, {
      pid: childProcess.pid ?? null,
      status: 'running',
      progress: 0
    });

    // Track whether this job has already settled (completed, errored, or
    // timed out) so timeout/close/error each only run side-effects once.
    // Without this, a timeout SIGTERM later triggers `close` with a
    // non-zero code, double-firing onError and double-decrementing the
    // active-job slot. See ticket #627.
    let settled = false;

    // Add timeout to prevent hung processes (5 minutes)
    const timeout = setTimeout(() => {
      error(`[OptimizationStream] Job ${job.jobId} timed out after 5 minutes, killing process`);
      childProcess.kill('SIGTERM');
      if (settled) return;
      settled = true;
      releaseOptimizationLock(lockScope, job.jobId);
      activeJobs.delete(childProcess);
      updateOptimizationJob(job.jobId, {
        status: 'failed',
        error: 'Optimization timed out'
      });
      job.onError('Optimization timed out');
      processQueue();
    }, 5 * 60 * 1000);

    // Handle stdout for progress updates
    childProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line: string) => {
        if (line.trim() && line.startsWith('PROGRESS:')) {
          const parts = line.substring(9).split(':');
          const progress = parseInt(parts[0]);
          job.onProgress(progress);
        }
      });
    });

    // Handle stderr
    childProcess.stderr?.on('data', (data) => {
      const errorOutput = data.toString().trim();
      if (errorOutput) {
        error(`[${job.album}/${job.filename}] Optimization stderr:`, errorOutput);
      }
    });

    // Handle completion
    childProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      releaseOptimizationLock(lockScope, job.jobId);
      activeJobs.delete(childProcess);

      if (code === 0) {
        updateOptimizationJob(job.jobId, {
          status: 'complete',
          progress: 100
        });
        job.onComplete();
        // info(`[OptimizationStream] Completed ${job.jobId} (${activeJobs.size}/${MAX_CONCURRENT_JOBS} active, ${optimizationQueue.length} queued)`);
      } else {
        updateOptimizationJob(job.jobId, {
          status: 'failed',
          error: `Optimization failed with code ${code}`
        });
        job.onError(`Optimization failed with code ${code}`);
        error(`[OptimizationStream] Failed ${job.jobId} with code ${code} (${activeJobs.size}/${MAX_CONCURRENT_JOBS} active, ${optimizationQueue.length} queued)`);
      }

      // Process next job in queue
      processQueue();
    });

    // Handle errors
    childProcess.on('error', (err) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      releaseOptimizationLock(lockScope, job.jobId);
      activeJobs.delete(childProcess);
      error(`[OptimizationStream] Error in job ${job.jobId}:`, err);
      updateOptimizationJob(job.jobId, {
        status: 'failed',
        error: err.message
      });
      job.onError(err.message);
      processQueue();
    });
  }
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
  createOptimizationJob({
    id: jobId,
    type: 'image-upload',
    album,
    filename,
    status: 'queued',
    progress: 0
  });

  // Add to queue
  optimizationQueue.push({
    jobId,
    album,
    filename,
    scriptPath,
    projectRoot,
    onProgress,
    onComplete,
    onError
  });

  // Set initial state as queued
  broadcastOptimizationUpdate(jobId, {
    album,
    filename,
    progress: 0,
    state: 'queued'
  });

  // info(`[OptimizationStream] Added ${jobId} to queue (position: ${optimizationQueue.length})`);

  // Start processing if not already running
  processQueue();
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
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setTimeout(0);
  res.flushHeaders();

  // Add client to set
  clients.add(res);
  // info(`[Optimization Stream] Client connected (${clients.size} total)`);

  // Send current state of all active jobs
  const activeJobs = Array.from(optimizationJobs.entries()).map(([jobId, job]) => ({
    jobId,
    ...job
  }));
  const recentPersistedJobs = getRecentOptimizationJobs(20).map(job => ({
    jobId: job.id,
    album: job.album,
    filename: job.filename,
    progress: job.progress ?? 0,
    state: job.status === 'complete' ? 'complete' : job.status === 'failed' || job.status === 'stopped' ? 'error' : 'queued',
    error: job.error ?? undefined,
    startTime: new Date(job.started_at).getTime(),
    persisted: true
  }));
  
  if (activeJobs.length > 0 || recentPersistedJobs.length > 0) {
    res.write(`data: ${JSON.stringify({ 
      type: 'initial-state',
      jobs: [...activeJobs, ...recentPersistedJobs]
    })}\n\n`);
  }

  // Touch session to keep it alive
  if (req.session) {
    req.session.touch();
  }

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
    if (req.session) {
      req.session.touch();
    }
  }, 30000); // Every 30 seconds

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    // info(`[Optimization Stream] Client disconnected (${clients.size} remaining)`);
  });
});

export default router;
