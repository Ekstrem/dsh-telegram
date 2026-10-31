/**
 * Telegram-backed `UserQuestionProvider`.
 *
 * `ctx.userQuestions.ask()` blocks a tool call until a human answers. The Web
 * UI ships a provider; a Telegram conversation has none, so `ask_user_question`
 * fails with `NO_PROVIDER` and the agent cannot consult its user. This module
 * supplies that provider for channel-bound sessions.
 *
 * Design decisions:
 *
 * - **Callback data is a token, not the payload.** Telegram caps
 *   `callback_data` at 64 bytes, far too small for option labels. Each pending
 *   question owns a short id and options are addressed by index.
 * - **Questions are asked one at a time.** A batch arrives as a list; asking
 *   them sequentially keeps every keyboard unambiguous.
 * - **The keyboard is frozen on answer.** After a choice the markup is
 *   replaced with the decision, so the transcript records what was chosen and
 *   a stale button cannot be pressed twice.
 * - **Free-text answers are supported.** A "type an answer" button switches the
 *   question into text mode, and the next ordinary message becomes `custom`.
 */

import { escapeHtml, renderInline } from './markdown.js';

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function shortId(length = 6) {
  let id = '';
  for (let i = 0; i < length; i += 1) {
    id += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return id;
}

/** Truncate a button label to Telegram's practical width. */
function buttonLabel(text, max = 60) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export class TelegramQuestions {
  /**
   * @param {{ api: any, logger?: any }} options
   */
  constructor(options) {
    this.api = options.api;
    this.logger = options.logger ?? console;
    /** questionToken -> pending question state */
    this.pending = new Map();
    /** chatId -> questionToken awaiting a typed answer */
    this.awaitingText = new Map();
  }

  /** Whether this chat currently owes a typed answer. */
  isAwaitingText(chatId) {
    return this.awaitingText.has(String(chatId));
  }

  /**
   * Build the provider object registered with `ctx.userQuestions`.
   * `resolveTarget` maps an agent/session to a Telegram chat.
   */
  createProvider(resolveTarget) {
    return {
      ask: async (request) => {
        const target = resolveTarget(request);
        if (!target) {
          // Not a Telegram-bound session: let another provider handle it.
          throw new Error('no telegram binding for this session');
        }
        const answers = [];
        for (const question of request.questions ?? []) {
          answers.push(await this.askOne(target, question, request.signal));
        }
        return { answers };
      },
    };
  }

  /**
   * Ask one question and wait for the human.
   *
   * @param {{ chatId: string|number, threadId?: string }} target
   * @param {object} question the `AskUserQuestionItem`
   * @param {AbortSignal} [signal]
   */
  async askOne(target, question, signal) {
    const token = shortId();
    const options = Array.isArray(question.options) ? question.options : [];
    const multi = Boolean(question.multiSelect) && options.length > 0;

    const html = this.renderQuestion(question, options, multi);
    const keyboard = this.buildKeyboard(token, options, multi);

    const sent = await this.api.sendHtml(target.chatId, html, {
      threadId: target.threadId,
      keyboard,
    });

    return new Promise((resolve, reject) => {
      const state = {
        token,
        question,
        options,
        multi,
        chatId: String(target.chatId),
        messageId: sent.message_id,
        selected: new Set(),
        resolve,
        reject,
        settled: false,
      };

      const finish = (outcome) => {
        if (state.settled) return;
        state.settled = true;
        this.pending.delete(token);
        if (this.awaitingText.get(state.chatId) === token) {
          this.awaitingText.delete(state.chatId);
        }
        signal?.removeEventListener('abort', onAbort);
        outcome();
      };

      state.finish = finish;

      const onAbort = () =>
        finish(() => {
          void this.freeze(state, '⏹ Отменено');
          reject(new Error('question aborted'));
        });

      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(token, state);
    });
  }

  renderQuestion(question, options, multi) {
    const parts = [];
    if (question.header) parts.push(`<b>${escapeHtml(question.header)}</b>`);
    parts.push(renderInline(question.question ?? ''));
    if (question.detail) parts.push('', renderInline(question.detail));
    if (options.length > 0) {
      parts.push('');
      const descriptions = options
        .filter((option) => option.description)
        .map((option) => `• <b>${escapeHtml(option.label)}</b> — ${escapeHtml(option.description)}`);
      if (descriptions.length > 0) parts.push(...descriptions, '');
      parts.push(
        `<i>${multi ? 'Выберите один или несколько пунктов, затем нажмите «Готово».' : 'Нажмите кнопку ниже, чтобы ответить.'}</i>`,
      );
    } else {
      parts.push('', '<i>Ответьте прямо сообщением.</i>');
    }
    return parts.join('\n');
  }

  buildKeyboard(token, options, multi, selected = new Set()) {
    const rows = options.map((option, index) => {
      const chosen = selected.has(index);
      const prefix = multi ? (chosen ? '☑ ' : '☐ ') : '';
      return [{ text: buttonLabel(prefix + option.label), callback_data: `q:${token}:o:${index}` }];
    });

    const controls = [];
    if (multi) controls.push({ text: '✅ Xong', callback_data: `q:${token}:done` });
    controls.push({ text: '✍️ Свой вариант', callback_data: `q:${token}:text` });
    rows.push(controls);
    return rows;
  }

  /**
   * Handle one `callback_query`. Returns true when it belonged to a question.
   */
  async handleCallback(query) {
    const data = String(query.data ?? '');
    if (!data.startsWith('q:')) return false;

    const [, token, action, index] = data.split(':');
    const state = this.pending.get(token);

    if (!state) {
      await this.api.answerCallback(query.id, { text: 'Этот вопрос уже закрыт.' });
      return true;
    }

    if (action === 'o') {
      const position = Number(index);
      const option = state.options[position];
      if (!option) {
        await this.api.answerCallback(query.id, { text: 'Неверный выбор.' });
        return true;
      }

      if (state.multi) {
        if (state.selected.has(position)) state.selected.delete(position);
        else state.selected.add(position);
        await this.api.answerCallback(query.id, { text: option.label });
        await this.api.editKeyboard(
          state.chatId,
          state.messageId,
          this.buildKeyboard(state.token, state.options, true, state.selected),
        );
        return true;
      }

      await this.api.answerCallback(query.id, { text: option.label });
      state.finish(() => {
        void this.freeze(state, `✅ ${option.label}`);
        state.resolve({ id: state.question.id, selected: [option.label] });
      });
      return true;
    }

    if (action === 'done') {
      const labels = [...state.selected].sort((a, b) => a - b).map((i) => state.options[i].label);
      if (labels.length === 0) {
        await this.api.answerCallback(query.id, { text: 'Выберите хотя бы один пункт.' });
        return true;
      }
      await this.api.answerCallback(query.id, { text: `Выбрано пунктов: ${labels.length}` });
      state.finish(() => {
        void this.freeze(state, `✅ ${labels.join(', ')}`);
        state.resolve({ id: state.question.id, selected: labels });
      });
      return true;
    }

    if (action === 'text') {
      this.awaitingText.set(state.chatId, token);
      await this.api.answerCallback(query.id, { text: 'Введите ваш ответ.' });
      await this.api.sendHtml(
        state.chatId,
        '✍️ <i>Жду ваш ответ — отправьте следующее сообщение.</i>',
      );
      return true;
    }

    return true;
  }

  /**
   * Consume a typed answer for a chat awaiting one. Returns true when the
   * message was absorbed as an answer and must not reach the agent.
   */
  async handleText(chatId, text) {
    const key = String(chatId);
    const token = this.awaitingText.get(key);
    if (!token) return false;
    const state = this.pending.get(token);
    this.awaitingText.delete(key);
    if (!state) return false;

    state.finish(() => {
      void this.freeze(state, `✍️ ${text}`);
      state.resolve({ id: state.question.id, selected: [], custom: text });
    });
    return true;
  }

  /** Replace a settled question's keyboard with its recorded decision. */
  async freeze(state, decision) {
    try {
      await this.api.editKeyboard(state.chatId, state.messageId, [
        [{ text: buttonLabel(decision, 64), callback_data: 'q:done:noop' }],
      ]);
    } catch (error) {
      this.logger.warn?.('[dsh-telegram] failed to freeze question keyboard', String(error));
    }
  }

  /** Reject every pending question — used on plugin unload. */
  disposeAll(reason = 'plugin unloaded') {
    for (const state of [...this.pending.values()]) {
      state.finish(() => state.reject(new Error(reason)));
    }
    this.pending.clear();
    this.awaitingText.clear();
  }
}
