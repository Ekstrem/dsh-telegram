/**
 * In-chat control commands.
 *
 * These are handled by the channel itself rather than registered with
 * `ctx.commands`, because they must work before an agent exists (`/new` on a
 * fresh chat) and they answer through Telegram's own affordances — inline
 * keyboards for choices instead of a text prompt.
 *
 * `/model` and `/preset` present their choices as buttons; the selection is
 * applied through the same seams the Web UI uses:
 *   - model  -> `ModelSelectionRef.current` on the live agent (+ optional default save)
 *   - mode   -> a `sandbox/mode` session event
 *   - preset -> recorded for the next session (a live agent cannot swap presets)
 */

import { escapeHtml, renderMarkdown } from './markdown.js';

/** Sandbox modes offered by `/mode`, in increasing order of permission. */
const SANDBOX_MODES = [
  { id: 'read-only', label: '🔒 Только чтение', description: 'Без записи файлов' },
  { id: 'workspace-write', label: '📝 Запись в рабочей папке', description: 'Запись разрешена внутри рабочего каталога' },
  { id: 'danger-full-access', label: '⚠️ Полный доступ', description: 'Запись где угодно — будьте осторожны' },
];

/** One-line label for a session button: title and last activity. */
function formatSessionLabel(session) {
  const title = session.title
    ? String(session.title).replace(/\s+/g, ' ').trim().slice(0, 44)
    : String(session.id).slice(0, 16);
  const stamp = session.updatedAt || session.createdAt;
  const date = stamp ? new Date(stamp).toISOString().slice(0, 16).replace('T', ' ') : '';
  return [title, date].filter(Boolean).join(' · ').slice(0, 64);
}

export const COMMAND_MENU = [
  { command: 'start', description: 'Начать работу с ботом' },
  { command: 'new', description: 'Начать новую сессию' },
  { command: 'sessions', description: 'Подключить чат к сохранённой сессии' },
  { command: 'last', description: 'Показать последний ответ в этой сессии' },
  { command: 'model', description: 'Показать и сменить модель' },
  { command: 'preset', description: 'Сменить профиль агента для новых сессий' },
  { command: 'mode', description: 'Права записи файлов (sandbox)' },
  { command: 'status', description: 'Статус текущей сессии' },
  { command: 'stop', description: 'Остановить текущий ход' },
  { command: 'compact', description: 'Сжать историю диалога' },
  { command: 'clear', description: 'Очистить историю и начать заново' },
  { command: 'help', description: 'Список команд' },
];

export class TelegramCommands {
  /**
   * @param {{
   *   api: any, ctx: any, logger?: any,
   *   bindings: any, sessions: any,
   *   startNewSession: Function,
   *   getAgent: Function,
   * }} options
   */
  constructor(options) {
    this.api = options.api;
    this.ctx = options.ctx;
    this.logger = options.logger ?? console;
    this.bindings = options.bindings;
    this.startNewSession = options.startNewSession;
    this.listSessions = options.listSessions;
    this.listWorkspaces = options.listWorkspaces;
    this.switchSession = options.switchSession;
    this.lastAnswer = options.lastAnswer;
    this.sessionSummary = options.sessionSummary;
    this.getAgent = options.getAgent;
    /** token -> pending choice state, addressed by inline-keyboard callbacks. */
    this.pending = new Map();
  }

  /** Parse `/name rest` including the `/name@botusername` form Telegram uses in groups. */
  static parse(text) {
    const match = /^\/([a-zA-Z][a-zA-Z0-9_]*)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/.exec(String(text).trim());
    if (!match) return undefined;
    return { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() };
  }

  /**
   * Execute a command. Returns true when it was handled (and therefore must
   * not reach the agent).
   */
  async handle(command, target) {
    const handler = this[`cmd_${command.name}`];
    if (typeof handler !== 'function') return false;
    try {
      await handler.call(this, command, target);
    } catch (error) {
      this.logger.error?.(`[dsh-telegram] /${command.name} failed`, String(error));
      await this.reply(target, `⚠️ Команда <code>/${escapeHtml(command.name)}</code>: ошибка — ${escapeHtml(String(error))}`);
    }
    return true;
  }

  reply(target, html, keyboard) {
    return this.api.sendHtml(target.chatId, html, { threadId: target.threadId, keyboard });
  }

  /* ------------------------------------------------------------------ */

  async cmd_help(command, target) {
    const lines = [
      '<b>Доступные команды</b>',
      '',
      ...COMMAND_MENU.map((entry) => `/${entry.command} — ${escapeHtml(entry.description)}`),
      '',
      '<i>Отправьте обычное сообщение, чтобы поговорить с агентом. Изображения и файлы, которые вы пришлёте, агент прочитает.</i>',
    ];
    await this.reply(target, lines.join('\n'));
  }

