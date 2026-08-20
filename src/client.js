/**
 * A dependency-free Telegram Bot API client.
 *
 * Hand-rolled for the same reason the plugin this replaces was: a harness plugin
 * must not drag a second copy of a framework into the tree. Only `fetch` is used —
 * including for file downloads, where the original shelled out to `curl`.
 *
 * The update offset is persisted. Telegram keeps unconfirmed updates for ~24h and
 * replays them to the next getUpdates, so a process that starts at offset 0 after a
 * crash re-delivers messages it already answered. Persisting the offset is what makes
 * a restart quiet instead of confusing.
 *
 * @module dsh-telegram-inbox/client
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const API = 'https://api.telegram.org';

export class TelegramClient {
  /**
   * @param {string} token
   * @param {{log?: Function, offsetFile?: string, fetchImpl?: Function}} [opts]
   */
  constructor(token, opts = {}) {
    this.token = token;
    this.log = opts.log ?? (() => {});
    this.offsetFile = opts.offsetFile ?? null;
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    this.offset = this.#loadOffset();
  }

  #loadOffset() {
    if (!this.offsetFile) return 0;
    try {
      const n = Number(JSON.parse(readFileSync(this.offsetFile, 'utf8')).offset);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0; // absent or unreadable both mean "start from whatever Telegram has"
    }
  }

  #saveOffset() {
    if (!this.offsetFile) return;
    try {
      mkdirSync(dirname(this.offsetFile), { recursive: true });
      const tmp = `${this.offsetFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ offset: this.offset }));
      renameSync(tmp, this.offsetFile);
    } catch (e) {
      this.log('warn', `could not persist update offset: ${e?.message ?? e}`);
    }
  }

  async call(method, payload, timeoutMs = 15000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: ctl.signal,
      });
      const data = await res.json();
      if (!data.ok) {
        const err = new Error(`${method}: ${data.description ?? 'unknown error'}`);
        err.code = data.error_code;
        throw err;
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for updates and advance the persisted offset. */
  async poll(timeoutSec = 25) {
    // The HTTP timeout must exceed the server's hold, or we abort our own long poll.
    const updates = await this.call(
      'getUpdates',
      { offset: this.offset, timeout: timeoutSec, allowed_updates: ['message'] },
      (timeoutSec + 10) * 1000,
    );
    let moved = false;
    for (const u of updates) {
      if (u.update_id >= this.offset) { this.offset = u.update_id + 1; moved = true; }
    }
    if (moved) this.#saveOffset();
    return updates;
  }

  /** Send text, split across messages when it exceeds Telegram's limit. */
  async send(chatId, text, split) {
    for (const chunk of split(text)) {
      await this.call('sendMessage', { chat_id: chatId, text: chunk });
    }
  }

  /** Best-effort typing indicator; never worth failing a turn over. */
  async typing(chatId) {
    try { await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, 8000); }
    catch { /* cosmetic */ }
  }

  async whoAmI() { return this.call('getMe'); }

  /** Download a file by id and return its bytes. No subprocess involved. */
  async downloadFile(fileId, timeoutMs = 60000) {
    const { file_path: filePath } = await this.call('getFile', { file_id: fileId });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${API}/file/bot${this.token}/${filePath}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), filePath };
    } finally {
      clearTimeout(timer);
    }
  }
}
