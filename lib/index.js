/**
 * dsh-telegram — a Telegram channel for DeepSeek Harness.
 *
 * Composition entry. It wires five collaborators together and owns nothing
 * else:
 *
 *   api        Telegram Bot API client            (api.js)
 *   bindings   durable chat -> session mapping     (bindings.js)
 *   questions  inline-keyboard question provider   (questions.js)
 *   commands   in-chat control plane               (commands.js)
 *   replies    turn -> Telegram message delivery   (reply.js)
 *
 * Inbound routing order matters, and is deliberate:
 *   1. a chat awaiting a typed question answer consumes the message
 *   2. a slash command is handled by the channel
 *   3. anything else becomes agent input
 *
 * The bot token is read from `ctx.credentials`, never from plugin config, so
 * it does not appear in composed-config dumps or logs.
 */

import path from 'node:path';
import { homedir } from 'node:os';

import Schema from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { TelegramApi } from './api.js';
import { BindingStore, conversationKey } from './bindings.js';
import { COMMAND_MENU, TelegramCommands } from './commands.js';
import { ReplyRouter } from './reply.js';
import { TelegramQuestions } from './questions.js';
import { escapeHtml } from './markdown.js';
import { translator } from './i18n.js';
import { installQuestionRouting } from './question-routing.js';
import { decideStart, isLiveChange, registerSettings } from './settings.js';

export const name = 'dsh-telegram-ex';

/**
 * Services the channel waits for before starting.
 *
 * `ctx.get()` reads the store directly but returns `undefined` while the
 * providing fiber is not yet active, so a service used during startup —
 * notably `credentials`, which supplies the bot token — must be declared here
 * or it would silently read as missing.
 *
 * Deliberately absent: `agentPresets`, `compaction`, `sandboxPolicy`, and
 * `sessionPersistence`. Those are consulted only while handling a command, long
 * after boot, so `ctx.get()` resolves them by then and a composition that omits
 * one degrades that single command instead of stalling the whole channel.
 */
export const inject = [
  'agents',
  'llm',
  'credentials',
  'userQuestions',
  'agentDefaultModel',
  'attachments',
  'workspaceRegistry',
  // `settings` is NOT listed here on purpose. The channel must still run on a
  // composition that provides no settings service — it then reads its entry
  // config and simply offers no settings card. `registerSettings` waits for
  // the service with its own `ctx.inject`, so requiring it here would turn an
  // optional feature into a startup dependency.
];

/**
 * Plugin configuration. The bot token is deliberately absent: only its
 * credential reference lives here, so the secret never appears in a composed
 * config dump, a log line, or a profile file.
 */
