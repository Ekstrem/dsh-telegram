/**
 * Assistant reply delivery.
 *
 * Subscribes to `session/event` and turns one Harness turn into Telegram
 * messages. Three properties matter:
 *
 * 1. **Streaming without spam.** Text deltas are throttled into an in-place
 *    `editMessageText` preview, so the user sees progress without the chat
 *    filling with fragments.
 * 2. **Media is delivered as media.** At turn end the final text is scanned for
 *    file references; those become real `sendPhoto` / `sendDocument` uploads.
 * 3. **Only channel-owned turns are delivered.** A session may also be driven
 *    from the Web UI; delivering those to Telegram would duplicate them. The
 *    router tracks which turns it opened.
 */

import { extractMedia, groupForDelivery } from './media.js';
import { LIMITS } from './api.js';
import { renderMarkdown, renderToMessages, toPlainText } from './markdown.js';
import { renderToBlocks } from './rich.js';

/** How often a streaming preview may be edited. */
const PREVIEW_INTERVAL_MS = 1400;
/** Preview text is capped well below the hard limit to leave edit headroom. */
const PREVIEW_LIMIT = 3500;

export class ReplyRouter {
  /**
   * @param {{
   *   api: any, logger?: any, bindings: any,
   *   resolveTarget: (sessionId: string) => object | undefined,
   *   streaming?: boolean,
   *   workspaceRootFor?: (sessionId: string) => string | undefined,
   *   showToolActivity?: boolean,
   * }} options
   */
  constructor(options) {
    this.api = options.api;
    this.logger = options.logger ?? console;
    this.bindings = options.bindings;
    this.resolveTarget = options.resolveTarget;
    this.streaming = options.streaming ?? true;
    this.workspaceRootFor = options.workspaceRootFor ?? (() => undefined);
    this.showToolActivity = options.showToolActivity ?? false;
    /** Prefer `sendRichMessage` (real tables) over HTML for finished answers. */
    this.rich = options.rich ?? true;
    /** sessionId -> active turn state */
    this.active = new Map();
    /** Session ids whose replies belong to this channel. */
    this.ownedTurns = new Set();
  }

  /**
   * Take ownership of a session's replies.
   *
   * Ownership is per SESSION, not per turn. A channel session is created by
   * and for one chat, so every turn it runs — the answer, a follow-up after a
   * tool call, a retry — belongs to that chat.
   *
   * An earlier design claimed a single turn at a time and armed the next claim
   * on each inbound message. That looked more careful but was wrong: turn ids
   * are assigned inside the agent, so a claim armed at send time could be
   * consumed by an unrelated turn (a title generation, a maintenance pass),
   * leaving the real answer unowned and silently dropped. Sessions the channel
   * never wrote to are still ignored, which is what keeps Web-driven
   * conversations out of the chat.
   */
  claimSession(sessionId) {
    this.ownedTurns.add(String(sessionId));
  }

  /** Stop delivering a session's turns (its chat was unbound). */
  releaseSession(sessionId) {
    this.ownedTurns.delete(String(sessionId));
    this.active.delete(String(sessionId));
  }

  owns(sessionId) {
    return this.ownedTurns.has(String(sessionId));
  }

  /** Register the session-event listener; returns a disposer. */
  attach(ctx) {
    return ctx.on('session/event', (session, event) => {
      try {
        this.onEvent(session, event);
      } catch (error) {
        this.logger.error?.('[dsh-telegram] reply router failed', String(error));
      }
    });
  }

