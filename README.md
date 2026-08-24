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
| No tests | — | 189 |

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
| `video` | `true` | Read videos by sampling frames. `false` refuses them out loud rather than ignoring them. |
| `videoFrames` | `6` | Frames sampled per clip. Reduced for a short clip; never more than the clip has. |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | Overrides when they are not on the service's `PATH`. |
| `logLevel` | `info` | `error` / `warn` / `info` / `debug`. Also `DSH_TELEGRAM_LOG_LEVEL`. |
| `maxChats` | `32` | Live chats held before the oldest is evicted. |
| `chatIdleMs` | 6h | Idle time before a chat is evicted. |
| `alertWindowMs` | 1h | Minimum gap between intruder alerts for one stranger. |
| `pollSeconds` | `25` | Telegram long-poll hold. |
| `handoffDir` | — | Where claims and parked messages live. Without it, handoff is off entirely. |
| `handoffTtlMs` | 30m | How long a claim survives a client that crashed holding it. |
| `autoHandoff` | `true` | Let ownership follow whoever spoke last (below). `false` keeps manual claims only. |
| `quietMs` | `0` | How long the other side must be silent before Telegram takes the chat back. `0` is immediate. |
| `staleTurnMs` | 15m | A turn whose log has not been written to for this long is a crashed turn, not a running one. |

## What it can read

