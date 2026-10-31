/**
 * Channel copy in Russian and English.
 *
 * DSH's own locale registry only ships `zh` and `en` — `LOCALE_IDS = ['zh',
 * 'en']`, and its schema is a union over exactly those two, so a `vi` or `ru`
 * preference is rejected outright. Following the host locale would therefore
 * have meant hiding Vietnamese behind the Chinese option, which is a trick
 * rather than a translation.
 *
 * So this channel carries its own `language` setting. It governs both faces at
 * once — the messages the bot sends and the labels on the settings card —
 * because a bot answering in Vietnamese from a card labelled in English is one
 * product speaking two languages at the user.
 *
 * Every string lives here rather than at its use site so a missing translation
 * is visible as a missing key instead of surfacing as untranslated text in
 * production.
 */

/** Supported language tags, in menu order. */
export const LANGUAGES = ['ru', 'en'];

/** Used when a stored value is absent or not one this build knows. */
export const DEFAULT_LANGUAGE = 'ru';

const DICTIONARY = {
  en: {
    /* ---- bot messages ---- */
    denied: '⛔️ You are not allowed to use this bot.',
    deniedClaimed: (id) =>
      `⛔️ This bot already has an owner. Ask them to add your id: <code>${id}</code>`,
    claimFailed: (id) =>
      `⚠️ Could not record ownership. Please add your id in Settings: <code>${id}</code>`,
    claimed: (id) =>
      [
        '✅ <b>You now own this bot.</b>',
        '',
        `Only id <code>${id}</code> can use it from now on. ` +
          'To let others in, go to Settings → Plugins → Telegram.',
        '',
        'Send /help to see the commands.',
      ].join('\n'),
    welcome: 'Hello! Send a message to talk to the agent, or /help to list the commands.',
    stopped: 'the Telegram channel stopped',

    /* ---- settings card ---- */
    cardTitle: 'Telegram',
    cardDescription:
      'Telegram channel: images, real tables, questions with buttons, model switching in chat.',
    unsaved: 'unsaved',
    tokenLabel: 'Bot token',
    tokenConfigured: 'configured',
    tokenMissing: 'not set',
    tokenUnknown: 'unknown',
    tokenPlaceholderSet: 'Stored — type to replace',
    tokenPlaceholderEmpty: 'Paste the token from @BotFather',
    tokenHint: (ref) =>
      `The token lives in credential ${ref}, never in a config file. ` +
      'Leave this blank to keep the stored one.',
    languageLabel: 'Language',
    languageHint: 'Applies to both bot messages and this card.',
    enabledLabel: 'Enable the Telegram channel',
    routeQuestionsLabel: 'Ask inside Telegram',
    routeQuestionsHint:
      'Questions raised by a Telegram session get buttons in the chat. Turn this off to answer them in the Web UI.',
    allowedLabel: 'Users allowed to use the bot',
    allowedHint:
      'Telegram user ids, comma separated. Empty means the bot is unclaimed — ' +
      'the first person to send /start becomes its owner.',
    workspaceLabel: 'Working directory',
    workspaceHint: 'Where the agent runs commands and reads or writes files.',
    restartNotice:
      'The token, working directory and on/off switch only take effect after DSH restarts.',
    reset: 'Reset',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    discard: 'Discard',
    saveFailed: 'Save failed — check the values',
  },

  ru: {
    /* ---- bot messages ---- */
    denied: '⛔️ Вам не разрешено пользоваться этим ботом.',
    deniedClaimed: (id) =>
      `⛔️ У этого бота уже есть владелец. Попросите его добавить ваш id: <code>${id}</code>`,
    claimFailed: (id) =>
      `⚠️ Не удалось сохранить владельца. Добавьте ваш id в настройках: <code>${id}</code>`,
    claimed: (id) =>
      [
        '✅ <b>Теперь этот бот ваш.</b>',
        '',
        `С этого момента его может использовать только id <code>${id}</code>. ` +
          'Чтобы пустить других, откройте Settings → Plugins → Telegram.',
        '',
        'Введите /help, чтобы увидеть команды.',
      ].join('\n'),
    welcome:
      'Привет! Отправьте сообщение, чтобы поговорить с агентом, или введите /help, чтобы увидеть команды.',
    stopped: 'канал Telegram остановлен',

    /* ---- settings card ---- */
    cardTitle: 'Telegram',
    cardDescription:
      'Канал Telegram: изображения, настоящие таблицы, вопросы с кнопками, смена модели в чате.',
    unsaved: 'не сохранено',
    tokenLabel: 'Токен бота',
    tokenConfigured: 'настроен',
    tokenMissing: 'не задан',
    tokenUnknown: 'неизвестно',
    tokenPlaceholderSet: 'Сохранён — введите, чтобы заменить',
    tokenPlaceholderEmpty: 'Вставьте токен от @BotFather',
    tokenHint: (ref) =>
      `Токен хранится в credential ${ref}, а не в файле конфигурации. ` +
      'Оставьте поле пустым, чтобы сохранить текущий.',
    languageLabel: 'Язык',
    languageHint: 'Применяется к сообщениям бота и этой карточке.',
    enabledLabel: 'Включить канал Telegram',
    routeQuestionsLabel: 'Спрашивать прямо в Telegram',
    routeQuestionsHint:
      'Вопросы сессии Telegram показываются кнопками в чате. Выключите — они будут в веб-интерфейсе.',
    allowedLabel: 'Кому разрешено пользоваться ботом',
    allowedHint:
      'Telegram user id через запятую. Пусто — бот без владельца, ' +
      'первый отправивший /start станет его хозяином.',
    workspaceLabel: 'Рабочий каталог',
    workspaceHint: 'Где агент выполняет команды и читает или пишет файлы.',
    restartNotice:
      'Токен, рабочий каталог и переключатель вкл/выкл действуют только после перезапуска DSH.',
    reset: 'Сбросить',
    save: 'Сохранить',
    saving: 'Сохранение…',
    saved: 'Сохранено',
    discard: 'Отменить',
    saveFailed: 'Не удалось сохранить — проверьте значения',
  },
};

/** Human-readable names for the language picker, in their own language. */
export const LANGUAGE_NAMES = { ru: 'Русский', en: 'English' };

/**
 * Build a translator for one language.
 *
 * An unknown key returns the key itself rather than empty text: a visible
 * `tokenLabel` in the UI names the missing entry, while a blank label would
 * look like a rendering bug and hide which string was never written.
 *
 * @param {string} [language] one of {@link LANGUAGES}
 * @returns {(key: string, ...args: unknown[]) => string}
 */
export function translator(language) {
  const table = DICTIONARY[language] ?? DICTIONARY[DEFAULT_LANGUAGE];
  return (key, ...args) => {
    const entry = table[key] ?? DICTIONARY[DEFAULT_LANGUAGE][key];
    if (entry === undefined) return key;
    return typeof entry === 'function' ? entry(...args) : entry;
  };
}