export const Config = Schema.object({
  /** Turn the channel off without removing it from the profile. */
  enabled: Schema.boolean().default(true),
  /** Имя credential с токеном бота. */
  tokenRef: Schema.string().default('TELEGRAM_BOT_TOKEN'),
  /** Telegram user ids allowed to talk to the bot. Empty means everyone. */
  allowedUsers: Schema.array(Schema.string()).default([]),
  /** Working directory for channel sessions. Defaults to the process cwd. */
  workspaceRoot: Schema.string(),
  /** Edit one message in place while the answer streams. */
  streaming: Schema.boolean().default(true),
  /** Показывать, какой инструмент выполняет агент inside the streaming preview. */
  showToolActivity: Schema.boolean().default(true),
  /** Agent preset for new channel sessions. */
  preset: Schema.string(),
  /**
   * Как обращаться с закрытой сессией.
   *
   * `live-only` (по умолчанию): не поднимать её из плагина — поднятый так агент
   * получает только глобальные инструменты и теряет `read`/`edit`/`pwsh`.
   * Сообщение сохраняется и доставляется, когда сессию откроют в DSH.
   *
   * `resume` — поднимать с диска (прежнее поведение, инструменты могут отвалиться).
   */
  wake: Schema.string().default('live-only'),
  /** Сколько часов держать сообщение, ждущее открытия сессии. */
  pendingTtlHours: Schema.number().default(6),
  /**
   * Раз в сколько минут досоздавать топики для новых сессий (0 — выключено).
   *
   * «Автообновление топиков»: появилась сессия в папке, у которой уже есть
   * топики, — она получит свой топик без ручного `/topics`.
   */
  autoTopicsMinutes: Schema.number().default(0),
  /**
   * Зеркалить в чат/топик **все** ответы привязанной сессии, а не только те ходы,
   * что начаты из Telegram. Нужно, чтобы видеть работу ролей, которую запускает
   * мост LoopMaker или веб-интерфейс.
   */
  mirrorAnswers: Schema.boolean().default(false),
  /** Where the conversation -> session map is stored. */
  bindingFile: Schema.string(),
});

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx);

  /**
   * Live settings, layered over the composition's entry config.
   *
   * `options()` is called at each use rather than captured once, so a value the
   * user edits in the Settings page reaches the next message.
   *
   * Some fields cannot be swapped under a running poller: the token reference
   * names a different bot, and the workspace root decides where sessions run.
   * A plugin cannot restart itself — `ctx.scope` is not a readable property
   * (cordis' proxy refuses it without an inject declaration) and `ctx.effect`
   * returns a disposer, not a restart handle; the Fiber that owns `restart()`
   * belongs to whoever called `ctx.plugin`. So those changes are persisted and
   * announced, and take effect at the next start rather than being silently
   * accepted and quietly ignored.
   */
  const settings = registerSettings(ctx, config, (next, prev) => {
    if (isLiveChange(next, prev)) {
      logger.info('[dsh-telegram] settings applied');
      return;
    }
    logger.warn(
      '[dsh-telegram] settings saved, but the bot token or workspace root ' +
        'only takes effect after DSH restarts',
    );
  });

  /** Resolved configuration: user settings win, entry config is the floor. */
  const options = () => ({ ...config, ...(settings?.current() ?? {}) });

  if (options().enabled === false) return;

  /**
   * The plugin's own context, captured OUTSIDE `ctx.effect`.
   *
   * `ctx.agents.create()` binds the new agent's lifetime to the calling fiber.
   * Creating one from inside the effect made every agent a child of that
   * short-lived fiber, so `followup()` returned normally while the message was
   * discarded — the session existed but never grew past its header. Agents must
   * outlive a single effect run, so they are created from the plugin fiber.
   */
  const pluginCtx = ctx;

  ctx.effect(async () => {
    // Snapshot the fields that cannot change under a running poller. A change
    // to any of these tears the channel down and starts it again, so reading
    // them once here is correct; everything else is read live via `options()`.
    const startup = options();
    if (startup.enabled === false) return () => {};

    const token = await resolveToken(ctx, startup.tokenRef, logger);
    if (!token) {
      logger.warn(
        `[dsh-telegram] credential "${startup.tokenRef}" is not set; the channel stays idle`,
      );
      return () => {};
    }

    const api = new TelegramApi(token, { logger });

    let me;
    try {
      me = await api.getMe();
    } catch (error) {
      logger.error('[dsh-telegram] bot authentication failed; the channel stays idle', String(error));
      return () => {};
    }
    logger.info(`[dsh-telegram] connected as @${me.username}`);

    const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
    const bindings = new BindingStore({
      file: startup.bindingFile ?? path.join(dshHome, 'dsh-telegram', 'bindings.json'),
      logger,
    });

    const workspaceRoot = startup.workspaceRoot ?? process.cwd();

    /* ---------------- agent bookkeeping ---------------- */

    /** sessionId -> owned agent handle */
    const handles = new Map();
    /** agent -> its ModelSelectionRef, so /model can retarget a live agent */
    const selectionRefs = new WeakMap();
    /** conversation key -> promise chain, serializing that chat's messages */
    const chains = new Map();
    /**
     * sessionId -> ключ разговора, который писал в неё последним.
     *
     * Нужен для ответов: одна сессия может быть привязана к нескольким чатам
     * (личка + топик), и поиск «первой привязки» отправлял ответ не туда.
     */
    const lastTargetBySession = new Map();
    /** ключ разговора -> сообщение, ждущее открытия сессии */
    const pendingWake = new Map();

    const getAgent = (sessionId) => handles.get(sessionId)?.agent ?? pluginCtx.agents.get(sessionId);

    const targetForSession = (sessionId) => {
      const cached = bindings.cache ? Object.values(bindings.cache) : [];
      const preferredKey = lastTargetBySession.get(sessionId);
      // Приоритет — тот чат/топик, откуда пришло сообщение; иначе первая привязка.
      const binding =
        (preferredKey ? cached.find((entry) => entry.key === preferredKey) : undefined) ??
        cached.find((entry) => entry.sessionId === sessionId);
      if (!binding) return undefined;
      return {
        chatId: binding.chatId,
        threadId: binding.threadId,
        key: binding.key,
      };
    };

    /* ---------------- collaborators ---------------- */

    /**
     * The persistence service, resolved the way the rest of the harness does.
     *
     * A bare `ctx.get()` answers only for a service the calling fiber declared,
     * so the dependency is injected instead; `get` stays as a fallback for a
     * composition that provides it later in the boot.
     */
    let persistenceService;
    ctx.inject(['sessionPersistence'], (childCtx) => {
      persistenceService = childCtx.sessionPersistence;
      return () => {
        persistenceService = undefined;
      };
    });
    const resolvePersistence = () => persistenceService ?? ctx.get('sessionPersistence');

    /**
     * The projection cache holding session titles and list metadata.
     *
     * Optional by design: a composition without it still lists sessions, just
     * without titles. Injected for the same reason as persistence — a bare
     * `get` on an undeclared dependency is not reliable.
     */
    let projectionCacheService;
    ctx.inject(['sessionProjectionCache'], (childCtx) => {
      projectionCacheService = childCtx.sessionProjectionCache;
      return () => {
        projectionCacheService = undefined;
      };
    });
    const resolveProjectionCache = () =>
      projectionCacheService ?? ctx.get('sessionProjectionCache');

    /**
     * Every resumable session, newest conversation first.
     *
     * Archived sessions and subagent sessions are filtered out here rather than
     * in the command, so every caller inherits the same list. Titles and the
     * "last activity" stamp come from the projection cache; a cache that cannot
     * answer costs decoration, never the listing.
     */
    const collectSessions = async () => {
      const persistence = resolvePersistence();
      if (!persistence || typeof persistence.list !== 'function') {
        throw new Error('сервис sessionPersistence недоступен');
      }
      let listed = [];
      try {
        listed = await persistence.list();
      } catch (error) {
        throw new Error(`list() упал: ${String(error?.message ?? error)}`);
      }

      let archivedIds = [];
      try {
        archivedIds = ctx.get('workspaceRegistry')?.archivedSessionIds ?? [];
      } catch {
        archivedIds = [];
      }
      const archived = new Set(archivedIds.map(String));
      const cache = resolveProjectionCache();
      const seen = new Set();
      const rows = [];

      // `list()` yields `{ header, revision, sizeBytes }`, not bare headers;
      // a bare header is still accepted so another store keeps working.
      for (const entry of listed ?? []) {
        const header = entry?.header ?? entry;
        const id = String(header?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (header?.origin === 'subagent') continue;
        if (archived.has(id)) continue;

        // The cache serves a whole viewed block for a listed header:
        // `cachedSnapshot` for a current checkpoint, `cachedPredecessorTitle`
        // across a format edge. `recordFor` is the wrong door here: it wants an
        // identity object, not the header, and answers undefined otherwise.
        let hints;
        if (cache) {
          try {
            hints =
              (typeof cache.cachedSnapshot === 'function' ? cache.cachedSnapshot(header) : undefined) ??
              (typeof cache.cachedPredecessorTitle === 'function'
                ? cache.cachedPredecessorTitle(header)
                : undefined);
          } catch {
            /* titles and recency are decoration */
          }
        }
        const values = hints?.values ?? {};
        const title =
          typeof values.title === 'string' && values.title.trim() ? values.title.trim() : undefined;
        const lastPromptAt =
          typeof values.sessionListMetadata?.lastPromptAt === 'number'
            ? values.sessionListMetadata.lastPromptAt
            : 0;

        const createdAt = header?.createdAt ?? 0;
        // Same recency rule the Web sidebar uses for a stored session.
        rows.push({ id, title, cwd: header?.cwd, createdAt, updatedAt: Math.max(createdAt, lastPromptAt) });
      }

      rows.sort((left, right) => right.updatedAt - left.updatedAt);
      return rows;
    };


    const questions = new TelegramQuestions({ api, logger });

    const replies = new ReplyRouter({
      api,
      logger,
      bindings,
      resolveTarget: targetForSession,
      streaming: startup.streaming,
      showToolActivity: startup.showToolActivity,
      mirror: startup.mirrorAnswers,
      rich: startup.rich,
      workspaceRootFor: (sessionId) => {
        const target = targetForSession(sessionId);
        const binding = target && bindings.cache?.[target.key];
        return binding?.cwd ?? workspaceRoot;
      },
    });

    const commands = new TelegramCommands({
      api,
      ctx,
      logger,
      bindings,
      getAgent,
      startNewSession: async (target, seedText) => {
        const rotated = await bindings.rotate(target.key);
        await bindings.patch(target.key, {
          chatId: target.chatId,
          threadId: target.threadId,
        });
        const previous = handles.get(rotated.sessionId);
        if (previous) {
          handles.delete(rotated.sessionId);
          await previous.dispose().catch(() => {});
        }
        if (seedText) {
          const agent = await ensureAgent(target);
          replies.claimSession(agent.id);
          agent.followup(userMessage(seedText));
        }
        return rotated.sessionId;
      },
      /**
       * Existing sessions this profile can resume, newest first.
       *
       * Header fields are the only identity a listing can trust; titles live in
       * the projection cache, so a title is decoration and its absence falls
       * back to the id rather than failing the command.
       */
      listSessions: async () => collectSessions(),
      /**
       * Sessions grouped the way the Web sidebar groups them.
       *
       * Archived sessions are dropped, subagent sessions are dropped, and each
       * group is ordered by its freshest conversation so the workspace holding
       * the newest session comes first.
       */
      listWorkspaces: async () => {
        const rows = await collectSessions();
        const registry = ctx.get('workspaceRegistry');
        const groups = [];
        const claimed = new Set();

        if (registry && typeof registry.list === 'function') {
          let workspaces = [];
          try {
            workspaces = registry.list() ?? [];
            // A registry may hand back a keyed map instead of an array.
            if (!Array.isArray(workspaces)) workspaces = Object.values(workspaces);
          } catch (error) {
            logger.warn?.('[dsh-telegram] listing workspaces failed', String(error));
          }
          for (const workspace of workspaces) {
            const ids = new Set((workspace?.sessionIds ?? []).map(String));
            const sessions = rows.filter((row) => ids.has(row.id));
            for (const session of sessions) claimed.add(session.id);
            if (sessions.length === 0) continue;
            groups.push({
              id: String(workspace?.id ?? workspace?.path ?? ''),
              title:
                String(workspace?.title ?? '').trim() ||
                String(workspace?.path ?? '').split(/[\\/]/).filter(Boolean).pop() ||
                'Рабочая папка',
              path: workspace?.path,
              sessions,
            });
          }
        }

        const orphans = rows.filter((row) => !claimed.has(row.id));
        if (orphans.length > 0) {
          groups.push({ id: '__other__', title: 'Без рабочей папки', sessions: orphans });
        }

        for (const group of groups) {
          group.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
        }
        groups.sort(
          (left, right) => (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0),
        );
        return groups;
      },
      /**
       * The newest assistant answer of this chat's session.
       *
       * Read from the stored log, not from a resumed agent: resuming takes
       * ownership of the session, which fails outright when the same session is
       * open in the Web UI — exactly the case where a peek at the history is
       * most useful. A live agent is preferred when this chat already owns it.
       */
      lastAnswer: async (target) => {
        const binding = await bindings.get(target.key);
        if (!binding?.sessionId) return undefined;

        const live = getAgent(binding.sessionId);
        if (live?.session?.snapshotEvents) {
          const text = newestAssistantText(live.session.snapshotEvents());
          if (text) return { text, sessionId: String(live.id) };
        }

        const persistence = resolvePersistence();
        if (!persistence || typeof persistence.open !== 'function') {
          throw new Error('сервис sessionPersistence недоступен');
        }
        let handle;
        try {
          handle = await persistence.open(binding.sessionId, 'read');
        } catch (error) {
          throw new Error(`не удалось открыть сессию: ${String(error?.message ?? error)}`);
        }
        try {
          const { events } = await handle.read();
          const text = newestAssistantText(events);
          return text ? { text, sessionId: String(binding.sessionId) } : undefined;
        } finally {
          try {
            await handle.close();
          } catch {
            /* a failed close does not invalidate what was read */
          }
        }
      },
      /** Последние N ответов агента из лога сессии (для /history). */
      lastAnswers: async (target, limit = 10) => {
        const binding = await bindings.get(target.key);
        if (!binding?.sessionId) return [];
        const persistence = resolvePersistence();
        if (!persistence || typeof persistence.open !== 'function') {
          throw new Error('сервис sessionPersistence недоступен');
        }
        const handle = await persistence.open(binding.sessionId, 'read');
        try {
          const { events } = await handle.read();
          return assistantTexts(events, limit);
        } finally {
          try {
            await handle.close();
          } catch {
            /* неудачное закрытие не отменяет прочитанное */
          }
        }
      },
      /** Title and directory of one session, as the Web sidebar shows them. */
      sessionSummary: async (sessionId) => {
        const rows = await collectSessions();
        return rows.find((row) => row.id === String(sessionId));
      },
      /**
       * Point this chat at an existing session and resume it.
       *
       * The binding is the only switch that matters: `ensureAgent` asks
       * persistence whether the id exists and resumes rather than creating.
       * The previous agent is disposed and released so its turns stop arriving
       * in a chat that no longer owns them.
       */
      switchSession: async (target, sessionId) => {
        const previous = await bindings.get(target.key);
        if (previous?.sessionId && previous.sessionId !== sessionId) {
          const live = handles.get(previous.sessionId);
          if (live) {
            handles.delete(previous.sessionId);
            await live.dispose().catch(() => {});
          }
          replies.releaseSession(previous.sessionId);
        }
        const persistence = resolvePersistence();
        let cwd;
        try {
          const listed = (await persistence?.list?.()) ?? [];
          // `list()` yields `{ header, revision, sizeBytes }`, not bare headers.
          const entry = listed.find((row) => String((row?.header ?? row)?.id) === String(sessionId));
          cwd = (entry?.header ?? entry)?.cwd;
        } catch {
          /* an unreadable header keeps the binding's previous directory */
        }
        const patched = await bindings.patch(target.key, {
          sessionId,
          chatId: target.chatId,
          threadId: target.threadId,
          ...(cwd ? { cwd } : {}),
        });
        if (!patched) {
          await bindings.ensure(target.key, {
            sessionId,
            chatId: target.chatId,
            threadId: target.threadId,
            cwd: cwd ?? workspaceRoot,
          });
        }
        const agent = await ensureAgent(target);
        replies.claimSession(agent.id);
        return agent;
      },
    });
    commands.selectionRefs = selectionRefs;

    /* ---------------- agent lifecycle ---------------- */

    async function ensureAgent(target) {
      const { binding } = await bindings.ensure(target.key, {
        chatId: target.chatId,
        threadId: target.threadId,
        cwd: workspaceRoot,
        preset: startup.preset,
      });

      const live = handles.get(binding.sessionId)?.agent ?? pluginCtx.agents.get(binding.sessionId);
      if (live) return live;

      /**
       * Закрытую сессию не поднимаем сами.
       *
       * `agents.resume` из плагина собирает агента из контекста плагина, а
       * инструменты (`read`, `glob`, `edit`, `pwsh`, …) монтирует хост на
       * контекст сессии. Поднятый так агент получает только глобальные
       * инструменты, и рабочий реестр треда схлопывается — проверено: 27 → 1.
       * Поэтому по умолчанию сообщение ждёт открытия сессии (`wake: live-only`).
       */
      if (String(options().wake ?? 'live-only') !== 'resume') {
        return undefined;
      }
      logger.warn(
        `[dsh-telegram] сессия ${binding.sessionId} поднимается с диска (wake: resume) — ` +
          'инструменты могут отвалиться',
      );

      const selection =
        binding.provider && binding.model
          ? { provider: binding.provider, model: binding.model }
          : ctx.get('agentDefaultModel')?.currentSelection();

      /**
       * The harness calls `setup(agentCtx, agent)` and hands the Agent in
       * explicitly. Reading `agentCtx.agent` instead throws in this build:
       * cordis refuses a property that the context never declared via `inject`.
       */
      const setup = (agentCtx, agent) => {
        const resolved = agent ?? agentCtx?.get?.('agent');
        if (!resolved) return;
        installSelection(agentCtx, resolved, selection);
      };

      const persistence = ctx.get('sessionPersistence');
      let handle;

      if (persistence && (await sessionExists(persistence, binding.sessionId))) {
        handle = await pluginCtx.agents.resume({
          resumeSessionId: binding.sessionId,
          agentOptions: selection ? { ...selection } : undefined,
          setup,
        });
      } else {
        handle = await pluginCtx.agents.create({
          sessionId: binding.sessionId,
          meta: {
            cwd: binding.cwd ?? workspaceRoot,
            ...(binding.preset ? { agentPreset: binding.preset } : {}),
          },
          agentOptions: selection ? { ...selection } : undefined,
          setup,
        });
      }

      handles.set(binding.sessionId, handle);
      await attachWorkspace(binding);
      return handle.agent;
    }

    /**
     * File the session under the workspace that owns its working directory.
     *
     * Without this the Web sidebar lists the conversation as "ungrouped": the
     * session is perfectly usable, it just belongs to no workspace record. The
     * attach is best-effort by design — a chat that still answers is worth more
     * than a tidy sidebar, so a failure here is logged and never propagated.
     */
    async function attachWorkspace(binding) {
      const registry = ctx.get('workspaceRegistry');
      if (!registry) return;

      const cwd = binding.cwd ?? workspaceRoot;
      try {
        // `create` is idempotent for an existing canonical path, so this both
        // adopts a known workspace and registers a new one on first use.
        const workspace = await registry.create(cwd);
        await workspace.attachSession(binding.sessionId);
      } catch (error) {
        logger.warn(
          `[dsh-telegram] session ${binding.sessionId} stays ungrouped: ${String(error)}`,
        );
      }
    }

    /**
     * Give the agent a mutable model selection, mirroring what the Web host
     * installs. Without it `/model` could not retarget a live agent.
     */
    function installSelection(agentCtx, agent, initial) {
      let picked = initial;
      const ref = {
        get current() {
          return picked;
        },
        set current(next) {
          picked = next;
        },
        assembled: undefined,
      };
      selectionRefs.set(agent, ref);
      try {
        installModelSelection(agentCtx, ref);
      } catch (error) {
        logger.warn('[dsh-telegram] model selection could not be installed', String(error));
      }
    }

    /* ---------------- inbound ---------------- */

    async function onUpdate(update) {
      if (update.callback_query) {
        const query = update.callback_query;
        if (!allowed(query.from?.id)) return;
        if (await questions.handleCallback(query)) return;
        if (await commands.handleCallback(query)) return;
        await api.answerCallback(query.id);
        return;
      }

      const message = update.message ?? update.edited_message;
      if (!message) return;

      // `/start` is the one message an unlisted user may send: on a bot nobody
      // has claimed yet it takes ownership, and on a claimed one it is refused
      // like anything else.
      if (isStartCommand(message)) {
        if (await handleStart(message)) return;
      }

      if (!allowed(message.from?.id)) {
        await api.sendHtml(message.chat.id, translate()('denied'));
        return;
      }

      const target = {
        chatId: message.chat.id,
        threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
        replyTo: message.message_id,
      };
      target.key = conversationKey(target.chatId, target.threadId);

      // Serialize per conversation so /new completes before the next message.
      const previous = chains.get(target.key) ?? Promise.resolve();
      const next = previous
        .then(() => handleMessage(message, target))
        .catch((error) => {
          logger.error('[dsh-telegram] message handling failed', String(error));
          return api
            .sendHtml(target.chatId, `⚠️ <i>Ошибка: ${escapeHtml(String(error)).slice(0, 300)}</i>`)
            .catch(() => {});
        });
      chains.set(target.key, next);
      await next;
    }

    async function handleMessage(message, target) {
      const text = (message.text ?? message.caption ?? '').trim();

      // 1. A question awaiting a typed answer consumes this message.
      if (text && (await questions.handleText(target.chatId, text))) return;

      // 2. Slash commands belong to the channel.
      const command = text ? TelegramCommands.parse(text) : undefined;
      if (command) {
        await bindings.ensure(target.key, {
          chatId: target.chatId,
          threadId: target.threadId,
          cwd: workspaceRoot,
          preset: startup.preset,
        });
        if (await commands.handle(command, target)) return;
      }

      // 3. Everything else is agent input.
      const blocks = await inboundBlocks(message, text);
      if (blocks.length === 0) return;

      await bindings.patch(target.key, { chatId: target.chatId, threadId: target.threadId });
      const agent = await ensureAgent(target);
      await bindings.patch(target.key, { chatId: target.chatId, threadId: target.threadId });

      if (!agent) {
        await queueForWake(target, blocks);
        return;
      }

      replies.claimSession(agent.id);
      lastTargetBySession.set(agent.id, target.key);
      void api.sendChatAction(target.chatId, 'typing', { threadId: target.threadId });
      agent.followup(userMessage(blocks));
    }

    /**
     * Сессия закрыта: сохранить сообщение и объяснить, что делать.
     *
     * Очередь живёт в памяти процесса и сбрасывается таймером, как только
     * сессия появляется среди загруженных (то есть вы открыли её в DSH).
     */
    async function queueForWake(target, blocks) {
      const binding = await bindings.get(target.key);
      const sessionId = binding?.sessionId;
      const title = (await sessionTitle(sessionId)) ?? sessionId ?? 'сессия';
      const previous = pendingWake.get(target.key);
      const queued = [...(previous?.blocks ?? []), ...blocks];

      pendingWake.set(target.key, {
        target,
        sessionId,
        blocks: queued,
        at: Date.now(),
      });

      const minutes = Math.round(ttlMs() / 60000);
      const hint =
        queued.length > (blocks.length || 1)
          ? `В очереди уже ${queued.length} сообщ. — они уйдут вместе.`
          : 'Сообщение сохранено и уйдёт само.';
      await api.sendHtml(
        target.chatId,
        [
          `💤 <b>Сессия «${escapeHtml(title)}» не загружена</b>`,
          '',
          'Я не поднимаю её сам: так агент теряет инструменты (`read`, `edit`, `pwsh`).',
          `Откройте сессию в DSH — ${hint}`,
          `<i>Жду до ${minutes} мин.</i>`,
        ].join('\n'),
        { threadId: target.threadId },
      );
    }

    /** Доставить накопленное в те сессии, которые уже открыты. */
    async function flushPendingWake() {
      for (const [key, item] of [...pendingWake]) {
        if (Date.now() - item.at > ttlMs()) {
          pendingWake.delete(key);
          await api
            .sendHtml(
              item.target.chatId,
              `⌛ <i>Сессия так и не открылась — сообщение (${item.blocks.length}) отброшено.</i>`,
              { threadId: item.target.threadId },
            )
            .catch(() => {});
          continue;
        }
        const agent = item.sessionId ? getAgent(item.sessionId) : undefined;
        if (!agent) continue;

        pendingWake.delete(key);
        replies.claimSession(agent.id);
        lastTargetBySession.set(agent.id, key);
        agent.followup(userMessage(item.blocks));
        await api
          .sendHtml(
            item.target.chatId,
            `🔔 <i>Сессия открылась — отправляю накопленное (${item.blocks.length}).</i>`,
            { threadId: item.target.threadId },
          )
          .catch(() => {});
      }
    }

    const ttlMs = () => Math.max(1, Number(options().pendingTtlHours) || 6) * 60 * 60 * 1000;

    /** Заголовок сессии для сообщений — из проекции, если она есть. */
    async function sessionTitle(sessionId) {
      if (!sessionId) return undefined;
      try {
        const rows = await collectSessions();
        return rows.find((row) => row.id === sessionId)?.title;
      } catch {
        return undefined;
      }
    }

    /**
     * Build model-facing content. Photos become real image attachments when an
     * attachment service is mounted, so the agent can actually see them.
     */
    async function inboundBlocks(message, text) {
      const blocks = [];
      if (text) blocks.push({ type: 'text', text });

      const attachments = ctx.get('attachments');
      const photo = Array.isArray(message.photo) && message.photo.length > 0
        ? message.photo[message.photo.length - 1]
        : undefined;

      if (photo && attachments) {
        try {
          const file = await api.downloadFile(photo.file_id);
          const mediaType = detectImageType(file.data, file.name, file.mimeType);
          if (mediaType) {
            const ref = await attachments.saveImage({ data: file.data, mediaType, name: file.name });
            blocks.push({ type: 'image', attachment: ref });
          } else {
            // Never drop the photo silently: the model must at least learn one
            // arrived, or the user is left waiting on an answer about nothing.
            logger.warn(`[dsh-telegram] unrecognised image type (${file.mimeType}, ${file.name})`);
            blocks.push({ type: 'text', text: '[пользователь отправил изображение в неизвестном формате]' });
          }
        } catch (error) {
          logger.warn('[dsh-telegram] inbound image could not be attached', String(error));
          blocks.push({ type: 'text', text: '[пользователь отправил изображение, которое не удалось прочитать]' });
        }
      } else if (photo) {
        blocks.push({ type: 'text', text: '[пользователь отправил изображение]' });
      }

      const document = message.document;
      if (document) {
        blocks.push({
          type: 'text',
          text: `[пользователь отправил файл: ${document.file_name ?? 'имя неизвестно'} (${document.mime_type ?? 'тип неизвестен'}, ${document.file_size ?? '?'} байт)]`,
        });
      }

      if (message.voice || message.audio) {
        const audio = message.voice ?? message.audio;
        blocks.push({
          type: 'text',
          text: `[the user sent audio lasting ${audio.duration ?? '?'} сек]`,
        });
      }

      return blocks;
    }

    function allowed(userId) {
      // Read live: revoking access should take effect on the very next message,
      // not at the next restart.
      const list = options().allowedUsers ?? [];
      if (list.length === 0) return true;
      return list.map(String).includes(String(userId));
    }

    /**
     * A translator for the language currently configured.
     *
     * Built per call rather than captured once, so switching the language in
     * Settings reaches the very next message instead of the next restart.
     */
    function translate() {
      return translator(options().language);
    }

    /** `/start`, with or without the `@botname` suffix Telegram adds in groups. */
    function isStartCommand(message) {
      const text = (message.text ?? '').trim();
      return /^\/start(@[\w_]+)?$/i.test(text);
    }

    /**
     * Claim an unclaimed bot for whoever sent `/start` first.
     *
     * Returns whether the message was fully handled. A claim is only useful if
     * it persists, so a failed write must NOT report success — otherwise the
     * user is told they own the bot while the next restart forgets them.
     */
    async function handleStart(message) {
      const decision = decideStart(options(), message.from?.id);

      const t = translate();

      if (decision.kind === 'denied') {
        await api.sendHtml(
          message.chat.id,
          t('deniedClaimed', escapeHtml(String(message.from?.id ?? '?'))),
        );
        return true;
      }

      if (decision.kind !== 'claim') return false;

      if (!settings?.scope) {
        // Without a settings provider there is nowhere to record the claim, so
        // saying "you are the owner" would be a promise this process cannot
        // keep past its own lifetime.
        logger.warn('[dsh-telegram] /start cannot claim the bot: no settings provider');
        return false;
      }

      try {
        await settings.scope.update({ allowedUsers: [decision.userId] });
      } catch (error) {
        logger.error('[dsh-telegram] failed to record the bot owner', String(error));
        await api.sendHtml(message.chat.id, t('claimFailed', escapeHtml(decision.userId)));
        return true;
      }

      logger.info(`[dsh-telegram] bot claimed by user ${decision.userId}`);
      await api.sendHtml(message.chat.id, t('claimed', escapeHtml(decision.userId)));
      return true;
    }

    /* ---------------- registration ---------------- */

    const disposers = [];

    disposers.push(replies.attach(ctx));

    const userQuestions = ctx.get('userQuestions');
    if (userQuestions) {
      try {
        const channelProvider = questions.createProvider((request) => {
          const sessionId = request.agent ? String(request.agent.id) : undefined;
          return sessionId ? targetForSession(sessionId) : undefined;
        });

        // Routing is what makes inline keyboards work in a web profile, where
        // the Web bridge already owns the single provider slot. It is on by
        // default because a question the user never sees is the worse failure,
        // and switchable because it reaches past the host's public API.
        const routing = startup.routeQuestions === false
          ? { ok: false, reason: 'disabled by settings', dispose: () => {} }
          : installQuestionRouting({
              userQuestions,
              provider: channelProvider,
              resolveTarget: targetForSession,
              logger,
            });

        if (routing.ok) {
          disposers.push(routing.dispose);
        } else {
          // Fall back to the plain registration: it succeeds in a headless
          // profile and fails loudly in a web one, which is the state this
          // channel was in before routing existed.
          disposers.push(userQuestions.registerProvider(channelProvider));
          logger.info('[dsh-telegram] registered as the user-questions provider');
        }
      } catch (error) {
        // The host allows exactly one provider process-wide, and the Web
        // bridge (`dsh-host-apiproxy`, loaded by `@deepseek-ai/dsh-web-app`)
        // claims it first in a web profile. There is no per-session
        // arbitration to hook into, so a question raised in a Telegram session
        // is answered in the browser instead — and a user who is not looking
        // at the browser sees the bot stop mid-turn with no explanation.
        //
        // Nothing here can fix that, so this says exactly what happened and
        // what the operator can do about it, rather than the previous
        // "disabled" line that named neither cause nor remedy.
        logger.warn(
          '[dsh-telegram] inline questions are unavailable: another user-questions provider ' +
            '(usually the Web UI from @deepseek-ai/dsh-web-app) is already registered, and the ' +
            'host permits only one. Questions asked in a Telegram session will appear in the Web ' +
            'UI. Run this channel in a headless profile to answer them in Telegram.',
          String(error),
        );
      }
    }

    await api.setCommands(COMMAND_MENU);

    /* ---------------- автотопики ---------------- */

    /** Ограничение на имя топика (Telegram режет длиннее 128). */
    const topicTitle = (session) => {
      const raw = String(session?.title ?? '').replace(/\s+/g, ' ').trim();
      const base = raw || `Сессия ${String(session?.id ?? '').slice(0, 12)}`;
      return base.slice(0, 120);
    };

    /**
     * Досоздать топики для новых сессий и обновить названия изменившихся.
     *
     * Работает тихо: отчёт в чат не пишет (это делает `/topics` вручную).
     * Чаты берутся из уже существующих топиков — новый воркспейс сам не появится.
     */
    async function syncTopics() {
      if (typeof commands.listWorkspaces !== 'function') return;
      let groups = [];
      try {
        groups = (await commands.listWorkspaces()) ?? [];
      } catch (error) {
        logger.warn('[dsh-telegram] автотопики: список сессий недоступен', String(error));
        return;
      }

      const cached = bindings.cache ? Object.values(bindings.cache) : [];
      const bound = new Set(cached.filter((b) => b.threadId).map((b) => String(b.sessionId)));
      const forums = [...new Set(cached.filter((b) => b.threadId && b.chatId).map((b) => String(b.chatId)))];
      if (forums.length === 0) return;

      let created = 0;

      // Переименование: у привязки помним, с каким названием создали топик.
      for (const binding of cached) {
        if (!binding.threadId || !binding.topicName) continue;
        const row = (groups ?? []).flatMap((g) => g.sessions ?? []).find((s) => String(s.id) === String(binding.sessionId));
        if (!row) continue;
        const fresh = topicTitle(row);
        if (!fresh || fresh === binding.topicName) continue;
        try {
          await api.call('editForumTopic', {
            chat_id: binding.chatId,
            message_thread_id: Number(binding.threadId),
            name: fresh,
          });
          await bindings.patch(binding.key, { topicName: fresh });
          logger.info(`[dsh-telegram] автотопики: «${binding.topicName}» → «${fresh}»`);
        } catch (error) {
          logger.warn('[dsh-telegram] автотопики: переименование не удалось', String(error));
        }
      }

      for (const chatId of forums) {
        for (const group of groups) {
          for (const session of group.sessions ?? []) {
            if (bound.has(String(session.id))) continue;
            if (created >= 3) return; // не больше трёх за проход — бережём лимиты
            const name = topicTitle(session);
            try {
              const topic = await api.call('createForumTopic', { chat_id: chatId, name });
              const threadId = String(topic?.message_thread_id ?? '');
              if (!threadId) throw new Error('Telegram не вернул message_thread_id');
              await bindings.ensure(conversationKey(chatId, threadId), {
                sessionId: session.id,
                chatId,
                threadId,
                ...(session.cwd ? { cwd: session.cwd } : {}),
                topicName: name,
              });
              bound.add(String(session.id));
              created += 1;
              logger.info(`[dsh-telegram] автотопик создан: «${name}» (${chatId}/${threadId})`);
            } catch (error) {
              logger.warn('[dsh-telegram] автотопики: создание не удалось', String(error));
            }
            await new Promise((resolve) => setTimeout(resolve, 1100));
          }
        }
      }
    }

    const abort = new AbortController();
    const cursor = { offset: 0 };
    const polling = api
      .poll(cursor, onUpdate, abort.signal, { timeoutSeconds: 30 })
      .catch((error) => {
        if (!abort.signal.aborted) logger.error('[dsh-telegram] polling stopped', String(error));
      });

    /**
     * Очередь ждущих сообщений сбрасывается сама: опрашивать нечего, нужно
     * просто заметить, что сессия появилась среди загруженных.
     */
    const wakeTimer = setInterval(() => {
      void flushPendingWake().catch((error) => {
        logger.warn('[dsh-telegram] pending flush failed', String(error));
      });
    }, 5000);
    wakeTimer.unref?.();

    /** Автотопики: первый проход через 20 с после старта, дальше по расписанию. */
    const topicMinutes = Number(options().autoTopicsMinutes) || 0;
    let topicsTimer;
    let topicsBoot;
    if (topicMinutes > 0) {
      topicsBoot = setTimeout(() => {
        void syncTopics().catch((error) => logger.warn('[dsh-telegram] автотопики', String(error)));
      }, 20000);
      topicsBoot.unref?.();
      topicsTimer = setInterval(() => {
        void syncTopics().catch((error) => logger.warn('[dsh-telegram] автотопики', String(error)));
      }, topicMinutes * 60000);
      topicsTimer.unref?.();
    }

    return async () => {
      abort.abort();
      clearInterval(wakeTimer);
      if (topicsTimer) clearInterval(topicsTimer);
      if (topicsBoot) clearTimeout(topicsBoot);
      questions.disposeAll('канал Telegram остановлен');
      await replies.flushAll().catch(() => {});
      for (const disposer of disposers) {
        try {
          disposer();
        } catch {
          // A failing disposer must not block the rest of teardown.
        }
      }
      const owned = [...handles.values()];
      handles.clear();
      await Promise.allSettled(owned.map((handle) => handle.dispose()));
      await polling;
      logger.info('[dsh-telegram] channel stopped');
    };
  });
}