  onEvent(session, event) {
    const sessionId = String(session.id);

    switch (event.type) {
      case 'assistant/chunk': {
        const { turn, chunk } = event.data;
        if (chunk?.type !== 'text-delta') return;
        if (!this.owns(sessionId)) return;
        const state = this.ensure(sessionId, turn);
        if (!state) return;
        state.buffer += chunk.text;
        this.schedulePreview(state);
        return;
      }

      case 'assistant/message': {
        const { turn, message } = event.data;
        if (!this.owns(sessionId)) return;
        const state = this.ensure(sessionId, turn);
        if (!state) return;
        const text = textOf(message);
        if (text) state.finalText = text;
        return;
      }

      case 'tool/call': {
        if (!this.showToolActivity) return;
        const { turn } = event.data ?? {};
        if (turn === undefined || !this.owns(sessionId)) return;
        const state = this.active.get(sessionId);
        if (!state) return;
        state.activity = describeTool(event.data);
        this.schedulePreview(state);
        return;
      }

      case 'turn/end': {
        const { turn, reason } = event.data;
        const state = this.active.get(sessionId);

        // A turn can fail before producing a single text delta — an image sent
        // to a text-only model is refused while the request is being built. No
        // delta means no `state`, so the early return below would drop the
        // failure entirely and leave the user staring at a chat that never
        // answers. Report the reason instead: a visible error beats silence.
        if (reason?.kind === 'error') {
          if (!this.owns(sessionId)) return;
          void this.reportFailure(sessionId, state, reason.error);
          return;
        }

        if (!state || state.turn !== turn) return;
        void this.finalize(sessionId, state);
        return;
      }

      default:
    }
  }

  ensure(sessionId, turn) {
    const existing = this.active.get(sessionId);
    if (existing && existing.turn === turn) return existing;
    if (existing) void this.finalize(sessionId, existing);

    const target = this.resolveTarget(sessionId);
    if (!target) return undefined;

    const state = {
      sessionId,
      turn,
      target,
      buffer: '',
      finalText: '',
      activity: undefined,
      previewMessageId: undefined,
      previewText: '',
      timer: undefined,
      flushing: undefined,
      finished: false,
    };
    this.active.set(sessionId, state);
    void this.api.sendChatAction(target.chatId, 'typing', { threadId: target.threadId });
    return state;
  }

  /* ------------------------- streaming preview ------------------------- */

