import { spawn, ChildProcess, SpawnOptionsWithoutStdio } from "child_process";
import { Request, Response } from "express";

export interface RunningJob<TState extends object = Record<string, unknown>> {
  process: ChildProcess | null;
  output: string[];
  clients: Set<Response>;
  startTime: number;
  isComplete: boolean;
  state: TState;
}

export interface StartJobResult<TState extends object> {
  job: RunningJob<TState>;
  reconnected: boolean;
}

export interface ProcessJobOptions<TState extends object> {
  command: string;
  args?: string[];
  spawnOptions?: SpawnOptionsWithoutStdio;
  onStdoutLine?: (line: string, job: RunningJob<TState>) => string | string[] | undefined;
  onStderrLine?: (line: string, job: RunningJob<TState>) => string | string[] | undefined;
  onClose?: (code: number | null, job: RunningJob<TState>) => string | undefined | Promise<string | undefined>;
  onComplete?: (code: number | null, job: RunningJob<TState>) => void | Promise<void>;
  onError?: (err: Error, job: RunningJob<TState>) => string | undefined;
  closeClientsOnComplete?: boolean;
  cleanupOnComplete?: boolean;
  closeClientsOnError?: boolean;
  cleanupOnError?: boolean;
}

interface JobManagerOptions {
  cleanupDelayMs?: number;
  cacheControl?: string;
  keepAliveSession?: boolean;
  heartbeatMs?: number;
  onClientDisconnect?: (remainingClients: number) => void;
}

export class JobManager<TState extends object = Record<string, unknown>> {
  private runningJob: RunningJob<TState> | null = null;
  private readonly cleanupDelayMs: number;
  private readonly cacheControl: string;
  private readonly keepAliveSession: boolean;
  private readonly heartbeatMs: number | null;
  private readonly onClientDisconnect?: (remainingClients: number) => void;

  constructor(options: JobManagerOptions = {}) {
    this.cleanupDelayMs = options.cleanupDelayMs ?? 5 * 60 * 1000;
    this.cacheControl = options.cacheControl ?? "no-cache";
    this.keepAliveSession = options.keepAliveSession ?? false;
    this.heartbeatMs = options.heartbeatMs ?? null;
    this.onClientDisconnect = options.onClientDisconnect;
  }

  get current(): RunningJob<TState> | null {
    return this.runningJob;
  }

  get isRunning(): boolean {
    return !!this.runningJob && !this.runningJob.isComplete;
  }

  getStatus(): { running: false } | { running: true; output: string[]; isComplete: boolean } {
    if (!this.runningJob) {
      return { running: false };
    }

    return {
      running: true,
      output: this.runningJob.output,
      isComplete: this.runningJob.isComplete
    };
  }

  connectOrStart(req: Request, res: Response, state: TState): StartJobResult<TState> {
    if (this.runningJob && !this.runningJob.isComplete) {
      this.attachClient(req, res, this.runningJob, true);
      return { job: this.runningJob, reconnected: true };
    }

    const job: RunningJob<TState> = {
      process: null,
      output: [],
      clients: new Set<Response>(),
      startTime: Date.now(),
      isComplete: false,
      state
    };

    this.runningJob = job;
    this.attachClient(req, res, job, false);
    return { job, reconnected: false };
  }

