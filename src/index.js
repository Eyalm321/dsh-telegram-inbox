/**
 * dsh-telegram-inbox — a Telegram channel for the DeepSeek Harness.
 *
 * The harness has no channel concept, so a channel is assembled from two ends:
 *   inbound   long-poll getUpdates -> agent.send(message, 'next-turn', wake)
 *   outbound  ctx.on('session/event') -> sendMessage
 * One chat is one session is one agent, and sessions persist, so a conversation
 * survives a restart.
 *
 * Written as a replacement for `dsh-telegram-multiagent`, whose approach was sound
 * but which blocked its own event loop on synchronous subprocesses, failed OPEN on
 * an empty allow-list, logged every session event unconditionally, never persisted
 * its update offset, and never evicted a chat. Those are the differences worth
 * knowing; the shape of the integration is deliberately similar because that part
 * was right.
 *
 * @module dsh-telegram-inbox
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TelegramClient } from './client.js';
import { AllowList, describeIntruder } from './allowlist.js';
import { ChatSessions } from './sessions.js';
import { splitMessage } from './chunk.js';
import { transcribeVoice } from './voice.js';
import { createLogger } from './log.js';

export const name = 'dsh-telegram-inbox';
export const inject = ['agents'];

/**
 * One poll loop per bot token, per process, reference-counted.
 *
 * The loader mounts a plugin more than once in a single run. Without a shared
 * registry the second mount starts a second long poll on the same token, and
 * Telegram answers both with `Conflict: terminated by other getUpdates request` —
 * the bot then appears to drop messages at random. Refcounting means the last
 * mount to leave stops the loop, not the first.
 */
const POLLERS = new Map();

/** Token resolution: a file the agent can read, then config, then environment. */
export function readToken(config, log) {
  if (config.tokenFile) {
    try {
      const token = readFileSync(config.tokenFile, 'utf8').trim();
      if (token) return token;
      log.error(`token file ${config.tokenFile} is empty`);
    } catch (e) {
      // "the bot is quiet" and "I could not read the token" look identical from
      // outside and have completely different fixes. Never swallow this.
      log.error(`could not read token file ${config.tokenFile}: ${e?.message ?? e}`);
    }
    return null;
  }
  const token = config.token || process.env[config.tokenEnv || 'DSH_TELEGRAM_BOT_TOKEN'];
  if (token) return token;
  log.error('no token: set config.tokenFile (preferred), config.token, or config.tokenEnv');
  return null;
}

/**
 * Resolve harness packages from the agent's own installation.
 *
 * Resolved per instance rather than cached module-wide: this module is shared by
 * every agent on the machine, and a module-global cache means the first agent to
 * mount decides which installation everyone else resolves against — which quietly
 * breaks the multi-agent story the channel exists to support.
 */
export function resolvePlatform(appDir, log) {
  const from = appDir || process.env.DSH_APP_DIR;
  if (!from) {
    log.error('appDir is not set: the channel does not know where this agent installed the harness');
    return null;
  }
  try {
    const require = createRequire(join(from, 'resolve-from-here.js'));
    return {
      createUserMessage: require('@deepseek-ai/dsh-llm').createUserMessage,
      installModelSelection: require('@deepseek-ai/dsh-agent').installModelSelection,
    };
  } catch (e) {
    log.error(`harness packages did not resolve from ${from}: ${e?.message ?? e}`);
    return null;
  }
}

