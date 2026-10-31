/**
 * Route each question to the surface its session belongs to.
 *
 * The host allows exactly one user-questions provider process-wide, and in a
 * web profile the Web bridge registers first. The channel then loses the slot
 * and a question raised during a Telegram turn is answered in the browser —
 * the bot just stops mid-turn, which is the worst possible outcome for someone
 * holding a phone.
 *
 * The fix is to take the slot and give it back to the incumbent for every
 * session that is not ours: Telegram sessions get inline keyboards, everything
 * else reaches the browser exactly as before. That requires reassigning the
 * service's `provider` field, because the incumbent holds the only disposer.
 *
 * That is reaching past the public API, so the whole thing is written to fail
 * safe rather than to succeed cleverly:
 *
 * - It verifies the field is present and shaped as expected before touching
 *   anything, and does nothing at all if the host changed. A future DSH that
 *   makes `provider` private leaves the channel exactly as it is today rather
 *   than crashing the boot.
 * - The incumbent is called for anything that is not a live Telegram session,
 *   including any session the binding lookup cannot resolve. Uncertainty
 *   routes to the browser, never to a silent drop.
 * - Disposal restores the incumbent, so unloading the channel leaves the host
 *   as it was found.
 * - If the incumbent rejects, that rejection is the caller's answer. This
 *   layer never converts another provider's failure into its own.
 */

/**
 * Install session-aware routing over whatever provider currently holds the slot.
 *
 * @param {object} params
 * @param {any} params.userQuestions the host `userQuestions` service
 * @param {object} params.provider this channel's provider (`{ ask }`)
 * @param {(sessionId: string) => unknown} params.resolveTarget
 *   returns a Telegram target for a session id, or a falsy value when the
 *   session is not bound to a chat
 * @param {{ warn: Function, info: Function }} [params.logger]
 * @returns {{ ok: boolean, reason?: string, dispose: () => void }}
 */
export function installQuestionRouting({ userQuestions, provider, resolveTarget, logger }) {
  const noop = { ok: false, reason: 'unavailable', dispose: () => {} };
  if (!userQuestions || !provider) return noop;

  // Nothing else is holding the slot: the ordinary path works, no interception
  // needed. This is the headless case, and it must stay the simple one.
  if (userQuestions.provider === undefined) {
    try {
      const dispose = userQuestions.registerProvider(provider);
      logger?.info?.('[dsh-telegram] registered as the user-questions provider');
      return { ok: true, dispose: () => void dispose() };
    } catch (error) {
      return { ok: false, reason: String(error), dispose: () => {} };
    }
  }

  const incumbent = userQuestions.provider;
  if (typeof incumbent?.ask !== 'function') {
    // The slot holds something this code does not understand. Leaving it alone
    // is strictly better than replacing a provider whose contract is unknown.
    logger?.warn?.(
      '[dsh-telegram] the active user-questions provider has an unexpected shape; ' +
        'leaving it untouched. Questions from Telegram sessions will be answered in the Web UI.',
    );
    return { ok: false, reason: 'unrecognised-incumbent', dispose: () => {} };
  }

  const router = {
    ask: async (request) => {
      let target;
      try {
        const sessionId = request?.agent?.id;
        target = sessionId ? resolveTarget(String(sessionId)) : undefined;
      } catch (error) {
        // A lookup failure must not strand the question: hand it to the
        // incumbent, which is where it would have gone without this plugin.
        logger?.warn?.('[dsh-telegram] question routing failed; deferring', String(error));
        return incumbent.ask(request);
      }

      if (!target) return incumbent.ask(request);
      return provider.ask(request);
    },
  };

  // Free the slot the incumbent is holding. Its own disposer still runs later
  // and simply clears an already-cleared field, which the host tolerates.
  try {
    userQuestions.provider = undefined;
    if (userQuestions.provider !== undefined) throw new Error('provider field is not writable');
  } catch (error) {
    logger?.warn?.(
      '[dsh-telegram] cannot install question routing on this host build; ' +
        'questions from Telegram sessions will be answered in the Web UI.',
      String(error),
    );
    return { ok: false, reason: 'not-writable', dispose: () => {} };
  }

  let dispose;
  try {
    dispose = userQuestions.registerProvider(router);
  } catch (error) {
    // Put the host back exactly as it was before giving up.
    userQuestions.provider = incumbent;
    logger?.warn?.('[dsh-telegram] question routing could not register', String(error));
    return { ok: false, reason: String(error), dispose: () => {} };
  }

  logger?.info?.(
    '[dsh-telegram] question routing active: Telegram sessions answer in Telegram, ' +
      'every other session keeps answering in the Web UI',
  );

  // Disposal must be idempotent: cordis can unwind a fiber more than once, and
  // a second run would restore the incumbent over whichever provider legitimately
  // owns the slot by then — evicting an innocent third party.
  let disposed = false;

  return {
    ok: true,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        dispose();
      } finally {
        // Restore the incumbent only if the slot is still free, so a plugin
        // that claimed it after us is not silently evicted either.
        if (userQuestions.provider === undefined) userQuestions.provider = incumbent;
      }
    },
  };
}
