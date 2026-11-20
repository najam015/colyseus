/**
 * One live Fort Conquerors arena match: a relay between its two phones (was
 * Firebase arenaMatches/{id} in the game's core/ArenaNet.js).
 *
 * The battle itself runs on each phone (core/ArenaStream.js) — every phone
 * is in charge of its own side and tells the other only what happened:
 * releases, its own deaths, its fort's health, the result, a heartbeat. So
 * this room keeps no game state and simulates nothing; it hands each side's
 * events to the other, in the order they were sent (one WebSocket each, so
 * order is kept), and says when one side has gone:
 *
 *   client → room   "ready"     handlers are attached: send what is waiting
 *                   "ev"        an event for the other side
 *                   "takeover"  this phone's bot took the other side over
 *                   "bye"       this side left the match
 *                   "ping"      the server clock, for the phone's release
 *                               timestamps: answered "pong" { t, s }
 *   room → client   "ev"        an event from the other side
 *                   "left"      the other side left or dropped for good
 *                   "kicked"    the other phone took THIS side over
 *                   "pong"      the answer to "ping"
 *
 * Events for a side that is not listening yet (its seat is reserved, it is
 * still connecting, or it has joined but not said "ready") wait here and go
 * to it on "ready" — sent on join, they would arrive before the phone had
 * attached its handlers, and be dropped. A dropped phone gets a
 * 45 s to come back (the SDK reconnects by itself), its events held here
 * meanwhile; after that the other side hears "left" and wins.
 */
import { Room, type Client, CloseCode } from "@colyseus/core";

/** A dropped phone's window to come back. It was 8 s; on a slow, unstable
 *  link (Pakistan, 2026-11) one reconnect handshake alone can take 15 s. */
const RECONNECT_SECONDS = 45;
const MAX_EVENT_CHARS = 2000;
const MAX_BUFFERED = 2000;   // ~45 s of a busy match (fort reports, acks, releases)

type Side = "a" | "b";
const otherOf = (s: Side): Side => (s === "a" ? "b" : "a");

export class ArenaMatchRoom extends Room {
  maxClients = 2;
  /** Seconds a reserved seat waits for its WebSocket (Colyseus default 15).
   *  Through Cloudflare from Pakistan the WebSocket handshake alone measured
   *  15.3 s, so the seat expired before the phone arrived ("seat reservation
   *  expired") and every search ended with the bot. */
  seatReservationTimeout = 60;
  private node: any;
  private clients_ = new Map<Side, Client>();
  private sideOf = new Map<string, Side>();       // sessionId -> side
  private buffered: Record<Side, any[]> = { a: [], b: [] };
  private gone = new Set<Side>();
  private ready = new Set<Side>();
  /** Sides whose socket dropped and may come back: their events wait in
   *  `buffered` (sent to a dropped socket they would be lost). */
  private dropped = new Set<Side>();
  /** Each side as the /monitor panel shows it. */
  private status: Record<Side, string> = { a: "seat reserved", b: "seat reserved" };

  messages = {
    ready: (client: Client) => {
      const side = this.sideOf.get(client.sessionId);
      if (!side || this.ready.has(side)) return;
      this.ready.add(side);
      this.setStatus(side, "playing");
      for (const [type, msg] of this.buffered[side].splice(0)) client.send(type, msg);
      if (this.gone.has(otherOf(side))) client.send("left", true);
    },
    ev: (client: Client, event: unknown) => {
      const side = this.sideOf.get(client.sessionId);
      if (!side || event == null) return;
      if (JSON.stringify(event).length > MAX_EVENT_CHARS) return;
      this.toSide(otherOf(side), "ev", event);
    },
    takeover: (client: Client, turn: unknown) => {
      const side = this.sideOf.get(client.sessionId);
      if (side) this.toSide(otherOf(side), "kicked", Number(turn) || 0);
    },
    bye: (client: Client) => {
      const side = this.sideOf.get(client.sessionId);
      if (side) this.sideGone(side);
    },
    /** The server clock, for the phone's release timestamps: answered as
     *  "pong" { t: the phone's own send time, s: the server's now }. */
    ping: (client: Client, t: unknown) => { client.send("pong", { t: Number(t) || 0, s: Date.now() }); },
  };