  schedulePreview(state) {
    if (!this.streaming || state.finished || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.flushing = this.flushPreview(state).catch((error) => {
        this.logger.warn?.('[dsh-telegram] preview update failed', String(error));
      });
    }, PREVIEW_INTERVAL_MS);
    state.timer.unref?.();
  }

  async flushPreview(state) {
    if (state.finished) return;
    const source = state.buffer.trim();
    if (!source) return;

    const shown = source.length > PREVIEW_LIMIT ? `${source.slice(0, PREVIEW_LIMIT)}…` : source;
    const suffix = state.activity ? `\n\n<i>${state.activity}</i>` : '\n\n<i>▌</i>';
    const html = renderMarkdown(shown) + suffix;
    if (html === state.previewText) return;
    state.previewText = html;

    if (!state.previewMessageId) {
      const sent = await this.api.sendHtml(state.target.chatId, html, {
        threadId: state.target.threadId,
        replyTo: state.target.replyTo,
        plainText: toPlainText(shown),
      });
      state.previewMessageId = sent?.message_id;
      return;
    }

    await this.api.editHtml(state.target.chatId, state.previewMessageId, html, {
      plainText: toPlainText(shown),
    });
  }

  /* ----------------------------- finalize ------------------------------ */

  async finalize(sessionId, state) {
    if (state.finished) return;
    state.finished = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.flushing) await state.flushing.catch(() => {});
    if (this.active.get(sessionId) === state) this.active.delete(sessionId);

    const source = (state.buffer.trim() || state.finalText.trim()).trim();
    if (!source) {
      // Nothing to say: remove a stale preview rather than leaving a cursor.
      if (state.previewMessageId) {
        await this.api.deleteMessage(state.target.chatId, state.previewMessageId);
      }
      return;
    }

    let text = source;
    let media = [];
    try {
      const extracted = await extractMedia(source, {
        workspaceRoot: this.workspaceRootFor(sessionId),
      });
      media = extracted.items;
      if (media.length > 0) text = extracted.text;
    } catch (error) {
      this.logger.warn?.('[dsh-telegram] media extraction failed', String(error));
    }

    try {
      await this.deliver(state, text, media);
    } catch (error) {
      this.logger.error?.('[dsh-telegram] delivery failed', String(error));
      try {
        await this.api.sendHtml(
          state.target.chatId,
          `⚠️ <i>Не удалось отправить ответ: ${escapeForNotice(String(error))}</i>`,
          { threadId: state.target.threadId },
        );
      } catch {
        // A failure to report a failure is not worth escalating.
      }
    }
  }

  /**
   * Try to deliver the answer as a rich document.
   *
   * Rich messages carry real tables, lists and headings, so they are preferred
   * whenever the server supports them. They cannot be edited in place, though,
   * so the streaming preview is deleted rather than reused — the answer arrives
   * as a fresh message. That trade is worth it for a table that stays a table,
   * and it only happens once, at the end of the turn.
   *
   * @returns {Promise<boolean>} true when the reply was fully delivered
   */
  async deliverRich(state, text) {
    // `typeof` rather than truthiness: an older api object may predate rich
    // support entirely, and calling through would throw away the whole answer
    // instead of quietly using HTML.
    if (!this.rich || typeof this.api.sendRich !== 'function') return false;
    if (this.api.richSupported === false) return false;

    const groups = renderToBlocks(text, LIMITS.message);
    if (groups.length === 0) return false;

    const sent = [];
    for (const [index, blocks] of groups.entries()) {
      const message = await this.api.sendRich(state.target.chatId, blocks, {
        threadId: state.target.threadId,
        replyTo: index === 0 ? state.target.replyTo : undefined,
      });
      // The first send is the capability probe. If it fails, nothing has been
      // delivered yet and the HTML path can take over cleanly.
      if (!message) {
        if (index === 0) return false;
        // A later part failed after earlier ones landed. Falling back now would
        // duplicate what the user already has, so report the gap instead.
        this.logger.error?.('[dsh-telegram] rich delivery stopped part-way');
        return true;
      }
      sent.push(message);
    }

    // Remove the streaming preview only once the real answer is in the chat.
    if (state.previewMessageId) {
      await this.api.deleteMessage(state.target.chatId, state.previewMessageId).catch(() => {});
      state.previewMessageId = undefined;
    }
    return true;
  }

  /**
   * Send the finished reply. The first chunk reuses the streaming preview via
   * `editMessageText`, so the message the user watched becomes the final one.
   */
  async deliver(state, text, media) {
    const messages = renderToMessages(text, LIMITS.message);

    // Short reply with exactly one image: send it as a captioned photo.
    if (media.length === 1 && messages.length === 1 && messages[0].length <= LIMITS.caption) {
      if (state.previewMessageId) {
        await this.api.deleteMessage(state.target.chatId, state.previewMessageId);
        state.previewMessageId = undefined;
      }
      await this.sendMediaItem(state, media[0], messages[0]);
      return;
    }

    if (await this.deliverRich(state, text)) {
      // Rich delivery replaced the preview wholesale.
    } else {
      for (const [index, html] of messages.entries()) {
        if (index === 0 && state.previewMessageId) {
          await this.api.editHtml(state.target.chatId, state.previewMessageId, html, {
            plainText: toPlainText(text),
          });
          continue;
        }
        await this.api.sendHtml(state.target.chatId, html, {
          threadId: state.target.threadId,
          replyTo: index === 0 ? state.target.replyTo : undefined,
          plainText: toPlainText(text),
        });
      }

      if (messages.length === 0 && state.previewMessageId) {
        await this.api.deleteMessage(state.target.chatId, state.previewMessageId);
      }
    }

    for (const group of groupForDelivery(media)) {
      if (group.kind === 'album') {
        await this.api.sendMediaGroup(state.target.chatId, group.items, {
          threadId: state.target.threadId,
        });
        continue;
      }
      await this.sendMediaItem(state, group.item);
    }
  }

  async sendMediaItem(state, item, captionHtml) {
    const source = item.data
      ? { data: item.data, filename: item.filename, mimeType: item.mimeType }
      : { url: item.url };

    const caption =
      captionHtml ?? (item.caption ? renderMarkdown(item.caption).slice(0, LIMITS.caption) : undefined);

    try {
      await this.api.sendMedia(state.target.chatId, item.kind, source, {
        captionHtml: caption,
        threadId: state.target.threadId,
      });
    } catch (error) {
      this.logger.warn?.(
        `[dsh-telegram] media send failed (${item.filename ?? item.url})`,
        String(error),
      );
      // Photo upload can fail on dimension/ratio limits; retry as a document.
      if (item.kind === 'image' && item.data) {
        await this.api.sendMedia(state.target.chatId, 'document', source, {
          captionHtml: caption,
          threadId: state.target.threadId,
        });
      }
    }
  }

  /**
   * Tell the chat that a turn failed.
   *
   * Any partial text already streamed is delivered first — a turn that fails
   * after writing three paragraphs should not throw them away — and the notice
   * follows as its own message so the answer and the failure stay legible.
   */
  async reportFailure(sessionId, state, error) {
    const target = state?.target ?? this.resolveTarget(sessionId);
    if (!target) return;

    if (state) {
      const partial = (state.buffer.trim() || state.finalText.trim()).trim();
      if (partial) {
        await this.finalize(sessionId, state).catch(() => {});
      } else {
        state.finished = true;
        if (state.timer) clearTimeout(state.timer);
        if (this.active.get(sessionId) === state) this.active.delete(sessionId);
        if (state.previewMessageId) {
          await this.api.deleteMessage(target.chatId, state.previewMessageId).catch(() => {});
        }
      }
    }

    try {
      await this.api.sendHtml(target.chatId, describeFailure(error), {
        threadId: target.threadId,
      });
    } catch (sendError) {
      this.logger.error?.('[dsh-telegram] failure notice failed', String(sendError));
    }
  }

  /** Finish every in-flight reply — used on unload. */
  async flushAll() {
    for (const [sessionId, state] of [...this.active.entries()]) {
      await this.finalize(sessionId, state);
    }
  }
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function describeTool(data) {
  const name = data?.name ?? data?.toolName ?? 'инструмент';
  const labels = {
    bash: '⚙️ выполняю команду…',
    read: '📖 читаю файл…',
    write: '✏️ записываю файл…',
    edit: '✏️ правлю файл…',
    glob: '🔍 ищу файлы…',
    grep: '🔍 ищу по содержимому…',
    web_search: '🌐 ищу в интернете…',
    subagent: '🤖 поручаю субагенту…',
    todo_write: '📋 обновляю список задач…',
  };
  return labels[name] ?? `⚙️ использую ${name}…`;
}

