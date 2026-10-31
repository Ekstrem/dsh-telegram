# dsh-telegram

[![npm](https://img.shields.io/npm/v/dsh-telegram)](https://www.npmjs.com/package/dsh-telegram)

A Telegram channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Written to fix four concrete failures of the generic channel bridge:

| Problem | Cause | Fix |
|---|---|---|
| Bold, links and tables render as literal markdown | `parse_mode` was never set | Markdown is compiled to Telegram's rich blocks — real tables and lists — with an HTML path behind it |
| The agent cannot send images | the reply path only ever passed `{ text }` | file references in a reply become real `sendPhoto` / `sendDocument` uploads |
| Questions have no answer buttons | no `UserQuestionProvider` was registered | questions render as inline keyboards, with multi-select and free-text answers |
| No way to change model from chat | only `/new` existed | `/model`, `/preset`, `/mode`, `/status`, `/stop`, `/compact` |

> **Status: early.** Verified end-to-end against a live bot on DSH `0.1.0-rc.7`,
> but not yet tested by anyone else or against another DSH release. Expect the
> rough edges of a `0.1.0`.

## Install

```sh
dsh plugin --profile web add dsh-telegram
```

`dsh plugin` forwards to pnpm in the profile directory, so the published
package above, a git URL (`github:Gum97/dsh-telegram`) or a local path
(`file:../dsh-telegram`) all work.

Then add the bundle to the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-telegram"]
    }
  }
}
```

Store the bot token — it is never read from plugin config:

```sh
# $DSH_HOME/.credentials.yaml
TELEGRAM_BOT_TOKEN: "123456:ABC-DEF..."
```

Or paste it into **Settings → Plugins → Telegram** once the profile is running.

## Settings page

The plugin registers the `telegram` settings namespace and ships a browser card
keyed on it, so the bot token, the allowed-user list, the working directory and
the display switches are editable from Settings → Plugins without touching a
file.

Two behaviours are worth knowing:

- **The token is not stored in the settings document.** Secrets are stripped
  from every wire response, so the card can only report *whether* a token is
  configured, never show one. It writes through the credentials domain, and a
  blank field leaves the stored token alone.
- **Not every change applies live.** The allowed-user list and the display
  switches take effect on the next message. The token reference, the working
  directory and the on/off switch are read when the channel starts, so they
  apply after DSH restarts — the card says so before you save, and the log
  repeats it afterwards.

Values pinned in the profile's `cordis.patch.yml` become the namespace's `base`
layer, so a deployment's choice survives until a user deliberately overrides it,
and **Reset** on a field returns it to that value.

## Building from source

The Host half is plain ESM JavaScript and runs as-is. The browser half is the
one build step, because DSH's page loader takes a registered CJS factory rather
than an ES module:

```sh
npm install
npm run build:client   # emits lib/client.js
npm test
```

`prepublishOnly` runs both, so a published tarball always carries a bundle that
matches its source. React and the DSH client packages stay external `require`
calls resolved by the page — bundling React would give the card a second React
instance and break its hooks at runtime.

> The upstream `clientBundle` build preset is not published, so `tsdown.client.ts`
> here reproduces its contract. This is a known gap in the out-of-repo plugin
> story, documented in `dsh-client-ui-settings-plugins`' own README.

## Commands

| Command | Effect |
|---|---|
| `/start` | Claim an unclaimed bot (see below) |
| `/new` | Start a fresh session for this chat |
| `/model` | Pick a provider/model from buttons, or `/model provider/model` |
| `/preset` | Choose the agent preset used by the next session |
| `/mode` | Set the sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) |
| `/status` | Session id, model, preset, sandbox mode, working directory |
| `/stop` | Cancel the running turn |
| `/compact` | Compact conversation history |
| `/help` | List commands |

### Who may use the bot

`allowedUsers` decides, and an empty list means the bot is *unclaimed* rather
than open to everyone.

The first person to send `/start` to an unclaimed bot is recorded as its owner
and the door closes behind them — the way first-run device setup works. Every
later stranger is refused and shown their own user id to pass along, and the
owner widens access from Settings → Plugins → Telegram.

This matters because a bot's username is discoverable. A bot that accepted
anyone would hand whoever found it an agent running shell commands on the
owner's machine.

### Language

The channel speaks Vietnamese or English, chosen by the `language` setting and
switchable from the settings card. It governs both faces at once — the bot's
messages and the card's own labels — because a bot answering in Vietnamese
from a card labelled in English is one product speaking two languages at the
user.

This is a channel setting rather than the host locale on purpose: DSH ships
`zh` and `en` only, and its locale schema is a union over exactly those two, so
a `vi` preference is rejected outright. Following the host would have meant
hiding Vietnamese behind the Chinese option.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the channel off without removing it |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Credential name holding the bot token |
| `allowedUsers` | `[]` | Telegram user ids allowed to talk to the bot; empty means unclaimed |
| `language` | `vi` | `vi` or `en`, for bot messages and the settings card |
| `workspaceRoot` | `process.cwd()` | Working directory for channel sessions |
| `routeQuestions` | `true` | Answer a Telegram session's questions in Telegram, not the browser |
| `streaming` | `true` | Edit one message in place while the answer streams |
| `showToolActivity` | `true` | Show which tool is running inside the preview |
| `rich` | `true` | Use real tables and lists (`sendRichMessage`) |
| `preset` | — | Agent preset for new channel sessions |
| `bindingFile` | `$DSH_HOME/dsh-telegram/bindings.json` | Where the chat→session map lives |

Everything above except `preset` and `bindingFile` is also user-editable from
the Settings page; those two stay deployment concerns, since pointing the
channel at an unwritable binding file would break it with no way back.

## Design notes

**Escaping happens once.** Raw text is HTML-escaped up front; inline patterns
then run against the escaped text. Because escaping removes every `<` and `>`,
no user content can forge a tag. Code spans and fences are lifted out before
escaping and restored after, so their contents never see emphasis processing.

**Chunking splits the source, not the HTML.** Slicing rendered HTML at 4096
bytes would cut a message mid-tag and Telegram would reject the whole send.
Splitting markdown and rendering each piece guarantees balanced tags, and a
fence spanning a boundary is closed and reopened.

**Media never escapes the workspace.** A referenced path is resolved against
the session's workspace root and rejected if it lands outside; the reference
stays as text rather than uploading an arbitrary file.

**HTML failure degrades, never drops.** If Telegram rejects a rendered payload,
the client retries once as plain text. A formatting bug costs formatting, not
the message.

**Only channel-owned turns are delivered.** A session can also be driven from
the Web UI. The reply router tracks which turns it opened so those replies are
not duplicated into the chat.

## Questions in a web profile

The host allows exactly one user-questions provider process-wide, and in a web
profile the Web bridge (`dsh-host-apiproxy`) registers first. Left alone, that
means a question raised during a Telegram turn is answered **in the browser**,
and the bot appears to stop mid-turn — the worst outcome for someone holding a
phone.

So the channel installs a router over whichever provider holds the slot:
sessions bound to a Telegram chat get inline keyboards, and every other session
reaches the browser exactly as before. Set `routeQuestions: false` to switch it
off and restore the plain behaviour.

This shares a slot the host models as exclusive, so it is written to fail safe:
it checks the field is writable and the incumbent is recognisable before
touching anything, hands the incumbent every session it cannot resolve, passes
that provider's rejections through untouched, and restores it on disposal. A
future DSH that makes the field private costs this feature, not the boot.

## Tests

```sh
node --test 'test/*.test.js'
```

Covers the renderer (escaping, emphasis, tables, chunk balance, injection
attempts) and media extraction (classification, workspace confinement,
deduplication, album grouping) without contacting Telegram.
