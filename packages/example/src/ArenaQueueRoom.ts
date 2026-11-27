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
 *
 * FRIEND ROOMS (1.0.21+): a phone that joins with `room: "host"` is never
 * matchmade; it is given a 6-digit code ("room_code" { code }) and waits —
 * with no deadline — for a friend who joins with `room: "join", code`. The
 * two get an ordinary match room, marked `friendly` (the game pays nothing
 * for it and fines nothing). A code that is not open is answered
 * "room_error" { reason: "not_found" }. The host leaving (or sending
 * "cancel") closes the code. An older server ignores `room` and matchmakes
 * the host instead: the app waits for "room_code" and gives up without it,
 * so DEPLOY THE SERVER FIRST.
 *
 * PRIZES: a host may also send `prize: { currency, amount }` — one of
 * ROOM_PRIZES' slots (anything else is no prize). A friend joining a prize
 * room is NOT started at once: it is sent "room_info" { prize, name } and the
 * room is held for it until it answers "accept" (the match starts, the node
 * carrying `prize`) or "decline" / leaves / PRIZE_ACCEPT_S passes (the code
 * opens again). A second friend meanwhile is answered "room_error" { reason:
 * "busy" }. The money itself moves on the phones (the game escrows both
 * stakes at the start and pays the winner): this room only carries the deal.
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

interface Waiting {
  client: Client; entry: ArenaEntry; ts: number; paired: boolean; reply?: any;
  /** a friend-room host's code: never matchmade, only joined by code */
  code?: string;
  /** a friend-room host's prize, if it put one up */
  prize?: RoomPrize | null;
  /** a friend deciding on the prize: the room is held for it */
  pending?: { joiner: Waiting; timer: { clear(): void } } | null;
}

/** The game's data/ArenaRules.js ROOM_PRIZES: keep them in step. */
export const ROOM_PRIZES: Record<string, number[]> = { coins: [500, 1000, 2000, 5000], crystals: [10, 20, 50, 100] };
export type RoomPrize = { currency: "coins" | "crystals"; amount: number };
export const cleanPrize = (p: any): RoomPrize | null => {
  const currency = p?.currency, amount = Number(p?.amount);
  return ROOM_PRIZES[currency]?.includes(amount) ? { currency, amount } : null;
};
/** Seconds a prize room is held for a friend reading the prize. */
const PRIZE_ACCEPT_S = 60;

