/**
 * Telegram Bot API client.
 *
 * A thin, dependency-free wrapper over the HTTP API. It owns exactly three
 * concerns beyond the raw calls:
 *
 *  1. **HTML-first sending with a plain-text fallback.** A malformed entity is
 *     the one Telegram error that must never lose a message, so a rejected
 *     HTML payload is retried once as plain text.
 *  2. **Rate-limit handling.** `429` carries `retry_after`; the client sleeps
 *     and retries instead of surfacing an error the caller cannot act on.
 *  3. **Long-poll offset discipline.** The cursor advances only after a
 *     handler accepted the update, so a thrown handler re-delivers rather
 *     than silently dropping a message.
 */

const DEFAULT_BASE_URL = 'https://api.telegram.org';

/** Telegram's hard caps. */
export const LIMITS = {
  message: 4096,
  caption: 1024,
  callbackData: 64,
  buttonRows: 100,
};

/** Error carrying the Telegram error payload for callers that branch on it. */
export class TelegramApiError extends Error {
  constructor(method, description, code, parameters) {
    super(`telegram ${method} failed: ${description}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.description = description;
    this.code = code;
    this.parameters = parameters;
  }

  /** Whether the failure is an HTML/entity parse problem worth retrying as text. */
  get isParseError() {
    return /can't parse entities|unsupported start tag|unclosed|bad entity|TAG_INVALID/i.test(
      this.description ?? '',
    );
  }

  /** Whether the message is unchanged — an expected, harmless edit outcome. */
  get isNotModified() {
    return /message is not modified/i.test(this.description ?? '');
  }

  /**
   * Whether this Bot API server does not implement the method at all.
   *
   * Distinct from a rejected payload: an unknown method is permanent for this
   * server, so the caller should stop attempting it rather than retrying per
   * message. Telegram answers a missing method with 404 "Not Found".
   */
  get isUnknownMethod() {
    return this.code === 404 || /method not found|unknown method/i.test(this.description ?? '');
  }

  /** Whether the target message no longer exists or cannot be edited. */
  get isGone() {
    return /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(
      this.description ?? '',
    );
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramApi {
  /**
   * @param {string} token bot token
   * @param {{ baseUrl?: string, timeoutMs?: number, logger?: any, fetch?: typeof fetch }} [options]
   */
  constructor(token, options = {}) {
    if (!token) throw new Error('dsh-telegram: a bot token is required');
    this.token = token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = options.logger ?? console;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  get endpoint() {
    return `${this.baseUrl}/bot${this.token}`;
  }

  get fileEndpoint() {
    return `${this.baseUrl}/file/bot${this.token}`;
  }

  /**
   * Invoke one Bot API method.
   *
   * @param {string} method API method name
   * @param {object|FormData} payload request body
   * @param {{ signal?: AbortSignal, timeoutMs?: number, retries?: number }} [options]
   */
  async call(method, payload = {}, options = {}) {
    const retries = options.retries ?? 3;
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const isForm = typeof FormData !== 'undefined' && payload instanceof FormData;
        const response = await this.fetchImpl(`${this.endpoint}/${method}`, {
          method: 'POST',
          headers: isForm ? undefined : { 'content-type': 'application/json' },
          body: isForm ? payload : JSON.stringify(payload),
          signal: controller.signal,
        });

        const body = await response.json().catch(() => ({
          ok: false,
          description: `non-JSON response (HTTP ${response.status})`,
        }));

        if (body.ok) return body.result;

        const error = new TelegramApiError(
          method,
          body.description ?? 'unknown error',
          body.error_code,
          body.parameters,
        );

        // 429: obey the server's own backoff instruction.
        const retryAfter = body.parameters?.retry_after;
        if (retryAfter && attempt < retries) {
          attempt += 1;
          await sleep((retryAfter + 1) * 1000);
          continue;
        }

        // 5xx: transient upstream trouble, worth one bounded retry chain.
        if (body.error_code >= 500 && attempt < retries) {
          attempt += 1;
          await sleep(500 * 2 ** attempt);
          continue;
        }

        throw error;
      } catch (error) {
        if (error instanceof TelegramApiError) throw error;
        if (options.signal?.aborted) throw error;
        if (attempt >= retries) throw error;
        attempt += 1;
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Identity and webhook
   * ---------------------------------------------------------------- */

  getMe(options) {
    return this.call('getMe', {}, options);
  }

  deleteWebhook(options) {
    return this.call('deleteWebhook', { drop_pending_updates: false }, options);
  }

  /* ---------------------------------------------------------------- *
   * Receiving
   * ---------------------------------------------------------------- */

  /**
   * Long-poll updates, advancing the shared cursor only after `onUpdate`
   * resolves. A rejected handler leaves the offset untouched so Telegram
   * redelivers the update on the next poll.
   *
   * @param {{ offset: number }} cursor mutable shared cursor
   * @param {(update: object) => Promise<void>} onUpdate
   * @param {AbortSignal} signal
   * @param {{ timeoutSeconds?: number, allowedUpdates?: string[] }} [options]
   */
  async poll(cursor, onUpdate, signal, options = {}) {
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const allowedUpdates = options.allowedUpdates ?? ['message', 'edited_message', 'callback_query'];

    while (!signal.aborted) {
      let updates;
      try {
        updates = await this.call(
          'getUpdates',
          {
            offset: cursor.offset,
            timeout: timeoutSeconds,
            allowed_updates: allowedUpdates,
          },
          { signal, timeoutMs: (timeoutSeconds + 15) * 1000, retries: 0 },
        );
      } catch (error) {
        if (signal.aborted) return;
        this.logger.warn?.('[dsh-telegram] getUpdates failed; retrying', describe(error));
        await sleep(2000);
        continue;
      }

      for (const update of updates ?? []) {
        if (signal.aborted) return;
        try {
          await onUpdate(update);
        } catch (error) {
          this.logger.error?.('[dsh-telegram] update handler failed', describe(error));
        }
        // Commit after dispatch so a crash mid-handler redelivers.
        if (typeof update.update_id === 'number') {
          cursor.offset = Math.max(cursor.offset, update.update_id + 1);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  /**
   * Send one HTML message, falling back to plain text when Telegram rejects
   * the markup. `plainText` is the caller's already-stripped fallback.
   */
  async sendHtml(chatId, html, { plainText, replyTo, threadId, keyboard, signal, silent } = {}) {
    const body = {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (replyTo) body.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
    if (threadId) body.message_thread_id = Number(threadId);
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    if (silent) body.disable_notification = true;

    try {
      return await this.call('sendMessage', body, { signal });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isParseError) {
        this.logger.warn?.(
          '[dsh-telegram] HTML rejected, retrying as plain text',
          error.description,
        );
        const { parse_mode: _drop, ...rest } = body;
        return this.call(
          'sendMessage',
          { ...rest, text: (plainText ?? stripTags(html)).slice(0, LIMITS.message) },
          { signal },
        );
      }
      throw error;
    }
  }

  /**
   * Send one rich message: a structured document rather than a markup string.
   *
   * This is the only way to send a real table — `sendMessage` rejects
   * `<table>` outright, so the HTML path has to draw one in monospace, and that
   * drawing shears when a phone soft-wraps it.
   *
   * The method is newer than the rest of the Bot API surface, so a deployment
   * may be talking to a server that does not implement it. `richSupported`
   * records the first definitive answer: on an unknown-method error the caller
   * is told to fall back, and every later send skips the doomed round trip.
   *
   * @returns {Promise<object|undefined>} the sent message, or `undefined` when
   *   this server has no rich support and the caller must use HTML instead
   */
  async sendRich(chatId, blocks, { replyTo, threadId, keyboard, signal, silent } = {}) {
    if (this.richSupported === false) return undefined;
    if (!Array.isArray(blocks) || blocks.length === 0) return undefined;

    const body = { chat_id: chatId, rich_message: { blocks } };
    if (replyTo) body.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
    if (threadId) body.message_thread_id = Number(threadId);
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    if (silent) body.disable_notification = true;

    try {
      const sent = await this.call('sendRichMessage', body, { signal });
      this.richSupported = true;
      return sent;
    } catch (error) {
      if (error instanceof TelegramApiError && error.isUnknownMethod) {
        // Permanent for this server: stop trying.
        this.richSupported = false;
        this.logger.warn?.('[dsh-telegram] sendRichMessage unavailable, using HTML');
        return undefined;
      }
      // A malformed document is our bug, not a capability limit. Report it and
      // let the caller fall back so the user still receives the answer.
      this.logger.warn?.('[dsh-telegram] rich send rejected, using HTML', describe(error));
      return undefined;
    }
  }

  /**
   * Edit one message's HTML text. `not modified` resolves quietly — it is the
   * expected outcome when a streaming preview has not changed.
   */
  async editHtml(chatId, messageId, html, { plainText, keyboard, signal } = {}) {
    const body = {
      chat_id: chatId,
      message_id: Number(messageId),
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

    try {
      return await this.call('editMessageText', body, { signal });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isNotModified) return undefined;
      if (error instanceof TelegramApiError && error.isParseError) {
        const { parse_mode: _drop, ...rest } = body;
        try {
          return await this.call(
            'editMessageText',
            { ...rest, text: (plainText ?? stripTags(html)).slice(0, LIMITS.message) },
            { signal },
          );
        } catch (retryError) {
          if (retryError instanceof TelegramApiError && retryError.isNotModified) return undefined;
          throw retryError;
        }
      }
      throw error;
    }
  }

  /** Replace only a message's inline keyboard (used to freeze answered questions). */
  async editKeyboard(chatId, messageId, keyboard, { signal } = {}) {
    try {
      return await this.call(
        'editMessageReplyMarkup',
        {
          chat_id: chatId,
          message_id: Number(messageId),
          reply_markup: keyboard ? { inline_keyboard: keyboard } : {},
        },
        { signal },
      );
    } catch (error) {
      if (error instanceof TelegramApiError && (error.isNotModified || error.isGone)) return undefined;
      throw error;
    }
  }

  /**
   * Upload one media item. `source` is either `{ data, filename }` for bytes
   * or `{ url }` for a public URL / previously uploaded `file_id`.
   */
  async sendMedia(chatId, kind, source, { caption, captionHtml, replyTo, threadId, signal } = {}) {
    const [method, field] = MEDIA_METHODS[kind] ?? MEDIA_METHODS.document;

    const attach = (append) => {
      if (caption || captionHtml) {
        append('caption', (captionHtml ?? caption).slice(0, LIMITS.caption));
        if (captionHtml) append('parse_mode', 'HTML');
      }
      if (replyTo) {
        append(
          'reply_parameters',
          JSON.stringify({ message_id: Number(replyTo), allow_sending_without_reply: true }),
        );
      }
      if (threadId) append('message_thread_id', String(threadId));
    };

    if (source.data) {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(
        field,
        new Blob([source.data], { type: source.mimeType ?? 'application/octet-stream' }),
        source.filename ?? defaultName(kind),
      );
      attach((key, value) => form.append(key, value));
      return this.call(method, form, { signal, timeoutMs: 120_000 });
    }

    const body = { chat_id: chatId, [field]: source.url };
    attach((key, value) => {
      body[key] = key === 'reply_parameters' ? JSON.parse(value) : value;
    });
    return this.call(method, body, { signal });
  }

  /** Send several images as one album. Only the first item carries a caption. */
  async sendMediaGroup(chatId, items, { caption, captionHtml, replyTo, threadId, signal } = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));

    const media = items.map((item, index) => {
      const entry = { type: item.kind === 'video' ? 'video' : 'photo' };
      if (index === 0 && (caption || captionHtml)) {
        entry.caption = (captionHtml ?? caption).slice(0, LIMITS.caption);
        if (captionHtml) entry.parse_mode = 'HTML';
      }
      if (item.data) {
        const name = `file${index}`;
        entry.media = `attach://${name}`;
        form.append(
          name,
          new Blob([item.data], { type: item.mimeType ?? 'application/octet-stream' }),
          item.filename ?? defaultName(item.kind),
        );
      } else {
        entry.media = item.url;
      }
      return entry;
    });

    form.append('media', JSON.stringify(media));
    if (replyTo) {
      form.append(
        'reply_parameters',
        JSON.stringify({ message_id: Number(replyTo), allow_sending_without_reply: true }),
      );
    }
    if (threadId) form.append('message_thread_id', String(threadId));
    return this.call('sendMediaGroup', form, { signal, timeoutMs: 180_000 });
  }

  /* ---------------------------------------------------------------- *
   * Interaction
   * ---------------------------------------------------------------- */

  /** Acknowledge a callback query. Failure here must never break the flow. */
  async answerCallback(callbackQueryId, { text, alert } = {}) {
    try {
      return await this.call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text: text.slice(0, 200) } : {}),
        ...(alert ? { show_alert: true } : {}),
      });
    } catch {
      return undefined;
    }
  }

  /** Best-effort typing indicator. */
  async sendChatAction(chatId, action = 'typing', { threadId } = {}) {
    try {
      return await this.call('sendChatAction', {
        chat_id: chatId,
        action,
        ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      });
    } catch {
      return undefined;
    }
  }

  /** Publish the bot's slash-command menu. */
  async setCommands(commands) {
    try {
      return await this.call('setMyCommands', { commands });
    } catch (error) {
      this.logger.warn?.('[dsh-telegram] setMyCommands failed', describe(error));
      return undefined;
    }
  }

  async deleteMessage(chatId, messageId) {
    try {
      return await this.call('deleteMessage', { chat_id: chatId, message_id: Number(messageId) });
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- *
   * Files
   * ---------------------------------------------------------------- */

  getFile(fileId, options) {
    return this.call('getFile', { file_id: fileId }, options);
  }

  /** Download a file's bytes by `file_id`. */
  async downloadFile(fileId, { signal } = {}) {
    const file = await this.getFile(fileId, { signal });
    if (!file?.file_path) throw new Error('telegram getFile returned no file_path');
    const response = await this.fetchImpl(`${this.fileEndpoint}/${file.file_path}`, { signal });
    if (!response.ok) throw new Error(`telegram file download failed: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    return {
      data,
      name: file.file_name ?? file.file_path.split('/').pop(),
      mimeType: response.headers.get('content-type') ?? undefined,
      size: file.file_size,
    };
  }
}

const MEDIA_METHODS = {
  image: ['sendPhoto', 'photo'],
  photo: ['sendPhoto', 'photo'],
  document: ['sendDocument', 'document'],
  file: ['sendDocument', 'document'],
  audio: ['sendAudio', 'audio'],
  voice: ['sendVoice', 'voice'],
  video: ['sendVideo', 'video'],
  animation: ['sendAnimation', 'animation'],
};

function defaultName(kind) {
  switch (kind) {
    case 'image':
    case 'photo':
      return 'image.png';
    case 'audio':
      return 'audio.mp3';
    case 'voice':
      return 'voice.ogg';
    case 'video':
      return 'video.mp4';
    default:
      return 'file.bin';
  }
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