  onCreate(options: { node: any }) {
    this.node = options?.node;
    // nobody may find this room by matchmaking: seats are reserved by the queue
    this.setPrivate(true);
    const who = (s: Side) => `${this.node?.[s]?.name || "(no name)"} (FP ${this.node?.[s]?.fortPower ?? "?"})`;
    this.setMetadata({
      game: "fort_conquer", a: this.node?.a?.name, b: this.node?.b?.name, stage: this.node?.stage,
      players: `${who("a")} vs ${who("b")}`,
    });
    this.publishStatus();
  }


  onJoin(client: Client, options: { side?: Side }) {
    const side: Side = options?.side === "b" ? "b" : "a";
    this.clients_.set(side, client);
    this.sideOf.set(client.sessionId, side);
    this.setStatus(side, "joined");
  }

  onDrop(client: Client) {
    const side = this.sideOf.get(client.sessionId);
    if (side) { this.dropped.add(side); this.setStatus(side, "reconnecting"); }
    this.allowReconnection(client, RECONNECT_SECONDS).catch(() => {});
  }

  onReconnect(client: Client) {
    const side = this.sideOf.get(client.sessionId);
    if (!side) return;
    this.clients_.set(side, client);
    this.dropped.delete(side);
    this.setStatus(side, this.ready.has(side) ? "playing" : "joined");
    // what was said while it was away (the phone also asks the other for
    // anything lost in flight, and drops what it already had)
    if (this.ready.has(side)) for (const [type, msg] of this.buffered[side].splice(0)) client.send(type, msg);
  }

  onLeave(client: Client, code: CloseCode) {
    const side = this.sideOf.get(client.sessionId);
    if (side) this.sideGone(side);
  }

  private sideGone(side: Side) {
    if (this.gone.has(side)) return;
    this.gone.add(side);
    this.setStatus(side, "left");
    this.toSide(otherOf(side), "left", true);
  }

  /* ── the /monitor panel: each side's status in the room's metadata (a
   * column in the room list) and the detail on its inspect page ──────── */

  private setStatus(side: Side, status: string) {
    if (this.status[side] === status) return;
    this.status[side] = status;
    this.publishStatus();
  }

  private publishStatus() {
    const name = (s: Side) => this.node?.[s]?.name || s.toUpperCase();
    this.setMetadata({ status: `${name("a")}: ${this.status.a} · ${name("b")}: ${this.status.b}` }).catch(() => {});
  }

  async getInspectData() {
    const base = await (Room.prototype as any).getInspectData.call(this);
    const side = (s: Side) => ({
      name: this.node?.[s]?.name || "(no name)", level: this.node?.[s]?.level,
      fortPower: this.node?.[s]?.fortPower, minerLevel: this.node?.[s]?.mineralLevel,
      status: this.status[s], sessionId: this.clients_.get(s)?.sessionId ?? null,
      eventsWaitingForIt: this.buffered[s].length,
    });
    return {
      ...base,
      state: {
        stage: this.node?.stage, seed: this.node?.seed,
        startedAt: this.node?.createdAt ? new Date(this.node.createdAt).toISOString() : null,
        a: side("a"), b: side("b"),
      },
    };
  }

  private toSide(side: Side, type: string, msg: unknown) {
    const c = this.clients_.get(side);
    if (c && this.ready.has(side) && !this.dropped.has(side)) { c.send(type, msg); return; }
    if (this.gone.has(side)) return;
    const q = this.buffered[side];
    if (q.length < MAX_BUFFERED) q.push([type, msg]);
  }
}
