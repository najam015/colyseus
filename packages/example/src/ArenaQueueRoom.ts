/**
 * Fort Conquerors' arena matchmaking (was Firebase arenaQueue/ in the
 * game's core/ArenaNet.js).
 *
 * Every searching phone joins the ONE queue room (`joinOrCreate`) with its
 * entry — name, level, fort power, miner level, squad, stage — and waits.
 * Twice a second the room pairs whoever it can, longest-waiting first, by
 * `pickOpponent` below — THE matchmaking rule, decided here on the server so
 * it can change with a deploy and no app release:
 *   1. the SAME STAGE, else the nearest stage within STAGE_WINDOW up or down;
 *   2. else the same MINER LEVEL, else the nearest within MINER_WINDOW;
 *   3. else fort power alone (`pickByFortPower`): the exact power, else the
 *      nearest up to POWER_WINDOW above, else up to it below.
 * Inside tiers 1 and 2 a tie goes to the nearest fort power, then the longest
 * wait. A side with no miner level (an old app) skips tier 2. The three
 * windows come from the environment (STAGE_WINDOW, MINER_WINDOW,
 * POWER_WINDOW). Every phone since 1.0.20 also sends `stats` — fort power,
 * level, stage, miner level and its whole arena record — kept on the entry
 * for rules still to come; an older phone's stats are rebuilt from the fields
 * it always sent, so a rule never has to ask which version it is reading.
 * A pair gets a match room (ArenaMatchRoom) and each phone is
 * sent its seat there with the match itself; the phone then leaves the queue.
 *
 * The phone keeps its own deadline. At it, it sends `cancel`: the answer is
 * either "cancelled" (play the bot) or, when the room paired it in that same
 * moment, "matched" with the seat — so a phone is never matched and then
 * absent. (Replies are plain messages, not `room.request()`, so SDK 0.17
 * clients work.)
 */
import { Room, type Client, matchMaker, CloseCode } from "@colyseus/core";

/** A window from the environment (e.g. MINER_WINDOW=3), else its default —
 *  so a window can be retuned with a restart, not even a deploy. */
const envInt = (name: string, dflt: number) => {
  const raw = (process.env[name] ?? "").trim();
  const v = Number(raw);
  // unset, empty or not a whole number >= 0: the default (an empty value must
  // never read as 0, which would allow exact matches only)
  if (raw === "" || !Number.isInteger(v) || v < 0) {
    if (raw !== "") console.warn(`[arena queue] ${name}="${raw}" is not a whole number >= 0, using ${dflt}`);
    return dflt;
  }
  return v;
};
/** Fort power either side, for the last tier. */
export const POWER_WINDOW = envInt("POWER_WINDOW", 2000);
/** Stages up or down, for the first tier. */
export const STAGE_WINDOW = envInt("STAGE_WINDOW", 5);
/** Miner levels up or down, for the second tier. */
export const MINER_WINDOW = envInt("MINER_WINDOW", 5);
/** core/ArenaNet.js ARENA_PROTO: phones speaking another protocol never meet. */
export const ARENA_PROTO = 2;
const TICK_MS = 500;

/** Everything a phone says about its player, for matchmaking: numbers only,
 *  by name (`fortPower`, `level`, `stage`, `minerLevel`, `arenaPlayed`,
 *  `arenaWon`, `arenaLost`, `arenaDraw`, `arenaLeft`, and whatever a later
 *  app adds). */
export type ArenaStats = Record<string, number>;

export interface ArenaEntry {
  name: string; level: number; fortPower: number; mineralLevel: number | null;
  stage: number; squad: string; proto: number;
  stats: ArenaStats;
}

interface Waiting { client: Client; entry: ArenaEntry; ts: number; paired: boolean; reply?: any }


/** data/ArenaRules.js#pickByFortPower, verbatim in behaviour. */
export function pickByFortPower<T extends { fortPower: number; ts?: number }>(power: number, candidates: T[]): T | null {
  const tiers = [
    (p: number) => p === power,
    (p: number) => p > power && p <= power + POWER_WINDOW,
    (p: number) => p < power && p >= power - POWER_WINDOW,
  ];
  for (const inTier of tiers) {
    const pool = candidates.filter((c) => inTier(c.fortPower));
    if (pool.length) {
      return pool.reduce((best, c) => {
        const d = Math.abs(c.fortPower - power), bd = Math.abs(best.fortPower - power);
        return d < bd || (d === bd && (c.ts ?? 0) < (best.ts ?? 0)) ? c : best;
      });
    }
  }
  return null;
}

type Candidate = { stage?: number; minerLevel?: number | null; fortPower: number; ts?: number };

/** The candidate nearest by `gap` (within `window`), ties to the nearest fort
 *  power, then the longest wait; null when none is within the window. */