  async cmd_start(command, target) {
    await this.reply(
      target,
      [
        '<b>Привет! 👋</b>',
        '',
        'Я — агент DeepSeek Harness, работающий через Telegram.',
        'Просто напишите сообщение, чтобы начать, или введите /help, чтобы увидеть команды.',
      ].join('\n'),
    );
  }

  async cmd_new(command, target) {
    const sessionId = await this.startNewSession(target, command.rest);
    await this.reply(
      target,
      `🆕 Новая сессия начата.\n<code>${escapeHtml(String(sessionId).slice(0, 20))}</code>`,
    );
  }

  async cmd_clear(command, target) {
    return this.cmd_new(command, target);
  }

  /**
   * `/sessions` — attach this chat to an existing session.
   *
   * Two steps, mirroring the Web sidebar: a workspace, then a session inside
   * it. Archived and subagent sessions never reach the keyboard, and each list
   * is ordered by the freshest conversation. A choice writes the binding and
   * resumes, so the chat continues that conversation with its history intact.
   */
  async cmd_sessions(command, target) {
    if (typeof this.listWorkspaces !== 'function' || typeof this.switchSession !== 'function') {
      await this.reply(target, 'В этой сборке недоступен выбор сессий.');
      return;
    }

    let groups = [];
    try {
      groups = await this.listWorkspaces();
    } catch (error) {
      this.logger.warn?.('[dsh-telegram] listing sessions failed', String(error));
      await this.reply(
        target,
        `⚠️ Не удалось получить список сессий: ${escapeHtml(String(error?.message ?? error))}`,
      );
      return;
    }

    if (!groups || groups.length === 0) {
      await this.reply(target, 'Сохранённых сессий не найдено.');
      return;
    }

    // A bare argument searches across every workspace instead of walking the menus.
    if (command.rest) {
      const wanted = command.rest.trim().toLowerCase();
      const flat = groups.flatMap((group) => group.sessions);
      const found =
        flat.find((session) => session.id.toLowerCase() === wanted) ??
        flat.find((session) => session.id.toLowerCase().startsWith(wanted)) ??
        flat.find((session) => String(session.title ?? '').toLowerCase().includes(wanted));
      if (!found) {
        await this.reply(target, `Сессия <code>${escapeHtml(command.rest.trim())}</code> не найдена.`);
        return;
      }
      await this.applySession(target, found.id);
      return;
    }

    const choices = groups.slice(0, 40).map((group) => ({
      ...group,
      label: `${group.title} · ${group.sessions.length}`,
    }));
    const token = this.stash({ kind: 'workspace', choices, target });
    const keyboard = choices.map((choice, index) => [
      { text: choice.label, callback_data: `c:${token}:${index}` },
    ]);

    await this.reply(
      target,
      [
        '<b>Выберите рабочую папку</b>',
        '',
        '<i>Дальше — её сессии, от последней к старым. Архивные скрыты.</i>',
      ].join('\n'),
      keyboard,
    );
  }

  /** Second step: the sessions of one workspace, newest first. */
  async showSessionsFor(target, group) {
    const binding = await this.bindings.get(target.key);
    const sessions = (group?.sessions ?? []).slice(0, 40).map((session) => ({
      id: session.id,
      label: formatSessionLabel(session),
      current: binding?.sessionId === session.id,
    }));

    if (sessions.length === 0) {
      await this.reply(target, 'В этой папке нет сохранённых сессий.');
      return;
    }

    const token = this.stash({ kind: 'session', choices: sessions, target });
    const keyboard = sessions.map((choice, index) => [
      {
        text: choice.current ? `✅ ${choice.label}` : choice.label,
        callback_data: `c:${token}:${index}`,
      },
    ]);

    await this.reply(
      target,
      [`<b>${escapeHtml(String(group?.title ?? 'Сессии'))}</b>`, '', '<i>Выберите сессию</i>'].join('\n'),
      keyboard,
    );
  }

  async applySession(target, sessionId) {
    await this.switchSession(target, sessionId);
    await this.reply(
      target,
      `✅ Чат подключён к сессии <code>${escapeHtml(sessionId)}</code>\nНапишите сообщение, чтобы продолжить.`,
    );
    // Show where the conversation left off, so the switch is not a blank page.
    await this.sendLastAnswer(target, { silentWhenEmpty: true });
  }