/* ------------------------------------------------------------------ */

/**
 * Normalise the harness logger into a plain four-method object.
 *
 * `ctx.logger` is a factory in a full harness and may be absent in a bare
 * composition, and its instances do not always carry every level. Collapsing
 * both shapes here lets the rest of the plugin call `logger.info(...)`
 * unconditionally instead of guarding every call site — so a missing logger
 * can never silently swallow a startup failure.
 */
function makeLogger(ctx) {
  let base;
  try {
    base = typeof ctx.logger === 'function' ? ctx.logger('dsh-telegram') : ctx.logger;
  } catch {
    base = undefined;
  }
  const level = (levelName, fallback) => {
    const method = base?.[levelName];
    if (typeof method === 'function') return method.bind(base);
    return (...args) => fallback('[dsh-telegram]', ...args);
  };
  return {
    debug: level('debug', console.debug ?? console.log),
    info: level('info', console.log),
    warn: level('warn', console.warn),
    error: level('error', console.error),
  };
}

/** Concatenate the text blocks of an assistant message. */
function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** The newest non-empty assistant text in a session event list. */
function assistantTexts(events, limit = 10) {
  const texts = [];
  for (const event of events ?? []) {
    if (event?.type !== 'assistant/message') continue;
    const text = textOfMessage(event.data?.message);
    if (text && text.trim()) texts.push(text.trim());
  }
  return texts.slice(-Math.max(1, limit));
}

