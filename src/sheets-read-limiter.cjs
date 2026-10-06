'use strict';

// One limiter per Obsidian process. The persisted timestamps cover a full app restart.
const KEY = Symbol.for('amygdala-connection.sheets-v4-read-limiter');
const WINDOW_MS = 60000;
const MIN_GAP_MS = 1200; // At most 50 reads/minute, with headroom below Google's 60.
const MAX_READS = 50;

class SheetsReadLimiter {
  constructor({ clock = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    load = () => [], save = () => {}, onWait = () => {} } = {}) {
    Object.assign(this, { clock, sleep, save, onWait });
    const now = clock();
    const stored = load();
    const starts = Array.isArray(stored) ? stored : stored?.starts;
    this.starts = Array.isArray(starts) ? starts.filter(t => Number.isFinite(t) && t > now - WINDOW_MS).sort((a, b) => a - b) : [];
    this.tail = Promise.resolve();
    this.cooldownUntil = Number.isFinite(stored?.cooldownUntil) ? stored.cooldownUntil : 0;
  }
  persist() { this.save({ starts: [...this.starts], cooldownUntil: this.cooldownUntil }); }
  acquire(onWait = this.onWait) {
    const turn = this.tail.catch(() => {}).then(async () => {
      while (true) {
        const now = this.clock();
        this.starts = this.starts.filter(t => t > now - WINDOW_MS);
        const earliest = Math.max(now, this.cooldownUntil,
          (this.starts.at(-1) ?? -Infinity) + MIN_GAP_MS,
          this.starts.length >= MAX_READS ? this.starts[this.starts.length - MAX_READS] + WINDOW_MS : 0);
        if (earliest > now) {
          onWait(earliest - now);
          await this.sleep(earliest - now);
          continue;
        }
        // Persist before dispatch: a crash may cost one unused ticket, never an extra read.
        this.starts.push(now);
        this.persist();
        return;
      }
    });
    this.tail = turn;
    return turn;
  }
  defer(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + ms);
    this.persist();
  }
}

function sharedSheetsReadLimiter(options) {
  if (!globalThis[KEY]) globalThis[KEY] = new SheetsReadLimiter(options);
  return globalThis[KEY];
}

module.exports = { SheetsReadLimiter, sharedSheetsReadLimiter };
