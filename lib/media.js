/**
 * Media extraction from assistant replies.
 *
 * The agent has no Telegram-specific output vocabulary: it writes markdown and
 * mentions files by path. This module finds the media those replies refer to,
 * so `sendPhoto` / `sendDocument` can carry real bytes instead of the text of
 * a filesystem path.
 *
 * Three shapes are recognised, in order of confidence:
 *   1. `![alt](path-or-url)`            — an explicit image embed
 *   2. `[label](path)` to a media file  — an explicit file link
 *   3. A bare path on its own line      — the shape agents produce most often
 *
 * Safety: only files inside the session workspace are read, and only up to a
 * size cap. A path that escapes the workspace is left as text; the message
 * still sends, it just does not carry the bytes.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Extensions Telegram renders natively as photos. */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.oga', '.wav', '.m4a', '.flac', '.opus']);

/** Extensions worth uploading as documents when named explicitly. */
const DOCUMENT_EXT = new Set([
  '.pdf', '.csv', '.json', '.txt', '.md', '.zip', '.tar', '.gz', '.tgz',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.svg', '.html', '.log', '.yaml', '.yml',
]);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.zip': 'application/zip',
  '.html': 'text/html', '.yaml': 'text/yaml', '.yml': 'text/yaml',
};

const URL_BODY = '(?:[^()\\s]|\\([^()\\s]*\\))+';
const IMAGE_EMBED = new RegExp(`!\\[([^\\]]*)\\]\\((${URL_BODY})(?:\\s+"[^"]*")?\\)`, 'g');
const FILE_LINK = new RegExp(`(?<!!)\\[([^\\]]+)\\]\\((${URL_BODY})(?:\\s+"[^"]*")?\\)`, 'g');

/** Classify a path or URL by extension. */
export function classify(target) {
  const clean = String(target).split(/[?#]/)[0];
  const ext = path.extname(clean).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (DOCUMENT_EXT.has(ext)) return 'document';
  return undefined;
}

export function mimeFor(target) {
  const ext = path.extname(String(target).split(/[?#]/)[0]).toLowerCase();
  return MIME_BY_EXT[ext];
}

function isHttpUrl(target) {
  return /^https?:\/\//i.test(String(target).trim());
}

/**
 * Resolve a referenced path against the workspace and confirm it stays inside.
 * Returns `undefined` for anything outside — the caller then leaves it as text.
 */
export function resolveInsideWorkspace(reference, workspaceRoot) {
  if (!workspaceRoot) return undefined;
  let candidate = String(reference).trim();
  if (candidate.startsWith('file://')) {
    try {
      candidate = new URL(candidate).pathname;
    } catch {
      return undefined;
    }
  }
  candidate = decodeURIComponent(candidate);
  const absolute = path.resolve(workspaceRoot, candidate);
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return absolute;
}

/**
 * Find every media reference in an assistant reply.
 *
 * @param {string} markdown the reply text
 * @param {{ workspaceRoot?: string, maxBytes?: number, maxItems?: number }} options
 * @returns {Promise<{ items: Array, text: string }>} items to upload and the
 *   reply text with consumed references removed
 */
export async function extractMedia(markdown, options = {}) {
  const source = String(markdown ?? '');
  const maxBytes = options.maxBytes ?? 45 * 1024 * 1024;
  const maxItems = options.maxItems ?? 10;
  const workspaceRoot = options.workspaceRoot;

  const items = [];
  const consumed = new Set();
  const seen = new Set();

  const add = async (reference, label, kindHint, matchText) => {
    if (items.length >= maxItems) return false;
    if (seen.has(reference)) return false;

    const kind = kindHint ?? classify(reference);
    if (!kind) return false;

    // Remote URL: hand the URL straight to Telegram, no download needed.
    if (isHttpUrl(reference)) {
      seen.add(reference);
      items.push({ kind, url: reference.trim(), caption: label, source: 'url' });
      if (matchText) consumed.add(matchText);
      return true;
    }

    const absolute = resolveInsideWorkspace(reference, workspaceRoot);
    if (!absolute) return false;

    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size === 0 || info.size > maxBytes) return false;
      const data = await readFile(absolute);
      seen.add(reference);
      items.push({
        kind,
        data: new Uint8Array(data),
        filename: path.basename(absolute),
        mimeType: mimeFor(absolute),
        caption: label,
        source: 'file',
        bytes: info.size,
        digest: createHash('sha1').update(data).digest('hex').slice(0, 12),
      });
      if (matchText) consumed.add(matchText);
      return true;
    } catch {
      return false;
    }
  };

  // 1. Explicit image embeds.
  for (const match of source.matchAll(IMAGE_EMBED)) {
    await add(match[2], match[1] || undefined, undefined, match[0]);
  }

  // 2. Explicit links pointing at media files.
  for (const match of source.matchAll(FILE_LINK)) {
    const kind = classify(match[2]);
    if (!kind) continue;
    // A remote http link to a document reads better as a link than as an upload.
    if (isHttpUrl(match[2]) && kind === 'document') continue;
    await add(match[2], match[1] || undefined, kind, match[0]);
  }

  // 3. Bare local paths on their own line.
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, '').replace(/[.,;:]$/, '');
    if (!line || line.length > 512) continue;
    if (/\s/.test(line) && !/^[./~]/.test(line)) continue;
    const unquoted = line.replace(/^[`"']|[`"']$/g, '');
    if (!classify(unquoted)) continue;
    if (isHttpUrl(unquoted)) continue;
    await add(unquoted, undefined, undefined, rawLine.trim());
  }

  return { items, text: stripConsumed(source, consumed) };
}

/**
 * Remove the reference text that became an upload, so the caption does not
 * repeat a path the user can now see as an attachment. Lines that held only a
 * reference disappear entirely; inline references leave the surrounding
 * sentence intact.
 */
function stripConsumed(source, consumed) {
  if (consumed.size === 0) return source;
  const lines = source.split('\n');
  const kept = [];

  for (const line of lines) {
    let next = line;
    for (const fragment of consumed) {
      if (next.includes(fragment)) next = next.split(fragment).join('');
    }
    const emptied = next.trim() === '' && line.trim() !== '';
    const bulletOnly = /^\s*[-*+]\s*$/.test(next) && line.trim() !== '';
    if (emptied || bulletOnly) continue;
    kept.push(next);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Group extracted items for delivery: consecutive photos/videos become one
 * album (Telegram allows 2..10 per group), everything else sends alone.
 */
export function groupForDelivery(items) {
  const groups = [];
  let album = [];

  const flushAlbum = () => {
    if (album.length === 0) return;
    groups.push(album.length === 1 ? { kind: 'single', item: album[0] } : { kind: 'album', items: album });
    album = [];
  };

  for (const item of items) {
    if (item.kind === 'image' || item.kind === 'video') {
      album.push(item);
      if (album.length === 10) flushAlbum();
      continue;
    }
    flushAlbum();
    groups.push({ kind: 'single', item });
  }
  flushAlbum();
  return groups;
}
