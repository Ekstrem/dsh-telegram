/**
 * User-editable channel settings.
 *
 * The profile's `cordis.patch.yml` is a deployment artifact: editing it means
 * finding the file, knowing YAML, and restarting. A settings namespace makes
 * the same values user-owned — editable from the Settings page, persisted in
 * the user document, and applied without touching the composition.
 *
 * Two rules shape what lives here:
 *
 * 1. **The token is not a setting.** `role('secret')` fields are stripped from
 *    every wire response, so a card could never render one back; more to the
 *    point, a secret in the settings document is a secret in a file users sync
 *    and paste into bug reports. Only the *reference* is a setting — the value
 *    lives with the credential provider. That is why `tokenRef` is a plain
 *    string here and the token itself is written through `ctx.credentials`.
 *
 * 2. **Resolution order is composition-first.** A value the deployment pinned
 *    in `cordis.patch.yml` becomes this namespace's `base`, and the user
 *    document layers on top. A plugin that ignored `base` would silently
 *    override a deliberate deployment choice the first time a user opened the
 *    page, so the entry config is passed in rather than replaced.
 */

import Schema from '@deepseek-ai/schemastery';

import { DEFAULT_LANGUAGE, LANGUAGES } from './i18n.js';

/**
 * The namespace this plugin owns. Cards are keyed on exactly this string.
 *
 * The host validates it against `/^[a-z][a-z0-9-]*$/` through its exported
 * `settingsNamespace()` brand. That helper only checks the string and returns
 * it unchanged, so importing `@deepseek-ai/dsh-settings` solely to call it
 * would add a runtime dependency on a package whose published version
 * (`0.0.1-rc.1`) can drift from the one inside the running harness — a real
 * hazard in exchange for a check a literal cannot fail.
 */
export const SETTINGS_NAMESPACE = 'telegram';

/**
 * The user-editable subset of the channel's configuration.
 *
 * Deliberately narrower than `Config`: `bindingFile` and `preset` are
 * deployment concerns, and exposing them would invite a user to point the
 * channel at a path the process cannot write.
 */
export const SettingsSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('Включить канал Telegram'),
  language: Schema.union(LANGUAGES)
    .default(DEFAULT_LANGUAGE)
    .description('Язык сообщений бота и этой карточки'),
  tokenRef: Schema.string()
    .default('TELEGRAM_BOT_TOKEN')
    .description('Имя credential с токеном бота'),
  allowedUsers: Schema.array(Schema.string())
    .default([])
    .description('Telegram user id, которым разрешён бот. Пусто — разрешено всем.'),
  workspaceRoot: Schema.string().description('Рабочий каталог для сессий Telegram'),
  routeQuestions: Schema.boolean()
    .default(true)
    .description('Присылать вопросы сессии в Telegram, а не в веб-интерфейс'),
  streaming: Schema.boolean().default(true).description('Обновлять ответ в реальном времени'),
  showToolActivity: Schema.boolean()
    .default(true)
    .description('Показывать, какой инструмент выполняет агент'),
  rich: Schema.boolean()
    .default(true)
    .description('Использовать настоящие таблицы и списки (sendRichMessage)'),
});

/**
 * Which settings changes can be applied to a running channel.
 *
 * Restarting the poller on every keystroke-sized change would drop in-flight
 * updates and re-announce the bot, so the split is explicit: fields listed here
 * are read live on the next message, and everything else needs a restart. The
 * caller decides what to do about it; this module only states the truth.
 */
const LIVE_FIELDS = new Set([
  'allowedUsers',
  'language',
  'streaming',
  'showToolActivity',
  'rich',
]);

/** Whether a settings delta can be applied without restarting the channel. */
export function isLiveChange(next, prev) {
  const keys = new Set([...Object.keys(next ?? {}), ...Object.keys(prev ?? {})]);
  for (const key of keys) {
    if (LIVE_FIELDS.has(key)) continue;
    if (JSON.stringify(next?.[key]) !== JSON.stringify(prev?.[key])) return false;
  }
  return true;
}

/**
 * Register the namespace and keep a live view of the resolved settings.
 *
 * Returns `undefined` when no settings provider is mounted — a headless or
 * embedded composition may omit one — in which case the caller keeps using its
 * entry config alone. That fallback is the reason every consumer here reads
 * through one accessor instead of capturing values at startup.
 *
 * @param {any} ctx plugin context
 * @param {object} entryConfig the composition's `cordis.yml` config for this plugin
 * @param {(next: any, prev: any) => void} onChange called after each commit
 * @returns {{ current: () => any, scope: any } | undefined}
 */
export function registerSettings(ctx, entryConfig, onChange) {
  // Only the fields this schema owns may seed `base`: passing the whole entry
  // config would fail validation on keys the schema does not declare.
  const base = {};
  for (const key of Object.keys(SettingsSchema.dict ?? {})) {
    if (entryConfig?.[key] !== undefined) base[key] = entryConfig[key];
  }

  const handle = { current: () => undefined, scope: undefined };

  // `ctx.inject` rather than `ctx.get('settings')`: a plain get returns
  // undefined whenever the providing fiber is not active yet, and this runs
  // during `apply`. That read could silently win or lose on startup ordering,
  // and losing it means no settings card and no way for `/start` to record an
  // owner — with nothing reporting why. The callback instead runs once the
  // service is genuinely available, which is how every first-party plugin
  // registers its namespace.
  ctx.inject(['settings'], (settingsCtx) => {
    let scope;
    try {
      scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, { base });
    } catch (error) {
      // A duplicate namespace or a stored section the schema rejects is a real
      // misconfiguration, but it must not take the whole channel down: the
      // channel still works from its entry config.
      ctx.logger?.warn?.('[dsh-telegram] settings unavailable', String(error));
      return;
    }

    let current = scope.get();
    handle.current = () => current;
    handle.scope = scope;

    scope.watch((next, prev) => {
      current = next;
      try {
        onChange?.(next, prev);
      } catch (error) {
        ctx.logger?.error?.('[dsh-telegram] settings change handler failed', String(error));
      }
    });
  });

  return handle;
}

/**
 * Decide what `/start` from this user means.
 *
 * A bot's username is discoverable, so "anyone who sends `/start` is allowed"
 * hands whoever finds it an agent running shell commands on the owner's
 * machine. But an empty allow-list is not a decision either — it is a bot
 * nobody has claimed yet.
 *
 * So the first `/start` on an unclaimed bot takes ownership and closes the
 * door behind it, the way first-run device setup does. Every later stranger is
 * refused, and the owner widens access deliberately from Settings.
 *
 * Returned as a decision rather than performed here so the caller owns the
 * write and the reply, and so this rule is testable without a Telegram API.
 *
 * @param {{ allowedUsers?: string[] }} settings resolved channel settings
 * @param {string|number|undefined} userId the sender of `/start`
 * @returns {{ kind: 'claim', userId: string } | { kind: 'allowed' } | { kind: 'denied' }}
 */
export function decideStart(settings, userId) {
  const id = userId === undefined || userId === null ? '' : String(userId);
  const list = (settings?.allowedUsers ?? []).map(String);

  if (list.length > 0) {
    return list.includes(id) ? { kind: 'allowed' } : { kind: 'denied' };
  }

  // Telegram always identifies a sender, so a missing id means a shape this
  // code does not understand. Claiming ownership for an неизвестно party would be
  // the worst possible reading of it.
  if (!id) return { kind: 'denied' };

  return { kind: 'claim', userId: id };
}
