/**
 * Durable conversation -> session bindings.
 *
 * A Telegram chat must map to the same Harness session across restarts, or
 * every reconnect would lose the conversation. The mapping is a small JSON
 * file written atomically (temp file + rename), so a crash mid-write leaves
 * the previous mapping intact rather than a truncated one.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;

/** Stable key for one Telegram conversation. */
export function conversationKey(chatId, threadId) {
  return threadId ? `tg:${chatId}:${threadId}` : `tg:${chatId}`;
}

export class BindingStore {
  /**
   * @param {{ file: string, logger?: any }} options
   */
  constructor(options) {
    this.file = options.file;
    this.logger = options.logger ?? console;
    this.cache = undefined;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = parsed?.bindings ?? {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.('[dsh-telegram] binding file unreadable; starting empty', String(error));
      }
      this.cache = {};
    }
    return this.cache;
  }

  async get(key) {
    const bindings = await this.load();
    return bindings[key];
  }

  async all() {
    return { ...(await this.load()) };
  }

  /**
   * Ensure a binding exists, minting a session id when absent.
   * @returns {Promise<{ binding: object, created: boolean }>}
   */
  async ensure(key, seed = {}) {
    const bindings = await this.load();
    const existing = bindings[key];
    if (existing) return { binding: existing, created: false };

    const binding = {
      key,
      sessionId: `tg-${randomUUID()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      ...seed,
    };
    bindings[key] = binding;
    await this.flush();
    return { binding, created: true };
  }

  /** Merge fields into an existing binding. */
  async patch(key, patch) {
    const bindings = await this.load();
    const existing = bindings[key];
    if (!existing) return undefined;
    bindings[key] = { ...existing, ...patch, updatedAt: Date.now() };
    await this.flush();
    return bindings[key];
  }

  /** Point a conversation at a fresh session, keeping its settings. */
  async rotate(key) {
    const bindings = await this.load();
    const existing = bindings[key];
    const next = {
      ...(existing ?? { key, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION }),
      sessionId: `tg-${randomUUID()}`,
      updatedAt: Date.now(),
    };
    bindings[key] = next;
    await this.flush();
    return next;
  }

  /** Reverse lookup used when routing an agent's reply back to its chat. */
  async findBySession(sessionId) {
    const bindings = await this.load();
    return Object.values(bindings).find((binding) => binding.sessionId === sessionId);
  }

  /** Serialize writes; the last queued write wins. */
  flush() {
    this.writeQueue = this.writeQueue.then(() => this.writeNow()).catch((error) => {
      this.logger.error?.('[dsh-telegram] failed to persist bindings', String(error));
    });
    return this.writeQueue;
  }

  async writeNow() {
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, bindings: this.cache ?? {} }, null, 2);
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, payload, 'utf8');
    await rename(temp, this.file);
  }
}
