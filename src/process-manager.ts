/**
 * Process Manager for RelayPlane Proxy
 *
 * Spawns the proxy as a child process, monitors health,
 * handles crashes with exponential backoff restarts.
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { type CircuitBreaker } from './circuit-breaker.js';

export interface ProcessManagerOptions {
  /** Command to spawn (default: process.execPath) */
  command?: string;
  /** Arguments for the command (default: launcher path) */
  args?: string[];
  /** Environment variables for the child process */
  env?: Record<string, string>;
  /** Initial restart delay in ms (default: 60000) */
  restartDelayMs?: number;
  /** Max restart delay in ms (default: 300000 = 5 min) */
  maxRestartDelayMs?: number;
  /** Max restart attempts within the window (default: 5) */
  maxRestartAttempts?: number;
  /** Window for counting restart attempts in ms (default: 600000 = 10 min) */
  restartWindowMs?: number;
  /** Circuit breaker instance to mark OPEN on crash */
  circuitBreaker?: CircuitBreaker;
}

export class ProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly restartDelayMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly maxRestartAttempts: number;
  private readonly restartWindowMs: number;
  private readonly circuitBreaker?: CircuitBreaker;

  private restartTimestamps: number[] = [];
  private currentDelay: number;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private started = false;

  constructor(opts: ProcessManagerOptions = {}) {
    super();
    this.command = opts.command ?? process.execPath;
    this.args = opts.args ?? [path.join(__dirname, 'launcher.js')];
    this.env = opts.env ?? {};
    this.restartDelayMs = opts.restartDelayMs ?? 60_000;
    this.maxRestartDelayMs = opts.maxRestartDelayMs ?? 300_000;
    this.maxRestartAttempts = opts.maxRestartAttempts ?? 5;
    this.restartWindowMs = opts.restartWindowMs ?? 600_000;
    this.circuitBreaker = opts.circuitBreaker;
    this.currentDelay = this.restartDelayMs;
  }

  /** Start the proxy child process. */
  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.started = true;
    this.spawnChild();
  }

  /** Stop the proxy child process. */
  stop(): void {
    this.stopping = true;
    this.started = false;
    this.clearRestartTimer();
    if (this.child) {
      this.child.removeAllListeners();
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.emit('stopped');
  }

  /** Restart the proxy (stop then start). */
  restart(): void {
    this.stop();
    this.start();
  }

  /** Whether the child process is currently running. */
  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** Get the PID of the child process, or null if not running. */
  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Clean up resources. */
  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }

  private spawnChild(): void {
    try {
      const child = spawn(this.command, this.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.env },
      });

      // Handle spawn error (command not found, etc.)
      child.on('error', (err: Error) => {
        console.error(`[relayplane] Failed to spawn proxy: ${err.message}`);
        this.child = null;
        this.circuitBreaker?.recordFailure();
        this.emit('error', err);
        if (!this.stopping) {
          this.scheduleRestart();
        }
      });

      // Pipe stdout with prefix
      child.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          console.log(`[relayplane] ${line}`);
        }
      });

      // Pipe stderr with prefix
      child.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          console.error(`[relayplane] ${line}`);
        }
      });

      // Handle exit
      child.on('exit', (code, signal) => {
        this.child = null;
        if (this.stopping) return;

        console.error(`[relayplane] Proxy exited (code=${code}, signal=${signal})`);
        // Mark circuit breaker OPEN on crash
        this.circuitBreaker?.recordFailure();
        this.emit('crash', { code, signal });
        this.scheduleRestart();
      });

      this.child = child;
      this.emit('started', { pid: child.pid });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[relayplane] Failed to spawn proxy: ${error.message}`);
      this.child = null;
      this.circuitBreaker?.recordFailure();
      this.emit('error', error);
      if (!this.stopping) {
        this.scheduleRestart();
      }
    }
  }

  private scheduleRestart(): void {
    if (this.stopping) return;

    const now = Date.now();
    // Prune old timestamps outside the window
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => now - t < this.restartWindowMs
    );

    if (this.restartTimestamps.length >= this.maxRestartAttempts) {
      console.error(
        `[relayplane] Max restart attempts (${this.maxRestartAttempts}) reached within ${this.restartWindowMs / 1000}s window. Giving up.`
      );
      this.emit('maxRestartsExceeded');
      return;
    }

    this.restartTimestamps.push(now);

    console.log(`[relayplane] Scheduling restart in ${this.currentDelay / 1000}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) {
        this.spawnChild();
      }
    }, this.currentDelay);

    // Exponential backoff
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxRestartDelayMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // Reset backoff on manual stop/restart
    this.currentDelay = this.restartDelayMs;
  }
}