function nearest<T extends Candidate>(me: Candidate, candidates: T[], gap: (c: T) => number, window: number): T | null {
  const pool = candidates.filter((c) => gap(c) <= window);
  if (!pool.length) return null;
  return pool.reduce((best, c) => {
    const g = gap(c) - gap(best);
    if (g) return g < 0 ? c : best;
    const d = Math.abs(c.fortPower - me.fortPower) - Math.abs(best.fortPower - me.fortPower);
    if (d) return d < 0 ? c : best;
    return (c.ts ?? 0) < (best.ts ?? 0) ? c : best;
  });
}

/** THE matchmaking rule (see the header): stage, then miner level, then fort
 *  power. A side whose miner level is unknown (an app from before miner
 *  levels were sent) skips the miner tier rather than matching on a guess. */
export function pickOpponent<T extends Candidate>(me: Candidate, candidates: T[]): T | null {
  const stage = Number(me.stage) || 1;
  const byStage = nearest(me, candidates, (c) => Math.abs((Number(c.stage) || 1) - stage), STAGE_WINDOW);
  if (byStage) return byStage;
  const miner = me.minerLevel;
  if (miner != null) {
    const known = candidates.filter((c) => c.minerLevel != null);
    const byMiner = nearest(me, known, (c) => Math.abs((c.minerLevel as number) - miner), MINER_WINDOW);
    if (byMiner) return byMiner;
  }
  return pickByFortPower(me.fortPower, candidates);
}

/** What the rule reads off an entry. The top-level fields are what every
 *  app version sends, so they win over `stats`. */
export const matchKeys = (e: ArenaEntry) => ({
  stage: e.stage,
  fortPower: e.fortPower,
  minerLevel: e.mineralLevel ?? (Number.isFinite(e.stats.minerLevel) ? e.stats.minerLevel : null),
});

/** "Hamza (S 42 · FP 3000)" — how a player reads on the monitor. */
/** "Hamza (S 42 · M 60 · FP 3000 · W 6 L 4 D 2 Left 1)" — how a player
 *  reads on the monitor. The arena record shows only for an app that sends
 *  it (1.0.20+); an older app reads "· arena: old app". */
export const label = (e: ArenaEntry) => {
  const st = e.stats ?? {};
  const miner = e.mineralLevel ?? st.minerLevel;
  const arena = Number.isFinite(st.arenaPlayed)
    ? ` · W ${st.arenaWon ?? 0} L ${st.arenaLost ?? 0} D ${st.arenaDraw ?? 0} Left ${st.arenaLeft ?? 0} of ${st.arenaPlayed}`
    : " · arena: old app";
  return `${e.name || "(no name)"} (S ${e.stage}${miner != null ? ` · M ${miner}` : ""} · FP ${e.fortPower}${arena})`;
};

const int = (v: unknown, lo: number, hi: number, dflt: number) =>
  Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : dflt;

/** A phone's `stats`, kept to numbers: at most 64 named fields, each a
 *  finite number (anything else is dropped, never trusted). */
function cleanStats(o: any): ArenaStats {
  const out: ArenaStats = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o).slice(0, 64)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) out[k] = Math.max(-1e12, Math.min(1e12, v));
  }
  return out;
}

export function cleanEntry(o: any): ArenaEntry {
  const e = {
    name: String(o?.name ?? "").slice(0, 24),
    level: int(o?.level, 1, 9999, 1),
    fortPower: int(o?.fortPower, 0, 1e9, 0),
    mineralLevel: o?.mineralLevel == null ? null : int(o.mineralLevel, 1, 999, 10),
    stage: int(o?.stage, 1, 100000, 1),
    squad: typeof o?.squad === "string" ? o.squad.slice(0, 20000) : "[]",
    proto: int(o?.proto, 0, 999, 0),
  };
  // an older app sends no stats: rebuild what it did send, so a rule can
  // always read stats.fortPower / .level / .stage / .minerLevel
  const base: ArenaStats = { fortPower: e.fortPower, level: e.level, stage: e.stage };
  if (e.mineralLevel != null) base.minerLevel = e.mineralLevel;
  return { ...e, stats: { ...cleanStats(o?.stats), ...base } };
}

export class ArenaQueueRoom extends Room {
  /** One queue for everybody: never full, never hidden. */
  maxClients = 1000;
  /** Seconds a reserved seat waits for its WebSocket (Colyseus default 15).
   *  Through Cloudflare from Pakistan the WebSocket handshake alone measured
   *  15.3 s, so the seat expired before the phone arrived ("seat reservation
   *  expired") and every search ended with the bot. */
  seatReservationTimeout = 60;
  private waiting = new Map<string, Waiting>();   // sessionId -> waiting phone
  private matched = new Map<string, any>();       // sessionId -> its seat, until it leaves
  /** The last pairings, newest first — for the /monitor panel only. */
  private recent: Array<{ at: string; a: string; b: string; matchId: string }> = [];
  private matchesStarted = 0;

  messages = {
    /** The phone's deadline: out of the queue, unless it was just paired.
     *  Answered with "cancelled", or with "matched" (the seat) when the room
     *  paired it in that same moment — never both. */
    cancel: (client: Client) => {
      const seat = this.matched.get(client.sessionId);
      if (seat) { client.send("matched", seat); return; }
      const w = this.waiting.get(client.sessionId);
      if (w?.paired) return;                     // the seat is on its way as "matched"
      this.waiting.delete(client.sessionId);
      client.send("cancelled", true);
      this.publish();
    },
  };

