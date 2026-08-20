# dsh-telegram-inbox

A Telegram channel for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
One chat is one durable agent session. Conversations survive a restart, the poll loop never
blocks on I/O, and an unset allow-list refuses everyone.

## Why this exists

It replaces `dsh-telegram-multiagent`, whose integration shape was right — hand-rolled API
client, token from a file, refcounted poller, `resume()` for stored sessions — and whose
implementation had defects that show up only in production:

| Defect in the original | What it does | Here |
|---|---|---|
| `execFileSync` for the file download **and** the transcriber (120s timeout) | Blocks the event loop: one voice note freezes every chat, stops polling, and stalls running turns for up to two minutes | `fetch` + async `execFile`; the loop keeps running |
| Every session event logged unconditionally (marked `🔴 DEBUG` in-source) | The journal fills with `assistant/chunk`; real events are unfindable | Levelled logging, per-event detail behind `debug` |
| `allowedUsers: []` means *allow everyone* | A missing config line opens a shell to the internet | Empty means **nobody**, and says so at startup |
| An owner alert per refused message | A stranger can make your bot spam you | One alert per stranger per hour |
| `offset = 0` at construction, never persisted | After a crash, Telegram replays its 24h backlog and the bot re-answers old messages | Offset persisted atomically |
| Chat map never evicted | Every chat holds a live agent for the life of the process | Idle eviction and a chat cap; history stays on disk |
| Module-global platform cache | The first agent to mount decides which harness install every other agent resolves against | Resolved per instance |
| `nudgeUntilClaimed` polls every 500ms for 120s per message | Uncancellable timers accumulate per message | Removed; wait for idle with a ceiling, then wake once |
| Shells out to `curl` while already using `fetch` | An external binary for no reason | `fetch` |
| Russian UI strings | The bot answers its English-speaking owner in Russian | English |
| No tests | — | 39 |

Two behaviours are kept deliberately, because the original got them right:

- **One poll loop per token, reference-counted.** The loader mounts a plugin more than once
  per run; a second long poll on the same token makes Telegram terminate both with
  `Conflict`, and the bot then appears to drop messages at random.
- **Resume a stored session, never recreate it.** `create()` with a used session id builds a
  live session whose seed disagrees with the stored events, and persistence aborts every turn
  with an id collision — which looks exactly like the bot ignoring you.

## Install

```sh
dsh plugin --profile <name> add dsh-telegram-inbox
```

```yaml
- insert:
    - id: telegram-inbox
      name: 'dsh-telegram-inbox'
      config:
        tokenFile: /path/to/bot.token      # preferred: the profile carries only the path
        appDir: /path/to/harness/install   # where THIS agent installed dsh
        allowedUsers: [123456789]          # required in practice; empty refuses everyone
        offsetFile: /path/to/offset.json
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `tokenFile` | — | File holding the bot token. Preferred: the profile stores a path, not a secret. |
| `token` / `tokenEnv` | `DSH_TELEGRAM_BOT_TOKEN` | Alternatives for debugging. |
| `appDir` | `$DSH_APP_DIR` | The harness installation to resolve `dsh-llm` / `dsh-agent` from. Required. |
| `allowedUsers` | `[]` | Telegram user ids permitted to talk to the bot. **Empty refuses everyone.** |
| `workspace` | `process.cwd()` | Working directory for new sessions. |
| `offsetFile` | — | Where to persist the update offset. Strongly recommended. |
| `preset` | harness default | Agent preset to mount. |
| `provider` / `model` | from `agentDefaultModel` | Only used when no default-model service is composed. |
| `transcribeCommand` | — | Voice transcriber. Contract: `<cmd> <audio-file> auto` → transcript on stdout. |
| `logLevel` | `info` | `error` / `warn` / `info` / `debug`. Also `DSH_TELEGRAM_LOG_LEVEL`. |
| `maxChats` | `32` | Live chats held before the oldest is evicted. |
| `chatIdleMs` | 6h | Idle time before a chat is evicted. |
| `alertWindowMs` | 1h | Minimum gap between intruder alerts for one stranger. |
| `pollSeconds` | `25` | Telegram long-poll hold. |

## Commands

`/start`, `/help` — what the bot is. `/new` — start a fresh conversation (the old session stays
on disk). `/status` — chats held, this chat's session id, current update offset.

## Notes

- **Model routing matters.** If the composed default model is an agent-shaped provider that runs
  its own tool loop (`claude-cli`), the chat agent will have no harness tools. Point the default
  model at a native-runtime model for a bot expected to *do* things.
- **Eviction is not forgetting.** An evicted chat resumes from disk on its next message.
- Only `message` updates are requested; edits and channel posts are ignored.

## Tests

```sh
npm test
```

No harness required: every module except the entrypoint is dependency-free, and one test
imports the entrypoint so a syntax error cannot ship green.

## License

MIT