/**
 * Turn a turn failure into a message a person can act on.
 *
 * The raw harness message is engine-facing (`pi-ai model "combo" does not
 * support image input`). The common causes each have a concrete remedy, so the
 * notice names it; anything unrecognised still shows the original text rather
 * than hiding behind a generic apology.
 */
function describeFailure(error) {
  const message = String(error?.message ?? error ?? 'неизвестная ошибка');
  const code = error?.code;

  if (code === 'UNSUPPORTED_CONTENT' && /image/i.test(message)) {
    return [
      '⚠️ <b>Текущая модель не принимает изображения.</b>',
      '',
      'Изображение сохранено в диалог, но модель не может его прочитать.',
      'Используйте <code>/model</code>, чтобы переключиться на модель с поддержкой изображений, или',
      '<code>/new</code>, чтобы начать новый диалог и пропустить это изображение.',
      '',
      `<i>${escapeForNotice(message)}</i>`,
    ].join('\n');
  }

  if (code === 'UNSUPPORTED_CONTENT') {
    return `⚠️ <b>Модель не может обработать это содержимое.</b>\n\n<i>${escapeForNotice(message)}</i>`;
  }

  return `⚠️ <b>Ответ не удался.</b>\n\n<i>${escapeForNotice(message)}</i>`;
}

function escapeForNotice(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 300);
}