  onCreate() {
    console.log(`[arena queue] matchmaking: stage ±${STAGE_WINDOW}, then miner ±${MINER_WINDOW}, then fort power ±${POWER_WINDOW}; protocol ${ARENA_PROTO}`);
    this.clock.setInterval(() => this.pairUp().catch((e) => console.error("[arena queue]", e)), TICK_MS);
  }


  onJoin(client: Client, options: any) {
    const entry = cleanEntry(options?.entry);
    if (entry.proto !== ARENA_PROTO) { client.leave(CloseCode.WITH_ERROR, "protocol"); return; }
    this.waiting.set(client.sessionId, { client, entry, ts: Date.now(), paired: false });
    this.publish();
  }

  onLeave(client: Client) {
    const w = this.waiting.get(client.sessionId);
    if (w && !w.paired) this.waiting.delete(client.sessionId);
    this.matched.delete(client.sessionId);
    this.publish();
  }

  private async pairUp() {
    const free = () => [...this.waiting.values()].filter((w) => !w.paired)
      .sort((x, y) => x.ts - y.ts);
    for (const w of free()) {
      if (w.paired) continue;
      // only someone who has waited LESS claims w: w is side a, as in the Firebase queue
      const others = free().filter((o) => o !== w && !o.paired)
        .map((o) => ({ o, ...matchKeys(o.entry), ts: o.ts }));
      const pick = pickOpponent(matchKeys(w.entry), others);
      if (!pick) continue;
      await this.startMatch(w, pick.o);
    }
  }

  private async startMatch(a: Waiting, b: Waiting) {
    a.paired = b.paired = true;
    const side = (w: Waiting) => ({
      uid: w.client.sessionId,
      name: w.entry.name, level: w.entry.level, fortPower: w.entry.fortPower,
      mineralLevel: w.entry.mineralLevel, squad: w.entry.squad,
    });
    const node = {
      a: side(a), b: side(b),
      // the higher stage of the two: mineral drops and dragon surcharges
      stage: Math.max(a.entry.stage, b.entry.stage),
      seed: (Math.random() * 0x100000000) >>> 0,
      createdAt: Date.now(), proto: ARENA_PROTO,
    };
    try {
      const room = await matchMaker.createRoom("fc_arena", { node });
      for (const [w, s] of [[a, "a"], [b, "b"]] as const) {
        const seat = await matchMaker.reserveSeatFor(room, { side: s });
        w.reply = { seat, side: s, matchId: room.roomId, node };
      }
      for (const w of [a, b]) {
        this.matched.set(w.client.sessionId, w.reply);
        w.client.send("matched", w.reply);
      }
    } catch (err) {
      console.error("[arena queue] could not start a match:", err);
      a.paired = b.paired = false;
      return;
    }
    // they leave by themselves once they have their seat; forget them now
    this.waiting.delete(a.client.sessionId);
    this.waiting.delete(b.client.sessionId);
    this.matchesStarted++;
    this.recent.unshift({ at: new Date().toISOString(), a: label(a.entry), b: label(b.entry), matchId: a.reply.matchId });
    this.recent.length = Math.min(this.recent.length, 20);
    this.publish();
  }

  /* ── the /monitor panel ─────────────────────────────────────────────
   * Who is waiting goes into the room's METADATA (the monitor's room list
   * shows it as columns — app.config.ts `monitor({ columns })`), and the
   * full detail into the room's inspect page (its "State" tab). Nothing
   * here reaches a phone: the queue room has no synced state. */

  private publish() {
    const waiting = [...this.waiting.values()].filter((w) => !w.paired);
    this.setMetadata({
      game: "fort_conquer",
      waiting: waiting.length,
      players: waiting.slice(0, 15).map((w) => label(w.entry)).join(", ") + (waiting.length > 15 ? ` +${waiting.length - 15}` : ""),
      status: `${waiting.length} searching · ${this.matchesStarted} matched`,
    }).catch(() => {});
  }

  /** The monitor's room page: every phone in the queue, and recent pairings. */
  async getInspectData() {
    const base = await (Room.prototype as any).getInspectData.call(this);
    const now = Date.now();
    return {
      ...base,
      state: {
        searching: [...this.waiting.values()].map((w) => ({
          name: w.entry.name || "(no name)", fortPower: w.entry.fortPower, level: w.entry.level,
          stage: w.entry.stage, minerLevel: w.entry.mineralLevel, proto: w.entry.proto,
          stats: w.entry.stats,
          waitingSeconds: Math.round((now - w.ts) / 1000),
          status: w.paired ? "paired, sending seat" : "searching",
          sessionId: w.client.sessionId,
        })),
        matchesStarted: this.matchesStarted,
        recentMatches: this.recent,
      },
    };
  }
}