  /** Send the newest assistant answer of the current session, if any. */
  async sendLastAnswer(target, options = {}) {
    if (typeof this.lastAnswer !== 'function') return;
    let last;
    try {
      last = await this.lastAnswer(target);
    } catch (error) {
      this.logger.warn?.('[dsh-telegram] reading the last answer failed', String(error));
      // Silence here looks like a dead bot; a refused peek is worth reporting.
      if (!options.quietErrors) {
        await this.reply(
          target,
          `⚠️ Не удалось прочитать последний ответ: ${escapeHtml(String(error?.message ?? error))}`,
        );
      }
      return;
    }
    if (!last?.text) {
      if (!options.silentWhenEmpty) {
        await this.reply(target, 'В этой сессии ещё нет ответов агента.');
      }
      return;
    }
    const body = last.text.length > 3200 ? `${last.text.slice(0, 3200)}…` : last.text;
    await this.reply(target, `<b>Последний ответ</b>\n\n${renderMarkdown(body)}`);
  }

  async cmd_last(command, target) {
    await this.sendLastAnswer(target);
  }

  async cmd_status(command, target) {
    const binding = await this.bindings.get(target.key);
    if (!binding) {
      await this.reply(target, 'Сессии пока нет. Отправьте любое сообщение, чтобы начать.');
      return;
    }
    const agent = this.getAgent(binding.sessionId);
    const selection = this.currentSelection(agent);
    const preset = binding.preset ?? '(по умолчанию)';
    const mode = binding.sandboxMode ?? this.defaultSandboxMode() ?? '(по умолчанию)';

    let summary;
    try {
      summary = await this.sessionSummary?.(binding.sessionId);
    } catch {
      summary = undefined;
    }

    const stamp = summary?.updatedAt ?? 0;
    const lines = [
      '<b>Статус сессии</b>',
      '',
      `Название: <b>${escapeHtml(summary?.title ?? '(без названия)')}</b>`,
      `Сессия: <code>${escapeHtml(String(binding.sessionId))}</code>`,
      stamp ? `Последняя активность: ${new Date(stamp).toISOString().slice(0, 16).replace('T', ' ')}` : '',
      `Статус: ${agent ? (agent.status === 'running' ? '🟢 выполняется' : '⚪️ простаивает') : '💤 не загружена'}`,
      `Model: <code>${escapeHtml(selection ? `${selection.provider}/${selection.model}` : 'неизвестно')}</code>`,
      `Профиль агента: <code>${escapeHtml(preset)}</code>`,
      `Доступ к файлам: <code>${escapeHtml(mode)}</code>`,
      `Каталог: <code>${escapeHtml(summary?.cwd ?? binding.cwd ?? '(по умолчанию)')}</code>`,
    ].filter(Boolean);
    await this.reply(target, lines.join('\n'));
  }

  async cmd_stop(command, target) {
    const binding = await this.bindings.get(target.key);
    const agent = binding && this.getAgent(binding.sessionId);
    if (!agent) {
      await this.reply(target, 'Сейчас нет запущенного хода.');
      return;
    }
    agent.cancel('user-interrupt');
    await this.reply(target, '⏹ Запрошена остановка текущего хода.');
  }

  async cmd_compact(command, target) {
    const compaction = this.ctx.get('compaction');
    if (!compaction) {
      await this.reply(target, 'В этой сборке нет сервиса сжатия истории.');
      return;
    }
    const binding = await this.bindings.get(target.key);
    const agent = binding && this.getAgent(binding.sessionId);
    if (!agent) {
      await this.reply(target, 'Нет активной сессии для сжатия.');
      return;
    }
    await this.reply(target, '🗜 Сжимаю историю…');
    const controller = new AbortController();
    const result = await compaction.compactNow(agent, controller.signal);
    await this.reply(
      target,
      result ? '✅ История диалога сжата.' : 'История ещё слишком короткая для сжатия.',
    );
  }

  /* ---------------------------- model ------------------------------ */

