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
import { classify, buildContent, describeSkipped, MAX_IMAGE_BYTES } from './media.js';
import { Albums } from './album.js';
import { Generations } from './generations.js';
import { Handoff } from './handoff.js';
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

  // Album members arrive as separate updates sharing a media_group_id; buffer them briefly
  // so one user action becomes one turn.
  const albums = new Albums({ graceMs: config.albumGraceMs });

  // `/new` bumps a per-chat generation so the next message gets a genuinely new session.
  const generations = new Generations(config.generationsFile || null, { log });

  // A conversation can be handed to another client (the web UI, the CLI). While claimed the
  // daemon does not touch that session at all — one writer, always — and inbound messages are
  // parked rather than dropped.
  const handoff = new Handoff(config.handoffDir || null, { ttlMs: config.handoffTtlMs, log });

  const sessions = new ChatSessions({
    agents: ctx.agents,
    sessionId: (chatKey) => generations.sessionId('telegram', chatKey),
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
  async function deliver(chatKey, content) {
    const { handle } = await buildAgent(chatKey);
    // A message sent while the agent is still replaying its log is dropped, so wait
    // for idle — but with a ceiling, since whenIdle() is not obliged to settle.
    await Promise.race([
      handle.agent.whenIdle(),
      new Promise((r) => setTimeout(r, config.idleWaitMs ?? 15000)),
    ]);
    handle.agent.send(
      platform.createUserMessage({ content, source: { kind: 'user' } }),
      'next-turn',
      true, // wake the driver; without it the message waits indefinitely
    );
    sessions.touch(chatKey);
    const chars = content.filter((b) => b.type === 'text').reduce((n, b) => n + b.text.length, 0);
    const imgs = content.filter((b) => b.type === 'image').length;
    log.info(`delivered ${chars} chars${imgs ? ` + ${imgs} image(s)` : ''} to chat ${chatKey}`);
  }

  /**
   * Commit inbound images to the attachment service so the turn can reference them.
   * Returns { attachments, skipped, why } — a failure here must degrade to caption-only,
   * never to dropping the message.
   */
  async function attachImages(photos) {
    const store = ctx.get('attachments');
    if (!store?.saveImage) return { attachments: [], skipped: photos.length, why: 'no attachment service is composed' };
    const attachments = [];
    let why = '';
    for (const p of photos) {
      try {
        const { bytes } = await tg.downloadFile(p.fileId);
        if (bytes.length > MAX_IMAGE_BYTES) {
          why = `larger than the ${Math.round(MAX_IMAGE_BYTES / 1048576)}MB limit`;
          log.warn(`skipping ${p.name}: ${bytes.length} bytes`);
          continue;
        }
        attachments.push(await store.saveImage({ data: new Uint8Array(bytes), mediaType: p.mediaType, name: p.name }));
      } catch (e) {
        why = e?.message ?? String(e);
        log.warn(`could not attach ${p.name}: ${why}`);
      }
    }
    return { attachments, skipped: photos.length - attachments.length, why: why || 'unreadable' };
  }

  async function handleUpdate(update) {
    const msg = update.message;
    if (!msg?.chat) return;
    const chatId = msg.chat.id;
    const chatKey = String(chatId);
    const userId = msg.from?.id;
    const what = classify(msg);

    if (!allow.admits(userId)) {
      log.warn(`refused user ${userId} (@${msg.from?.username ?? '—'})`);
      if (allow.shouldAlert(userId)) {
        const alert = describeIntruder(msg, what.text || `[${what.kind}]`);
        for (const owner of allow.owners) {
          await tg.send(owner, alert, splitMessage)
            .catch((e) => log.error(`could not alert owner ${owner}: ${e?.message ?? e}`));
        }
      }
      await tg.send(chatId, 'Sorry — you are not on the allow-list for this bot.', splitMessage).catch(() => {});
      return;
    }

    let text = what.text;
    let content = null;

    if (what.kind === 'voice') {
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
    } else if (what.kind === 'photo') {
      void tg.typing(chatId);
      const { attachments, skipped, why } = await attachImages(what.photos);
      const overflow = what.dropped
        ? `[${what.dropped} further image(s) in this message were not read: only the first ${what.photos.length} are handled.]`
        : '';
      log.info(`received ${what.photos.length} image(s), attached ${attachments.length}`
             + (what.text ? `, caption ${what.text.length} chars` : ', no caption'));
      content = buildContent({
        text: what.text, attachments,
        note: [describeSkipped(skipped, why), overflow].filter(Boolean).join('\n'),
      });
    } else if (what.kind === 'unsupported') {
      // Never silent: the sender cannot tell a dropped message from a slow one.
      log.warn(`ignored unsupported message type: ${what.unsupported}`);
      await tg.send(chatId, `I can't read ${what.unsupported} yet — send text, a voice note, or an image.`, splitMessage);
      return;
    }

    if (!content && !text) return;

    if (text === '/start' || text === '/help') {
      await tg.send(chatId,
        'Agent online. Send a task as an ordinary message.\n' +
        'Text, voice notes and images (with captions) all work.\n' +
        '/new — start a fresh conversation (history is kept on disk).\n' +
        '/status — what this bot is currently holding.', splitMessage);
      return;
    }
    if (text === '/new') {
      await sessions.forget(chatKey);
      const g = generations.bump(chatKey);
      const fresh = generations.sessionId('telegram', chatKey);
      log.info(`reset chat ${chatKey} -> generation ${g} (${fresh})`);
      await tg.send(chatId,
        `Started a new conversation (${fresh}). The previous one is kept on disk.`, splitMessage);
      return;
    }
    if (text === '/status') {
      await tg.send(chatId,
        `chats held: ${sessions.byChat.size}\n` +
        `this chat: ${sessions.byChat.has(chatKey) ? sessions.byChat.get(chatKey).sessionId : 'not loaded'}\n` +
        `update offset: ${tg.offset}`, splitMessage);
      return;
    }

    const sessionId = generations.sessionId('telegram', chatKey);
    const claim = handoff.claimOf(sessionId);
    if (claim) {
      handoff.park(sessionId, { chatKey, content: content ?? [{ type: 'text', text }], at: Date.now() });
      log.info(`parked a message for ${sessionId}: held by ${claim.owner}`);
      await tg.send(chatId,
        `This conversation is open in ${claim.owner} right now. Your message is saved and I'll `
        + 'answer it as soon as it is released.', splitMessage).catch(() => {});
      return;
    }

    try {
      await deliver(chatKey, content ?? [{ type: 'text', text }]);
    } catch (e) {
      log.error(`could not hand the message to an agent: ${e?.message ?? e}`);
      await tg.send(chatId, 'Could not hand your message to the agent — it is in the log.', splitMessage);
    }
  }

  /**
   * Honour handoff claims, and pick conversations back up when they are handed back.
   *
   * Two halves. A claimed session must lose its daemon-side agent — an agent holding the
   * session writes to its log the moment anything wakes it, which is exactly the second
   * writer the claim exists to prevent. Then the claim is stamped, so the client waiting to
   * open the session learns we have let go instead of guessing from a timer. On release,
   * whatever arrived meanwhile is replayed in order, because a message that is silently
   * dropped is worse than one that is late.
   */
  async function serviceHandoffs() {
    if (!config.handoffDir) return;

    for (const claim of handoff.claims()) {
      const chatKey = sessions.chatFor(claim.sessionId);
      if (chatKey !== undefined) {
        stopTyping(chatKey);
        await sessions.forget(chatKey);
        log.info(`releasing ${claim.sessionId} to ${claim.owner}`);
      }
      // Stamped whether or not we held it: "nothing to release" is still a handover.
      if (!claim.ackedAt) handoff.ack(claim.sessionId);
    }

    for (const sessionId of handoff.releasedWithPending()) {
      const queue = handoff.drain(sessionId);
      if (!queue.length) continue;
      log.info(`replaying ${queue.length} parked message(s) for ${sessionId}`);
      for (const msg of queue) {
        const chatKey = msg.chatKey ?? sessions.chatFor(sessionId);
        if (chatKey === undefined) { log.warn(`parked message for ${sessionId} has no chat`); continue; }
        try { await deliver(chatKey, msg.content); }
        catch (e) { log.error(`replaying a parked message for ${sessionId}: ${e?.message ?? e}`); }
      }
    }
  }

  // ── poll loop, one per token ─────────────────────────────────────────────
  async function loop(run) {
    while (run.alive) {
      // Claims first: a handoff should take effect when the loop wakes, not only once
      // Telegram has something to say.
      try { await serviceHandoffs(); } catch (e) { log.warn(`handoff check failed: ${e?.message ?? e}`); }
      try {
        const updates = await tg.poll(config.pollSeconds ?? 25);
        // Updates are handled sequentially on purpose: two turns for one chat racing
        // each other is worse than a queue.
        const messages = albums.accept(updates.map((u) => u.message).filter(Boolean));
        for (const msg of messages) {
          if (!run.alive) break;
          try { await handleUpdate({ message: msg }); }
          catch (e) { log.error(`handling message ${msg.message_id}: ${e?.message ?? e}`); }
        }
      } catch (e) {
        log.warn(`poll failed: ${e?.message ?? e}`);
        for (const msg of albums.flush(true)) {
          try { await handleUpdate({ message: msg }); } catch { /* reported below */ }
        }
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
