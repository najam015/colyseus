/**
 * Password protection for the /monitor panel (HTTP Basic auth).
 *
 * The monitor shows every live room and client and can dispose rooms, so it
 * must never be public. Colyseus 0.18 has `basicAuth` and a `use` option on
 * monitor() for this; 0.17 has neither, so this is the same thing as plain
 * Express middleware placed in front of the monitor's router.
 *
 * Credentials come from the environment (set them in Render → Environment):
 *   MONITOR_USERNAME   (default "admin")
 *   MONITOR_PASSWORD   required — without it the monitor is switched OFF
 *                      (404), never left open
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  // compare in constant time, and never leak the length through an early exit
  return x.length === y.length ? timingSafeEqual(x, y) : (timingSafeEqual(x, x), false);
};

export function monitorGuard() {
  const user = process.env.MONITOR_USERNAME || "admin";
  const pass = process.env.MONITOR_PASSWORD || "";
  if (!pass) console.warn("[monitor] MONITOR_PASSWORD is not set: /monitor is switched off");

  return (req: Request, res: Response, next: NextFunction) => {
    if (!pass) { res.status(404).send("Not found"); return; }
    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i >= 0) {
        // both compared every time, so a wrong name takes as long as a wrong password
        const okUser = same(decoded.slice(0, i), user);
        const okPass = same(decoded.slice(i + 1), pass);
        if (okUser && okPass) { next(); return; }
      }
    }
    res.set("WWW-Authenticate", 'Basic realm="Colyseus monitor", charset="UTF-8"');
    res.status(401).send("Authentication required");
  };
}