/** Text of an assistant message: visible text only, never the model's reasoning. */
export function visibleText(message) {
  return (message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function apply(ctx, config = {}) {
  const log = createLogger(
    config.agentName || 'telegram',
    config.logLevel || process.env.DSH_TELEGRAM_LOG_LEVEL || 'info',
  );

  const token = readToken(config, log);
  if (!token) return;
  const platform = resolvePlatform(config.appDir, log);
  if (!platform) return;

  const allow = new AllowList(config.allowedUsers, { alertWindowMs: config.alertWindowMs });
  if (allow.isEmpty) {
    // Fail closed, loudly. An unset allow-list on an agent with shell access is a
    // configuration mistake, and the safe reading of it is "nobody", not "everyone".
    log.error('allowedUsers is empty — refusing every message. Set it to your Telegram user id.');
  }

  const tg = new TelegramClient(token, {
    log: (lvl, m) => log(lvl, m),
    offsetFile: config.offsetFile || null,
  });

  const sessions = new ChatSessions({
    agents: ctx.agents,
    sessionId: (chatKey) => `telegram-${chatKey}`,
    idleMs: config.chatIdleMs,
    max: config.maxChats,
    log,
  });

  // ── outbound: session events → Telegram ──────────────────────────────────
  const typingFor = new Map(); // chatKey -> interval, keeps the indicator alive

  function stopTyping(chatKey) {
    const t = typingFor.get(chatKey);
    if (t) { clearInterval(t); typingFor.delete(chatKey); }
  }

  ctx.on('session/event', (session, event) => {
    const chatKey = sessions.chatFor(session?.id ?? '');
    if (chatKey === undefined) return;
    const chatId = Number(chatKey);
    try {
      if (event.type === 'turn/start') {
        // Telegram's typing indicator expires after ~5s, so a long turn needs it
        // refreshed or the chat looks dead while the agent is working.
        void tg.typing(chatId);
        stopTyping(chatKey);
        typingFor.set(chatKey, setInterval(() => void tg.typing(chatId), 4000).unref?.() ?? setInterval(() => void tg.typing(chatId), 4000));
      } else if (event.type === 'turn/end') {
        stopTyping(chatKey);
        if (event.data?.reason?.kind === 'error') {
          // The reason a turn died arrives here and nowhere else. Report it to the
          // chat as well as the log: silence is the one useless answer.
          const why = event.data.reason.error?.message ?? 'no description';
          log.error(`turn failed: ${why}`);
          void tg.send(chatId, `That turn failed: ${why}`, splitMessage);
        }
      } else if (event.type === 'assistant/message') {
        const text = visibleText(event.data?.message);
        if (text) {
          log.debug(`sending ${text.length} chars to chat ${chatId}`);
          tg.send(chatId, text, splitMessage)
            .catch((e) => log.error(`send to chat ${chatId} failed: ${e?.message ?? e}`));
        }
      } else {
        log.debug(`event ${event.type} on ${session?.id}`);
      }
    } catch (e) {
      log.error(`handling ${event.type} for chat ${chatId}: ${e?.message ?? e}`);
    }
  });

  // ── agent construction ───────────────────────────────────────────────────
  async function buildAgent(chatKey) {
    const presets = ctx.get('agentPresets');
    const presetId = presets ? (await presets.resolve(config.preset)).id : undefined;
    const defaultModel = ctx.get('agentDefaultModel');
    const selection = defaultModel?.currentSelection?.()
      ?? { provider: config.provider, model: config.model };

    // Without installModelSelection the request carries no `tools` field at all: the
    // agent says it will run a command and then cannot, while the turn still reports
    // completed. Mounting the preset matters for the same reason on tool-less planes.
    const setup = async (agentCtx) => {
      platform.installModelSelection(agentCtx, { current: selection, assembled: undefined });
      if (presets && presetId) await presets.mount(agentCtx, presetId);
    };
    const agentOptions = { provider: selection.provider, model: selection.model };

    return sessions.acquire(chatKey, {
      persistence: ctx.get('sessionPersistence'),
      resume: (sessionId) => ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup }),
      create: (sessionId) => withFactory(() => ctx.agents.create({
        sessionId,
        meta: { cwd: config.workspace ?? process.cwd() },
        agentOptions,
        agentPreset: presetId,
        setup,
      })),
    });
  }

  /**
   * The agent factory registers after the channel mounts, so the first message can
   * arrive before the harness can serve it. Retry rather than losing that message.
   */
  async function withFactory(fn, tries = 60) {
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) {
        if (!String(e?.message ?? e).includes('no agent factory registered')) throw e;
        if (i === 0) log.info('waiting for the agent factory to register');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`the agent factory did not appear within ${tries}s`);
  }

  // ── inbound ──────────────────────────────────────────────────────────────
  async function deliver(chatKey, text) {
    const { handle } = await buildAgent(chatKey);
    // A message sent while the agent is still replaying its log is dropped, so wait
    // for idle — but with a ceiling, since whenIdle() is not obliged to settle.
    await Promise.race([
      handle.agent.whenIdle(),
      new Promise((r) => setTimeout(r, config.idleWaitMs ?? 15000)),
    ]);
    handle.agent.send(
      platform.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      'next-turn',
      true, // wake the driver; without it the message waits indefinitely
    );
    sessions.touch(chatKey);
    log.info(`delivered ${text.length} chars to chat ${chatKey}`);
  }

  async function handleUpdate(update) {
    const msg = update.message;
    const isVoice = Boolean(msg?.voice || msg?.audio);
    if (!msg?.text && !isVoice) return;

    const chatId = msg.chat.id;
    const chatKey = String(chatId);
    const userId = msg.from?.id;

    if (!allow.admits(userId)) {
      log.warn(`refused user ${userId} (@${msg.from?.username ?? '—'})`);
      if (allow.shouldAlert(userId)) {
        const alert = describeIntruder(msg, msg.text ?? '[voice message]');
        for (const owner of allow.owners) {
          await tg.send(owner, alert, splitMessage)
            .catch((e) => log.error(`could not alert owner ${owner}: ${e?.message ?? e}`));
        }
      }
      await tg.send(chatId, 'Sorry — you are not on the allow-list for this bot.', splitMessage)
        .catch(() => {});
      return;
    }

    let text;
    if (isVoice) {
      void tg.typing(chatId);
      try {
        const transcript = await transcribeVoice(tg, (msg.voice ?? msg.audio).file_id, config.transcribeCommand);
        if (transcript === null) {
          await tg.send(chatId, 'Voice messages are not set up on this bot (no transcriber configured).', splitMessage);
          return;
        }
        text = `[voice] ${transcript}`;
        log.info(`transcribed ${transcript.length} chars of voice`);
      } catch (e) {
        log.error(`transcription failed: ${e?.message ?? e}`);
        await tg.send(chatId, 'Could not transcribe that voice message. Please try again.', splitMessage);
        return;
      }
    } else {
      text = msg.text.trim();
    }

    if (text === '/start' || text === '/help') {
      await tg.send(chatId,
        'Agent online. Send a task as an ordinary message.\n' +
        '/new — start a fresh conversation (history is kept on disk).\n' +
        '/status — what this bot is currently holding.', splitMessage);
      return;
    }
    if (text === '/new') {
      const had = await sessions.forget(chatKey);
      await tg.send(chatId, had ? 'Started a new conversation.' : 'Nothing to reset.', splitMessage);
      return;
    }
    if (text === '/status') {
      await tg.send(chatId,
        `chats held: ${sessions.byChat.size}\n` +
        `this chat: ${sessions.byChat.has(chatKey) ? sessions.byChat.get(chatKey).sessionId : 'not loaded'}\n` +
        `update offset: ${tg.offset}`, splitMessage);
      return;
    }

    try {
      await deliver(chatKey, text);
    } catch (e) {
      log.error(`could not hand the message to an agent: ${e?.message ?? e}`);
      await tg.send(chatId, 'Could not hand your message to the agent — it is in the log.', splitMessage);
    }
  }

  // ── poll loop, one per token ─────────────────────────────────────────────
  async function loop(run) {
    while (run.alive) {
      try {
        const updates = await tg.poll(config.pollSeconds ?? 25);
        // Updates are handled sequentially on purpose: two turns for one chat racing
        // each other is worse than a queue.
        for (const u of updates) {
          if (!run.alive) break;
          try { await handleUpdate(u); }
          catch (e) { log.error(`handling update ${u.update_id}: ${e?.message ?? e}`); }
        }
      } catch (e) {
        log.warn(`poll failed: ${e?.message ?? e}`);
        await new Promise((r) => setTimeout(r, config.retryMs ?? 3000));
      }
    }
  }

  ctx.effect(() => {
    let state = POLLERS.get(token);
    if (!state) { state = { refs: 0, run: null }; POLLERS.set(token, state); }
    state.refs += 1;

    if (!state.run) {
      const run = { alive: true };
      state.run = run;
      void (async () => {
        tg.whoAmI()
          .then((me) => log.info(`connected as @${me.username} (${me.first_name})`))
          .catch((e) => log.error(`could not identify to Telegram: ${e?.message ?? e}`));
        log.info(`polling started (mounts: ${state.refs})`);
        await loop(run);
        log.info('polling finished');
      })();
    } else {
      log.debug(`polling already running (mounts: ${state.refs})`);
    }

    return () => {
      state.refs -= 1;
      if (state.refs > 0) { log.debug(`mount removed, polling continues (${state.refs} left)`); return; }
      if (state.run) { state.run.alive = false; state.run = null; }
      for (const key of [...typingFor.keys()]) stopTyping(key);
      POLLERS.delete(token);
      log.info('last mount removed — polling stopped');
    };
  }, 'dsh-telegram-inbox.poll');
}