/** A friend room's code: 6 digits, no leading zero (it reads as a number). */
export const newRoomCode = (taken: (code: string) => boolean): string => {
  for (let i = 0; i < 1000; i++) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    if (!taken(code)) return code;
  }
  throw new Error("no free room code");
};
export const cleanCode = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(0, 6);


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
  private hosts = new Map<string, Waiting>();     // friend-room code -> its host
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
      if (w?.code) { this.release(w); this.hosts.delete(w.code); }
      this.waiting.delete(client.sessionId);
      client.send("cancelled", true);
      this.publish();
    },
    /** A friend agrees to the room's prize: the match starts. */
    accept: (client: Client) => {
      const host = this.hostPendingFor(client.sessionId);
      if (!host || host.paired) { client.send("room_error", { reason: "not_found" }); return; }
      const joiner = host.pending!.joiner;
      host.pending!.timer.clear();
      host.pending = null;
      this.hosts.delete(host.code!);
      this.waiting.set(client.sessionId, joiner);
      this.startMatch(host, joiner, { friendly: true, prize: host.prize ?? null }).catch((e) => console.error("[arena queue]", e));
      this.publish();
    },
    /** A friend turns the prize down: the room opens for another. */
    decline: (client: Client) => {
      const host = this.hostPendingFor(client.sessionId);
      if (host) this.release(host);
    },
  };

  onCreate() {
    console.log(`[arena queue] matchmaking: stage ±${STAGE_WINDOW}, then miner ±${MINER_WINDOW}, then fort power ±${POWER_WINDOW}; protocol ${ARENA_PROTO}`);
    this.clock.setInterval(() => this.pairUp().catch((e) => console.error("[arena queue]", e)), TICK_MS);
  }


  onJoin(client: Client, options: any) {
    const entry = cleanEntry(options?.entry);
    if (entry.proto !== ARENA_PROTO) { client.leave(CloseCode.WITH_ERROR, "protocol"); return; }
    const w: Waiting = { client, entry, ts: Date.now(), paired: false };
    if (options?.room === "host") {
      w.code = newRoomCode((c) => this.hosts.has(c));
      w.prize = cleanPrize(options?.prize);
      this.hosts.set(w.code, w);
      this.waiting.set(client.sessionId, w);
      client.send("room_code", { code: w.code });
    } else if (options?.room === "join") {
      // not queued: either straight into the host's match, or told why not
      const host = this.hosts.get(cleanCode(options?.code));
      if (!host || host.paired) { client.send("room_error", { reason: "not_found" }); return; }
      if (host.entry.proto !== entry.proto) { client.send("room_error", { reason: "version" }); return; }
      if (host.pending) { client.send("room_error", { reason: "busy" }); return; }
      if (host.prize) {
        // the friend reads the prize first; the room is held for it meanwhile
        const timer = this.clock.setTimeout(() => {
          if (host.pending?.joiner === w) { this.release(host); w.client.send("room_error", { reason: "not_found" }); }
        }, PRIZE_ACCEPT_S * 1000);
        host.pending = { joiner: w, timer };
        client.send("room_info", { prize: host.prize, name: host.entry.name });
        return;
      }
      this.hosts.delete(host.code!);
      this.waiting.set(client.sessionId, w);
      this.startMatch(host, w, { friendly: true }).catch((e) => console.error("[arena queue]", e));
    } else {
      this.waiting.set(client.sessionId, w);
    }
    this.publish();
  }

  onLeave(client: Client) {
    // a friend deciding on a prize, gone: the room opens again
    const holding = this.hostPendingFor(client.sessionId);
    if (holding) this.release(holding);
    const w = this.waiting.get(client.sessionId);
    if (w?.code && this.hosts.get(w.code) === w) {
      // the host gone: a friend reading its prize is told so
      const pending = w.pending;
      this.release(w);
      pending?.joiner.client.send("room_error", { reason: "not_found" });
      this.hosts.delete(w.code);
    }
    if (w && !w.paired) this.waiting.delete(client.sessionId);
    this.matched.delete(client.sessionId);
    this.publish();
  }

  /** The host whose room is held for `sessionId`, if any. */
  private hostPendingFor(sessionId: string): Waiting | null {
    for (const h of this.hosts.values()) if (h.pending?.joiner.client.sessionId === sessionId) return h;
    return null;
  }

  /** Lets go of a held room (its timer too). */
  private release(host: Waiting) {
    host.pending?.timer.clear();
    host.pending = null;
  }

  private async pairUp() {
    // friend-room hosts are never matchmade (a friend joining by code is
    // marked paired by startMatch before anything awaits)
    const free = () => [...this.waiting.values()].filter((w) => !w.paired && !w.code)
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

  private async startMatch(a: Waiting, b: Waiting, { friendly = false, prize = null as RoomPrize | null } = {}) {
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
      ...(friendly ? { friendly: true } : {}),
      ...(prize ? { prize } : {}),
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
      if (friendly) {
        // a friend room cannot fall back to matchmaking: tell the friend, keep the host's code open
        this.waiting.delete(b.client.sessionId);
        if (a.code) this.hosts.set(a.code, a);
        b.client.send("room_error", { reason: "not_found" });
      }
      return;
    }
    // they leave by themselves once they have their seat; forget them now
    this.waiting.delete(a.client.sessionId);
    this.waiting.delete(b.client.sessionId);
    this.matchesStarted++;
    this.recent.unshift({ at: new Date().toISOString(), a: label(a.entry), b: label(b.entry) + (friendly ? ` [friend room${prize ? `, prize ${prize.amount} ${prize.currency}` : ""}]` : ""), matchId: a.reply.matchId });
    this.recent.length = Math.min(this.recent.length, 20);
    this.publish();
  }

  /* ── the /monitor panel ─────────────────────────────────────────────
   * Who is waiting goes into the room's METADATA (the monitor's room list
   * shows it as columns — app.config.ts `monitor({ columns })`), and the
   * full detail into the room's inspect page (its "State" tab). Nothing
   * here reaches a phone: the queue room has no synced state. */

  private publish() {
    const waiting = [...this.waiting.values()].filter((w) => !w.paired && !w.code);
    this.setMetadata({
      game: "fort_conquer",
      waiting: waiting.length,
      players: waiting.slice(0, 15).map((w) => label(w.entry)).join(", ") + (waiting.length > 15 ? ` +${waiting.length - 15}` : ""),
      status: `${waiting.length} searching · ${this.hosts.size} friend rooms open · ${this.matchesStarted} matched`,
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
          status: w.paired ? "paired, sending seat" : w.code ? `friend room ${w.code}${w.prize ? ` (prize ${w.prize.amount} ${w.prize.currency})` : ""}` : "searching",
          sessionId: w.client.sessionId,
        })),
        matchesStarted: this.matchesStarted,
        recentMatches: this.recent,
      },
    };
  }
}