function newestAssistantText(events) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    const text = textOfMessage(event.data?.message);
    if (text && text.trim()) return text.trim();
  }
  return undefined;
}

async function resolveToken(ctx, ref, logger) {
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  const credentials = ctx.get('credentials');
  if (credentials) {
    try {
      const resolved = await credentials.resolve(credentialRef(ref));
      if (resolved?.value) return resolved.value;
    } catch (error) {
      logger.warn('[dsh-telegram] credential lookup failed', String(error));
    }
  }
  return fromEnv;
}

/**
 * A credential ref is the validated name itself (see `dsh-credentials`), so
 * this stays a plain string rather than a wrapper object.
 */
function credentialRef(name) {
  return name;
}

async function sessionExists(persistence, sessionId) {
  try {
    const listed = await persistence.list();
    // Entries are `{ header, revision, sizeBytes }`; accept a bare header too.
    return listed.some((entry) => String((entry?.header ?? entry)?.id) === String(sessionId));
  } catch {
    return false;
  }
}

/**
 * Build a model-facing user message.
 *
 * `createUserMessage` is what mints the stable message id and freezes the
 * result; a hand-built object literal lacks that identity and is rejected by
 * the inbox without an error, so the message simply never reaches the model.
 *
 * `source.kind` is `user` because the author is a real human on the other end
 * of the chat — that is also what lets Harness run its user-only behavior such
 * as session title generation.
 */
