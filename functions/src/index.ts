/**
 * HTTPS proxy functions for Lichess and Chess.com to avoid browser CORS.
 * - v2 Functions (Node 18+); global fetch is available.
 */

import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import * as logger from "firebase-functions/logger";

// Deploy close to your Firestore DB for lower latency
setGlobalOptions({ region: "europe-west2", maxInstances: 10 });

function setCors(res: any) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export const fetchLichess = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  try {
    const username = (req.query.username as string || "").trim();
    const max = Math.max(1, Math.min(50, parseInt(String(req.query.max || 5), 10) || 5));
    if (!username) { res.status(400).json({ error: "Missing username" }); return; }

    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${max}&pgnInJson=true&evals=true&accuracy=true&clocks=false`;
    const r = await fetch(url, {
      headers: { Accept: "application/x-ndjson" },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      logger.warn("Lichess upstream error", { status: r.status, txt });
      res.status(502).json({ error: "Upstream Lichess error", status: r.status });
      return;
    }
    const body = await r.text();
    const lines = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const parsed: any[] = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch (e) { /* ignore bad line */ }
    }
    const games = parsed.map((g) => ({
      id: g.id,
      rated: g.rated,
      speed: g.speed,
      variant: g.variant,
      createdAt: g.createdAt,
      lastMoveAt: g.lastMoveAt,
      white: g.players?.white?.user?.name || g.players?.white?.userId,
      black: g.players?.black?.user?.name || g.players?.black?.userId,
      pgn: g.pgn,
    })).filter((g) => !!g.pgn);

    res.status(200).json({ games });
    return;
  } catch (err: any) {
    logger.error("fetchLichess failure", err);
    res.status(500).json({ error: "Internal error" });
    return;
  }
});

export const fetchChessCom = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  try {
    const username = (req.query.username as string || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit || 5), 10) || 5));
    if (!username) { res.status(400).json({ error: "Missing username" }); return; }

    const arcUrl = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
    const arcRes = await fetch(arcUrl);
    if (!arcRes.ok) {
      const t = await arcRes.text().catch(() => "");
      logger.warn("Chess.com archives error", { status: arcRes.status, t });
      res.status(502).json({ error: "Upstream Chess.com error", status: arcRes.status });
      return;
    }
    const arcJson = await arcRes.json() as { archives?: string[] };
    const archives = (arcJson.archives || []).slice().reverse(); // newest first
    const out: any[] = [];
    for (const url of archives) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const m = await r.json() as { games?: any[] };
        for (const g of (m.games || [])) {
          if (!g?.pgn) continue;
          out.push({
            end_time: g.end_time,
            time_class: g.time_class,
            rated: g.rated,
            white: g.white?.username,
            black: g.black?.username,
            pgn: g.pgn,
          });
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      } catch (e) { /* ignore */ }
    }
    res.status(200).json({ games: out.slice(0, limit) });
    return;
  } catch (err: any) {
    logger.error("fetchChessCom failure", err);
    res.status(500).json({ error: "Internal error" });
    return;
  }
});