  attachClient(req: Request, res: Response, job: RunningJob<TState>, replayOutput = true): void {
    this.writeSseHeaders(res);

    if (replayOutput) {
      job.output.forEach(line => {
        res.write(`data: ${line}\n\n`);
      });
    }

    job.clients.add(res);

    let heartbeat: NodeJS.Timeout | null = null;
    if (this.keepAliveSession) {
      req.session?.touch();
    }

    if (this.heartbeatMs) {
      heartbeat = setInterval(() => {
        try {
          res.write(": heartbeat\n\n");
          if (this.keepAliveSession) {
            req.session?.touch();
          }
        } catch {
          if (heartbeat) {
            clearInterval(heartbeat);
          }
        }
      }, this.heartbeatMs);
    }

    req.on("close", () => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      job.clients.delete(res);
      this.onClientDisconnect?.(job.clients.size);
    });
  }

  writeSseHeaders(res: Response): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", this.cacheControl);
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setTimeout(0);
    res.flushHeaders();
  }

  startProcess(job: RunningJob<TState>, options: ProcessJobOptions<TState>): ChildProcess | null {
    if (this.runningJob !== job) {
      return null;
    }

    const childProcess = spawn(options.command, options.args ?? [], options.spawnOptions);
    job.process = childProcess;

    childProcess.stdout?.on("data", data => {
      this.handleOutputLines(job, data, options.onStdoutLine);
    });

    childProcess.stderr?.on("data", data => {
      this.handleOutputLines(job, data, options.onStderrLine);
    });

    childProcess.on("close", async code => {
      if (this.runningJob !== job || job.isComplete) {
        return;
      }

      const message = await options.onClose?.(code, job);
      const completed = this.complete(job, message, {
        closeClients: options.closeClientsOnComplete,
        cleanup: false
      });

      if (!completed) {
        return;
      }

      await options.onComplete?.(code, job);

      if (options.cleanupOnComplete !== false) {
        this.complete(job);
      }
    });

    childProcess.on("error", err => {
      if (this.runningJob !== job || job.isComplete) {
        return;
      }

      const message = options.onError?.(err, job);
      this.complete(job, message, {
        closeClients: options.closeClientsOnError,
        cleanup: options.cleanupOnError
      });
    });

    return childProcess;
  }

  append(job: RunningJob<TState>, message: string): void {
    if (this.runningJob !== job) {
      return;
    }

    job.output.push(message);
    this.broadcast(job, message);
  }

  broadcast(job: RunningJob<TState>, message: string): void {
    job.clients.forEach(client => {
      try {
        client.write(`data: ${message}\n\n`);
      } catch {
        // Disconnected clients are removed by the request close handler.
      }
    });
  }

  complete(job: RunningJob<TState>, message?: string, options: { closeClients?: boolean; cleanup?: boolean } = {}): boolean {
    if (this.runningJob !== job) {
      return false;
    }

    if (message !== undefined) {
      job.output.push(message);
      this.broadcast(job, message);
    }

    job.isComplete = true;

    if (options.closeClients) {
      this.closeClients(job);
    }

    if (options.cleanup !== false) {
      this.scheduleCleanup(job);
    }

    return true;
  }

  stop(message: string, signal: NodeJS.Signals = "SIGTERM", closeClients = true): boolean {
    const job = this.runningJob;
    if (!job || job.isComplete) {
      return false;
    }

    job.process?.kill(signal);
    this.complete(job, message, { closeClients });
    return true;
  }

  closeClients(job: RunningJob<TState>): void {
    job.clients.forEach(client => {
      try {
        client.end();
      } catch {
        // Ignore disconnect races.
      }
    });
    job.clients.clear();
  }

  private scheduleCleanup(job: RunningJob<TState>): void {
    setTimeout(() => {
      if (this.runningJob === job) {
        this.runningJob = null;
      }
    }, this.cleanupDelayMs);
  }

  private handleOutputLines(
    job: RunningJob<TState>,
    data: Buffer,
    onLine?: (line: string, job: RunningJob<TState>) => string | string[] | undefined
  ): void {
    if (this.runningJob !== job || job.isComplete) {
      return;
    }

    data.toString().split("\n").forEach((line: string) => {
      if (!line.trim()) {
        return;
      }

      const messages = onLine?.(line, job);
      if (!messages) {
        return;
      }

      const output = Array.isArray(messages) ? messages : [messages];
      output.forEach(message => this.append(job, message));
    });
  }
}

interface SseBroadcasterOptions {
  cacheControl?: string;
  keepAliveSession?: boolean;
  heartbeatMs?: number;
}

export class SseBroadcaster {
  private readonly clients = new Set<Response>();
  private readonly cacheControl: string;
  private readonly keepAliveSession: boolean;
  private readonly heartbeatMs: number | null;

