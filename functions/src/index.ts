/**
 * HTTPS proxy functions for Lichess and Chess.com to avoid browser CORS.
 * - v2 Functions (Node 18+); global fetch is available.
 */

import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import * as logger from "firebase-functions/logger";
import type { Request, Response } from "firebase-functions/v2/https";

// Optional runtime deps (declared in package.json):
//  - chess.js for PGN parsing
//  - stockfish (WASM-in-Node) for UCI analysis
// We use dynamic import to keep cold start lightweight.

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

// --- Backend analysis of PGNs via Stockfish ---

type Sev = { inacc: number; mistake: number; blunder: number };

function severityFromDrop(cp: number, thr: Sev): "inaccuracy"|"mistake"|"blunder"|null {
  const x = Math.abs(Math.round(cp));
  if (x >= thr.blunder) return "blunder";
  if (x >= thr.mistake) return "mistake";
  if (x >= thr.inacc) return "inaccuracy";
  return null;
}

async function createEngine() {
  // stockfish npm exposes a function returning a worker-like object
  const Stockfish: any = (await import("stockfish.wasm")) as any;
  const sf: any = (typeof (Stockfish as any) === "function") ? (Stockfish as any)() : (Stockfish as any);
  let ready = false;
  let lastScore: { cp: number; mate: number|null } = { cp: 0, mate: null };
  let lastPV: string[] = [];
  const resolvers: Array<(o: { bestmove: string; score: typeof lastScore; pv: string[] })=>void> = [];
  sf.onmessage = (e: any) => {
    const line = (""+(e.data ?? e)).trim();
    // logger.debug("SF:", line);
    if (line === "uciok") { sf.postMessage("isready"); return; }
    if (line === "readyok") { ready = true; return; }
    if (line.startsWith("info")) {
      const mMate = line.match(/score\s+mate\s+(-?\d+)/);
      const mCp = line.match(/score\s+cp\s+(-?\d+)/);
      const pvMatch = line.match(/\spv\s+(.*)$/);
      if (mMate) { lastScore = { mate: parseInt(mMate[1],10), cp: (mMate[1][0] === '-' ? -10000 : 10000) }; }
      else if (mCp) { lastScore = { cp: parseInt(mCp[1],10), mate: null }; }
      if (pvMatch) {
        lastPV = pvMatch[1].trim().split(/\s+/).slice(0, 10); // cap pv length
      }
    }
    if (line.startsWith("bestmove")) {
      const bm = line.split(" ")[1];
      const r = resolvers.shift();
      if (r) r({ bestmove: bm, score: lastScore, pv: lastPV });
    }
  };
  sf.postMessage("uci");
  const t0 = Date.now();
  while (!ready && Date.now()-t0 < 5000) await new Promise(r=>setTimeout(r,20));
  return {
    async analyze(fen: string, depth = 12) {
      sf.postMessage("ucinewgame");
      sf.postMessage("position fen "+fen);
      const p = new Promise<{ bestmove: string; score: typeof lastScore; pv: string[] }>(res=>resolvers.push(res));
      sf.postMessage("go depth "+depth);
      const out = await p;
      const cp = (out.score.mate!==null) ? (out.score.mate>0?10000:-10000) : out.score.cp;
      return { cp, bestmove: out.bestmove, pv: out.pv };
    }
  };
}

export const analyzePGNs = onRequest({ timeoutSeconds: 300 }, async (req: Request, res: Response) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST required" }); return; }
  try {
    const body = (req.body || {}) as { pgns?: string[]; depth?: number; thresholds?: Sev; usernames?: string[] };
    const pgns = Array.isArray(body.pgns) ? body.pgns.filter(s => typeof s === 'string' && s.trim()) : [];
    if (!pgns.length) { res.status(400).json({ error: "Missing pgns[]" }); return; }
    const depth = Math.max(6, Math.min(18, parseInt(String(body.depth||12),10) || 12));
    const thr: Sev = {
      inacc: Math.max(0, (body.thresholds?.inacc ?? 50)),
      mistake: Math.max(0, (body.thresholds?.mistake ?? 150)),
      blunder: Math.max(0, (body.thresholds?.blunder ?? 300)),
    };
    const usernames = (Array.isArray(body.usernames) ? body.usernames : []).map(s => String(s||'').toLowerCase()).filter(Boolean);

    const { Chess } = await import("chess.js");
    const engine = await createEngine();
    const mistakes: any[] = [];

    function parseHeaders(pgn: string){
      const h: Record<string,string> = {};
      const re = /\[(\w+)\s+"([^"]*)"\]/g; let m: RegExpExecArray|null;
      while((m = re.exec(pgn||''))) h[m[1]] = m[2];
      return h;
    }

    for (const pgn of pgns) {
      const chess = new Chess();
      chess.loadPgn(pgn, { sloppy: true });
      // Re-iterate from start to get sequence
      const game = new Chess();
      const moves = chess.history({ verbose: true });
      // Determine user's side from provided usernames and PGN headers
      let sideWanted: 'w'|'b'|null = null;
      if (usernames.length){
        try{
          const h = parseHeaders(pgn);
          const w = String(h.White||'').toLowerCase();
          const b = String(h.Black||'').toLowerCase();
          for(const nm of usernames){ if(w===nm || w.includes(nm)) { sideWanted='w'; break; } if(b===nm || b.includes(nm)) { sideWanted='b'; break; } }
        }catch{}
      }
      for (const mv of moves) {
        const fenBefore = game.fen();
        const side = game.turn();
        if (sideWanted && side !== sideWanted) { game.move({ from: mv.from, to: mv.to, promotion: mv.promotion }); continue; }
        const { cp: cpBefore, bestmove, pv } = await engine.analyze(fenBefore, depth);
        // apply move
        game.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
        const fenAfter = game.fen();
        const { cp: cpAfter } = await engine.analyze(fenAfter, depth);
        const drop = Math.max(0, cpBefore + cpAfter);
        const sev = severityFromDrop(drop, thr);
        if (sev) {
          mistakes.push({
            id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,
            fen: fenBefore,
            side,
            played: mv.san,
            best: bestmove,
            deltaCp: drop,
            severity: sev,
            nextReview: Date.now(),
            ef: 2.5, reps: 0, interval: 0,
            pvUci: pv,
          });
        }
      }
    }

    res.status(200).json({ mistakes });
    return;
  } catch (err: any) {
    logger.error("analyzePGNs failure", err);
    res.status(500).json({ error: "Internal error" });
    return;
  }
});
