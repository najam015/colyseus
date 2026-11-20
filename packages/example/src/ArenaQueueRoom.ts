/**
 * Fort Conquerors' arena matchmaking (was Firebase arenaQueue/ in the
 * game's core/ArenaNet.js).
 *
 * Every searching phone joins the ONE queue room (`joinOrCreate`) with its
 * entry — name, level, fort power, miner level, squad, stage — and waits.
 * Twice a second the room pairs whoever it can, longest-waiting first, by
 * the game's own rule (data/ArenaRules.js#pickByFortPower, ported below):
 * the exact fort power, else the nearest up to POWER_WINDOW above, else up
 * to it below. A pair gets a match room (ArenaMatchRoom) and each phone is
 * sent its seat there with the match itself; the phone then leaves the queue.
 *
 * The phone keeps its own deadline. At it, it sends `cancel`: the answer is
 * either "cancelled" (play the bot) or, when the room paired it in that same
 * moment, "matched" with the seat — so a phone is never matched and then
 * absent. (Replies are plain messages, not `room.request()`, so SDK 0.17
 * clients work.)
 */
import { Room, type Client, matchMaker, CloseCode } from "@colyseus/core";

/** data/ArenaRules.js ARENA.powerWindow — keep in step. */
export const POWER_WINDOW = 2000;
/** core/ArenaNet.js ARENA_PROTO: phones speaking another protocol never meet. */
export const ARENA_PROTO = 2;
const TICK_MS = 500;

export interface ArenaEntry {
  name: string; level: number; fortPower: number; mineralLevel: number | null;
  stage: number; squad: string; proto: number;
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

/** "Hamza (FP 3000)" — how a player reads on the monitor. */
const label = (e: ArenaEntry) => `${e.name || "(no name)"} (FP ${e.fortPower})`;

const int = (v: unknown, lo: number, hi: number, dflt: number) =>
  Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : dflt;

function cleanEntry(o: any): ArenaEntry {
  return {
    name: String(o?.name ?? "").slice(0, 24),
    level: int(o?.level, 1, 9999, 1),
    fortPower: int(o?.fortPower, 0, 1e9, 0),
    mineralLevel: o?.mineralLevel == null ? null : int(o.mineralLevel, 1, 999, 10),
    stage: int(o?.stage, 1, 100000, 1),
    squad: typeof o?.squad === "string" ? o.squad.slice(0, 20000) : "[]",
    proto: int(o?.proto, 0, 999, 0),
  };
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
        .map((o) => ({ o, fortPower: o.entry.fortPower, ts: o.ts }));
      const pick = pickByFortPower(w.entry.fortPower, others);
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