  constructor(options: SseBroadcasterOptions = {}) {
    this.cacheControl = options.cacheControl ?? "no-cache";
    this.keepAliveSession = options.keepAliveSession ?? false;
    this.heartbeatMs = options.heartbeatMs ?? null;
  }

  attach(req: Request, res: Response, onConnect?: () => void): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", this.cacheControl);
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setTimeout(0);
    res.flushHeaders();

    this.clients.add(res);
    onConnect?.();

    let heartbeat: NodeJS.Timeout | null = null;
    if (this.keepAliveSession) {
      req.session?.touch();
    }

    if (this.heartbeatMs) {
      heartbeat = setInterval(() => {
        try {
          res.write(": heartbeat\n\n");
          if (this.keepAliveSession) {
            req.session?.touch();
          }
        } catch {
          if (heartbeat) {
            clearInterval(heartbeat);
          }
        }
      }, this.heartbeatMs);
    }

    req.on("close", () => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      this.clients.delete(res);
    });
  }

  broadcast(message: string): void {
    this.clients.forEach(client => {
      try {
        client.write(`data: ${message}\n\n`);
      } catch {
        // Disconnected clients are removed by the request close handler.
      }
    });
  }
}

export interface QueuedJob {
  jobId: string;
  scriptPath: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStart?: () => void;
  onStdout?: (line: string) => void;
  onStderr?: (output: string) => void;
  onComplete: () => void;
  onError: (error: string) => void;
}

interface QueuedJobRunnerOptions {
  maxConcurrentJobs: number;
  timeoutMs?: number;
  spawnCommand?: string;
  spawnOptions?: SpawnOptionsWithoutStdio;
  onQueueDrained?: () => void;
}

export class QueuedJobRunner {
  private readonly queue: QueuedJob[] = [];
  private readonly activeJobs = new Set<ChildProcess>();
  private readonly maxConcurrentJobs: number;
  private readonly timeoutMs: number;
  private readonly spawnCommand: string;
  private readonly spawnOptions?: SpawnOptionsWithoutStdio;
  private readonly onQueueDrained?: () => void;

  constructor(options: QueuedJobRunnerOptions) {
    this.maxConcurrentJobs = options.maxConcurrentJobs;
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.spawnCommand = options.spawnCommand ?? "node";
    this.spawnOptions = options.spawnOptions;
    this.onQueueDrained = options.onQueueDrained;
  }

  enqueue(job: QueuedJob): number {
    this.queue.push(job);
    this.processQueue();
    return this.queue.length;
  }

  private processQueue(): void {
    while (this.activeJobs.size < this.maxConcurrentJobs && this.queue.length > 0) {
      const job = this.queue.shift()!;
      job.onStart?.();

      const childProcess = spawn(this.spawnCommand, [job.scriptPath, ...job.args], {
        ...this.spawnOptions,
        cwd: job.cwd,
        env: job.env
      });

      this.activeJobs.add(childProcess);
      let settled = false;

      const timeout = setTimeout(() => {
        childProcess.kill("SIGTERM");
        if (settled) return;
        settled = true;
        this.activeJobs.delete(childProcess);
        job.onError("Optimization timed out");
        this.processQueue();
      }, job.timeoutMs ?? this.timeoutMs);

      childProcess.stdout?.on("data", data => {
        data.toString().split("\n").forEach((line: string) => {
          if (line.trim()) {
            job.onStdout?.(line);
          }
        });
      });

      childProcess.stderr?.on("data", data => {
        const output = data.toString().trim();
        if (output) {
          job.onStderr?.(output);
        }
      });

      childProcess.on("close", code => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        this.activeJobs.delete(childProcess);

        if (code === 0) {
          job.onComplete();
        } else {
          job.onError(`Optimization failed with code ${code}`);
        }

        this.processQueue();
      });

      childProcess.on("error", err => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        this.activeJobs.delete(childProcess);
        job.onError(err.message);
        this.processQueue();
      });
    }

    if (this.queue.length === 0 && this.activeJobs.size === 0) {
      this.onQueueDrained?.();
    }
  }
}