  async cmd_model(command, target) {
    const llm = this.ctx.get('llm');
    if (!llm) {
      await this.reply(target, 'В этой сборке нет сервиса LLM.');
      return;
    }

    // `/model provider/model` applies directly, skipping the picker.
    if (command.rest) {
      await this.applyModel(target, command.rest);
      return;
    }

    const providers = llm.listProviders();
    const choices = [];
    for (const provider of providers) {
      let models = [];
      try {
        models = await llm.listModels(provider.id);
      } catch (error) {
        this.logger.warn?.(`[dsh-telegram] listModels(${provider.id}) failed`, String(error));
      }
      for (const model of models) {
        choices.push({ provider: provider.id, model: model.id, label: `${provider.displayName ?? provider.id} · ${model.name ?? model.id}` });
      }
      if (models.length === 0) {
        choices.push({ provider: provider.id, model: undefined, label: `${provider.displayName ?? provider.id} · (введите имя модели)` });
      }
    }

    if (choices.length === 0) {
      await this.reply(target, 'Зарегистрированных провайдеров не найдено.');
      return;
    }

    const binding = await this.bindings.get(target.key);
    const agent = binding && this.getAgent(binding.sessionId);
    const current = this.currentSelection(agent);
    const token = this.stash({ kind: 'model', choices, target });

    const keyboard = choices.slice(0, 40).map((choice, index) => [
      {
        text:
          current && current.provider === choice.provider && current.model === choice.model
            ? `✅ ${choice.label}`
            : choice.label,
        callback_data: `c:${token}:${index}`,
      },
    ]);

    await this.reply(
      target,
      [
        '<b>Выберите модель</b>',
        '',
        current
          ? `Сейчас: <code>${escapeHtml(`${current.provider}/${current.model}`)}</code>`
          : 'Текущая модель неизвестна.',
        '',
        '<i>Или введите: /model провайдер/модель</i>',
      ].join('\n'),
      keyboard,
    );
  }

  async applyModel(target, spec) {
    const separator = spec.indexOf('/');
    const provider = separator > 0 ? spec.slice(0, separator) : undefined;
    const model = separator > 0 ? spec.slice(separator + 1) : spec;
    if (!provider || !model) {
      await this.reply(target, 'Синтаксис: <code>/model провайдер/модель</code>');
      return;
    }
    await this.selectModel(target, provider, model);
  }

  async selectModel(target, provider, model) {
    const llm = this.ctx.get('llm');
    let resolved;
    try {
      resolved = await llm.resolveCallConfig({ provider, model });
    } catch (error) {
      await this.reply(target, `⚠️ Эту модель использовать нельзя: ${escapeHtml(String(error))}`);
      return;
    }

    const selection = { provider: resolved.provider, model: resolved.model };
    const binding = await this.bindings.get(target.key);
    const agent = binding && this.getAgent(binding.sessionId);

    let applied = false;
    if (agent) {
      const ref = this.selectionRefs?.get(agent);
      if (ref) {
        ref.current = selection;
        applied = true;
      }
    }

    // Persist as the default so later sessions inherit it.
    const defaults = this.ctx.get('agentDefaultModel');
    try {
      await defaults?.saveSelection(selection);
    } catch (error) {
      this.logger.warn?.('[dsh-telegram] saving the default model failed', String(error));
    }

    await this.bindings.patch(target.key, { model: selection.model, provider: selection.provider });

    await this.reply(
      target,
      [
        `✅ Model: <code>${escapeHtml(`${selection.provider}/${selection.model}`)}</code>`,
        applied
          ? 'Применено к этой сессии сразу.'
          : 'Применится со следующего хода.',
      ].join('\n'),
    );
  }

  /* ---------------------------- preset ----------------------------- */

  async cmd_preset(command, target) {
    const presets = this.ctx.get('agentPresets');
    if (!presets) {
      await this.reply(target, 'В этой сборке нет профилей агента.');
      return;
    }

    const available = await presets.list();
    const usable = available.filter((preset) => !preset.broken);
    if (usable.length === 0) {
      await this.reply(target, 'Доступных профилей нет.');
      return;
    }

    if (command.rest) {
      const chosen = usable.find((preset) => preset.id === command.rest);
      if (!chosen) {
        await this.reply(
          target,
          `Нет профиля <code>${escapeHtml(command.rest)}</code>. Доступные: ${usable.map((p) => p.id).join(', ')}`,
        );
        return;
      }
      await this.applyPreset(target, chosen.id);
      return;
    }

    const binding = await this.bindings.get(target.key);
    const token = this.stash({ kind: 'preset', choices: usable.map((p) => ({ id: p.id, label: p.name ?? p.id })), target });

    const keyboard = usable.map((preset, index) => [
      {
        text: binding?.preset === preset.id ? `✅ ${preset.name ?? preset.id}` : (preset.name ?? preset.id),
        callback_data: `c:${token}:${index}`,
      },
    ]);

    await this.reply(
      target,
      [
        '<b>Выберите профиль агента</b>',
        '',
        ...usable.map((preset) => `• <b>${escapeHtml(preset.name ?? preset.id)}</b> — ${escapeHtml(preset.description ?? preset.id)}`),
        '',
        '<i>Новый профиль применится к следующей сессии.</i>',
      ].join('\n'),
      keyboard,
    );
  }