| Sent as | Read as |
|---|---|
| Text | Text |
| Voice note or audio | Transcript, via `transcribeCommand` |
| Photo, photo album | The largest size of each picture |
| Image sent as a file | The document, at its real mime type |
| **Video**, **animation** (Telegram's gif), **video note** | **`videoFrames` stills sampled across the clip** |
| **A clip sent as a file** (`video/*` document) | **The same** |
| **A mixed album** | **Every picture AND every clip, under the one caption** |
| Sticker, location, contact, poll, other documents | Refused, in the chat and in the turn |

### Video is read by looking at frames

A model cannot watch a clip, so the honest way to read one is to look at stills from it.
They are sampled **evenly across the whole clip**: the midpoints of *n* equal slices, so
the spacing is constant and neither end lands on an edge frame. Sampling the first *n*
seconds instead is what makes an agent confidently describe the sky: the opening seconds of
a hand-held video are the ground while the phone comes up, and of a screen recording, an
empty desktop.

Each frame is attached with its position written next to it (`frame 3/6 at 0:12 of
fishing.mp4 (1:04 long)`), so the model can answer *where* it saw something instead of only
*that* it did. Frames are scaled to fit inside 768px on the longest side and never upscaled.

`ffmpeg` and `ffprobe` do the work as ordinary async subprocesses, in a private temp
directory that is removed on every path, including every failure.

### Nothing disappears quietly

This is the point of the whole path. Two videos and two images were sent on 2026-08-24; the
two images arrived, video was on the unsupported list, and **nothing was logged or said**,
so the agent answered as though it had seen all four, because the turn contained no evidence
otherwise. Silence was the bug.

Anything that cannot be delivered now produces **both** of:

- a line in the turn content naming what was sent and not included, so the model cannot
  mistake a partial message for a whole one, and
- a reply in the chat naming the same thing, so the sender knows too.

A caption always travels even when its attachment does not, because the caption is usually
the actual request.

The refusal says what it means. Telegram's Bot API will not serve a file over **20 MB**
through `getFile` at all, so an oversize clip is refused *before* any network call, because a
retry cannot ever succeed, and the reply says the size, the limit, and that retrying will
not help. In practice 20 MB is roughly **20 seconds of 4K/60**, **1 minute of 1080p/30**, or
**several minutes** of a compressed messenger-quality clip: a phone video of any real length
sent at full quality will not fit. Sending it compressed, trimmed, or as a link to a file
the agent can fetch itself are the ways through.

### Bounds

| Bound | Value |
|---|---|
| Per image | 12 MB |
| Images per message | 12 |
| Videos per message | 4 |
| Frames per message (all clips together) | 12 |
| Total attached bytes per message | 24 MB |
| Frame longest side | 768px |
| Minimum clip seconds per frame | 1 |

Everything a bound cuts is named in the turn and in the reply. A truncated album is far more
useful than a refused one, but only if the model is told what it is not seeing.

## Continuing a conversation somewhere else

A session takes exactly one writer. Two live agents on one session interleave sequence
numbers into one log and the harness then rejects the whole file, which cost 4,635 lines
of conversation on 2026-08-21. So the daemon has to let go of a chat before anything else
opens it.

A **claim** is how it lets go: a small file naming the holder. While one exists the daemon
holds no agent for that session, inbound Telegram messages are parked rather than dropped,
and the claim carries an `ackedAt` stamp the daemon writes once it has actually let go,
so a client waits for a confirmation instead of guessing from a timer.

Claims can be made by hand (`dsh-handoff.sh claim`), and with `autoHandoff` on the daemon
also makes them for itself.

### Ownership follows whoever spoke last

Running a command to switch between Telegram and the web UI is a fair price for a rare,
deliberate handover and an unfair one for switching mid-thought. So the daemon infers it:

1. **Something else wrote to the session.** The daemon drops its agent at once and claims
   the session for `the web UI (auto)`. It uses the ordinary claim machinery, so parking,
   replay and `dsh-handoff.sh status` all keep working unchanged.
2. **A Telegram message arrives with nothing running.** Telegram wins immediately: the
   auto-claim is released, anything parked is replayed in order, then the new message. The
   message *is* the signal to switch, so `quietMs` defaults to `0`: no timer stands
   between a question and its answer.
3. **A Telegram message arrives mid-turn.** It is parked, he is told it is queued because a
   turn is running, and it is replayed as soon as that turn ends. A running turn is never
   interrupted.
4. **A claim a person made** is never released by inference. Explicit beats inferred.

Two things make it safe rather than clever:

- **The daemon does not mistake itself for someone else.** Every event it writes passes
  through the same listener that drives the typing indicator, so the highest sequence
  number it has seen is the line between "we wrote that" and "somebody else did". Without
  that it would detect its own writing and hand the chat over to nobody.
- **It does not decompress a log to ask a cheap question.** "Has anything been written?" is
  one stat, the backend's own stat-derived revision token. Only when the answer is yes,
  and only when the answer decides something, is the log decoded to ask "is a turn
  running?", and even that is memoised per revision, because a log that has not changed
  cannot have grown a different tail.

A turn that started long ago and never ended is a crashed process, not a running turn:
after `staleTurnMs` it stops counting, because otherwise one dead turn would park every
future message with nobody left to answer it.

## Commands

`/start`, `/help` — what the bot is, and how a video is read. `/new` — start a fresh conversation (the old session stays
on disk). `/status` — chats held, this chat's session id, current update offset.

## What a resumed chat carries

A session is durable, which means it also preserves facts about the process that created
it. Two are corrected on every resume:

- **Runtime-context snapshots.** `dsh-system-prompt` injects a "Current runtime context"
  message describing the sandbox policy and workspace. The loop retains the latest, but
  earlier ones stay in the transcript, so a resumed chat can show the model a policy from
  a previous process. They are replaced via the surface-replacement mechanism the
  compaction plugins use — the originals stay in the append-only log.
- **The sandbox mode.** A session records its permission preset at creation, and
  `sandbox-policy` resolves `explicit grant ?? fold(session events) ?? deployment
  default`, so the session's own record outranks the deployment default. A chat created
  before `DSH_PERMISSION_MODE` was set stays restricted forever otherwise. Realignment
  runs only when that variable is set explicitly, and it downgrades as readily as it
  upgrades.

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

## Part of a set

Three independent plugins, each usable on its own, that together make a headless DeepSeek
Harness behave like a persistent assistant. They were written one problem at a time and
share no code — the seams between them are the harness's own.

| plugin | what it adds |
|---|---|
| **dsh-telegram-inbox** *(this one)* | a Telegram channel where one chat is one durable agent session |
| [dsh-headless-resume](https://github.com/Eyalm321/dsh-headless-resume) | the same durability for one-shot CLI runs, keyed by a named thread |
| [dsh-claude-cli-provider](https://github.com/Eyalm321/dsh-claude-cli-provider) | Claude on a subscription as a model route, with no Anthropic API key |
| [dsh-whatsapp-inbox](https://github.com/Eyalm321/dsh-whatsapp-inbox) | WhatsApp over Twilio, polled — no public endpoint |
| [dsh-mcp-bridge](https://github.com/Eyalm321/dsh-mcp-bridge) | harness capabilities as MCP tools for any client |

Worth knowing when choosing a model for chat agents: a provider that runs its own tool loop
(`claude -p`) cannot accept the harness's tool schemas, so a chat agent on that route has no
harness tools. Point the default model at a native-runtime model for a bot expected to *do*
things — see the note under **Notes** below.

## License

MIT