function userMessage(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return createUserMessage({
    content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
    source: { kind: 'user' },
  });
}

/**
 * Decide an image's media type from its BYTES, then its filename, and only
 * then the declared header.
 *
 * Telegram serves photos as `application/octet-stream` — the header carries no
 * type at all. Trusting it meant every inbound photo resolved to "unsupported"
 * and was dropped without a trace. Magic bytes are also the honest answer: they
 * describe what the file actually is, not what a header claims.
 *
 * @param {Uint8Array} data raw file bytes
 * @param {string} [name] filename, used when the bytes are inconclusive
 * @param {string} [declared] the Content-Type header, trusted last
 * @returns {string|undefined} a media type the model accepts, or undefined
 */
function detectImageType(data, name, declared) {
  const bytes = data ?? new Uint8Array();
  const at = (index) => bytes[index];

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  // GIF: "GIF8"
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  // WebP: "RIFF" .... "WEBP"
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp';
  }

  const extension = /\.([a-z0-9]+)$/i.exec(String(name ?? ''))?.[1]?.toLowerCase();
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      break;
  }

  return normalizeImageType(declared);
}

/** Normalise a declared Content-Type to a media type the model accepts. */
function normalizeImageType(mimeType) {
  const normalized = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  switch (normalized) {
    case 'image/png':
    case 'image/webp':
    case 'image/gif':
      return normalized;
    case 'image/jpg':
    case 'image/jpeg':
      return 'image/jpeg';
    default:
      return undefined;
  }
}

/**
 * Bound lazily: `@deepseek-ai/dsh-agent` is present in every harness that can
 * run this plugin, but importing it at module scope would make the plugin
 * unloadable in a composition that omits it. Without the binding `/model`
 * still works — it just cannot retarget an already-running agent.
 */
let installModelSelection = () => {
  throw new Error('model selection is unavailable in this composition');
};

try {
  const agentModule = await import('@deepseek-ai/dsh-agent');
  if (typeof agentModule.installModelSelection === 'function') {
    installModelSelection = agentModule.installModelSelection;
  }
} catch {
  // Left as the throwing stub.
}