  async applyPreset(target, presetId) {
    await this.bindings.patch(target.key, { preset: presetId });
    await this.reply(
      target,
      `✅ Профиль агента: <code>${escapeHtml(presetId)}</code>\nИспользуйте /new, чтобы открыть новую сессию с этим профилем.`,
    );
  }

  /* ----------------------------- mode ------------------------------ */

  async cmd_mode(command, target) {
    if (command.rest) {
      const chosen = SANDBOX_MODES.find((mode) => mode.id === command.rest);
      if (!chosen) {
        await this.reply(target, `Неверный режим. Выберите один из: ${SANDBOX_MODES.map((m) => m.id).join(', ')}`);
        return;
      }
      await this.applyMode(target, chosen.id);
      return;
    }

    const binding = await this.bindings.get(target.key);
    const current = binding?.sandboxMode ?? this.defaultSandboxMode();
    const token = this.stash({ kind: 'mode', choices: SANDBOX_MODES, target });

    const keyboard = SANDBOX_MODES.map((mode, index) => [
      { text: current === mode.id ? `✅ ${mode.label}` : mode.label, callback_data: `c:${token}:${index}` },
    ]);

    await this.reply(
      target,
      [
        '<b>Права записи файлов</b>',
        '',
        ...SANDBOX_MODES.map((mode) => `• <b>${escapeHtml(mode.label)}</b> — ${escapeHtml(mode.description)}`),
        '',
        current ? `Сейчас: <code>${escapeHtml(current)}</code>` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      keyboard,
    );
  }

  async applyMode(target, modeId) {
    await this.bindings.patch(target.key, { sandboxMode: modeId });
    const binding = await this.bindings.get(target.key);
    const agent = binding && this.getAgent(binding.sessionId);
    if (agent) {
      try {
        agent.session.append({ type: 'sandbox/mode', data: { mode: modeId } });
      } catch (error) {
        this.logger.warn?.('[dsh-telegram] writing sandbox/mode failed', String(error));
      }
    }
    await this.reply(target, `✅ Права записи: <code>${escapeHtml(modeId)}</code>`);
  }

  defaultSandboxMode() {
    try {
      return this.ctx.get('sandboxPolicy')?.resolve()?.mode;
    } catch {
      return undefined;
    }
  }

  currentSelection(agent) {
    if (agent) {
      const ref = this.selectionRefs?.get(agent);
      if (ref?.current) return ref.current;
      const header = agent.session.requestHeader?.()?.config;
      if (header) return { provider: header.provider, model: header.model };
    }
    return this.ctx.get('agentDefaultModel')?.currentSelection();
  }

  /* --------------------------- callbacks --------------------------- */

  stash(state) {
    const token = Math.random().toString(36).slice(2, 8);
    this.pending.set(token, state);
    // Choice keyboards are short-lived; drop them after ten minutes.
    setTimeout(() => this.pending.delete(token), 10 * 60_000).unref?.();
    return token;
  }

  /** Handle a `c:` callback produced by a command keyboard. */
  async handleCallback(query) {
    const data = String(query.data ?? '');
    if (!data.startsWith('c:')) return false;

    const [, token, indexText] = data.split(':');
    const state = this.pending.get(token);
    if (!state) {
      await this.api.answerCallback(query.id, { text: 'Этот выбор устарел.' });
      return true;
    }

    const choice = state.choices[Number(indexText)];
    if (!choice) {
      await this.api.answerCallback(query.id, { text: 'Неверный выбор.' });
      return true;
    }

    this.pending.delete(token);
    await this.api.answerCallback(query.id, { text: choice.label ?? choice.id });
    await this.api.editKeyboard(state.target.chatId, query.message?.message_id, [
      [{ text: `✅ ${choice.label ?? choice.id}`, callback_data: 'c:done:noop' }],
    ]);

    if (state.kind === 'model') {
      if (!choice.model) {
        await this.reply(state.target, `Введите: <code>/model ${escapeHtml(choice.provider)}/имя-модели</code>`);
        return true;
      }
      await this.selectModel(state.target, choice.provider, choice.model);
    } else if (state.kind === 'preset') {
      await this.applyPreset(state.target, choice.id);
    } else if (state.kind === 'mode') {
      await this.applyMode(state.target, choice.id);
    } else if (state.kind === 'workspace') {
      await this.showSessionsFor(state.target, choice);
    } else if (state.kind === 'session') {
      await this.applySession(state.target, choice.id);
    }

    return true;
  }
}
