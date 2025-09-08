import express from 'express';
import { Chess } from 'chess.js';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

// Severity thresholds (centipawns)
const DEFAULT_THR = { inacc: 50, mistake: 150, blunder: 300 };

function severityFromDrop(cp, thr = DEFAULT_THR) {
  const x = Math.abs(Math.round(cp));
  if (x >= thr.blunder) return 'blunder';
  if (x >= thr.mistake) return 'mistake';
  if (x >= thr.inacc) return 'inaccuracy';
  return null;
}

function findEnginePath() {
  const ordered = [
    process.env.STOCKFISH_PATH,
    '/usr/local/bin/stockfish',
    '/usr/games/stockfish',
    '/usr/bin/stockfish',
    '/bin/stockfish',
  ].filter(Boolean);
  for (const p of ordered) {
    try { if (p && existsSync(p)) return p; } catch {}
  }
  try {
    const out = execFileSync('which', ['stockfish'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out && existsSync(out)) return out;
  } catch {}
  return null;
}

function startEngine() {
  const bin = findEnginePath();
  if (!bin) throw new Error('Stockfish binary not found on PATH');
  const eng = spawn(bin);
  eng.stderr.setEncoding('utf8');
  eng.stdout.setEncoding('utf8');
  let buf = '';
  let readyUci = false;
  let readyOk = false;
  let lastScore = { cp: 0, mate: null };
  let lastPV = [];
  const resolvers = [];

  function send(cmd) {
    eng.stdin.write(cmd + '\n');
  }

  eng.on('error', (err) => {
    console.error('Stockfish spawn error:', err);
  });

  eng.stdout.on('data', (chunk) => {
    buf += chunk;
    let lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line === 'uciok') {
        // Apply engine options before going ready
        readyUci = true;
        try {
          const maxThreads = Math.max(1, Math.min(16, parseInt(process.env.STOCKFISH_THREADS || '0', 10) || (os.cpus()?.length || 1)));
          const hashMb = Math.max(16, Math.min(4096, parseInt(process.env.STOCKFISH_HASH_MB || '0', 10) || 256));
          send('setoption name Threads value ' + maxThreads);
          send('setoption name Hash value ' + hashMb);
          send('setoption name MultiPV value 1');
          send('setoption name UCI_AnalyseMode value true');
          send('setoption name Ponder value false');
        } catch {}
        send('isready');
        continue;
      }
      if (line === 'readyok') { readyOk = true; continue; }
      if (line.startsWith('info')) {
        const mMate = line.match(/score\s+mate\s+(-?\d+)/);
        const mCp = line.match(/score\s+cp\s+(-?\d+)/);
        const pvMatch = line.match(/\spv\s+(.*)$/);
        if (mMate) {
          const mate = parseInt(mMate[1], 10);
          lastScore = { mate, cp: mate > 0 ? 10000 : -10000 };
        } else if (mCp) {
          lastScore = { mate: null, cp: parseInt(mCp[1], 10) };
        }
        if (pvMatch) {
          lastPV = pvMatch[1].trim().split(/\s+/).slice(0, 12);
        }
      }
      if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        const bm = parts[1];
        const r = resolvers.shift();
        if (r) r({ bestmove: bm, score: lastScore, pv: lastPV });
      }
    }
  });

  send('uci');

  async function waitReady(timeoutMs = 5000) {
    const t0 = Date.now();
    while (!(readyUci && readyOk) && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function newGame(){
    try { send('ucinewgame'); } catch {}
  }

  async function analyzeFen(fen, depth = 12) {
    await waitReady();
    lastScore = { cp: 0, mate: null };
    lastPV = [];
    send('position fen ' + fen);
    const p = new Promise((res) => resolvers.push(res));
    send('go depth ' + depth);
    const out = await p;
    const cp = out.score.mate !== null ? (out.score.mate > 0 ? 10000 : -10000) : out.score.cp;
    return { cp, bestmove: out.bestmove, pv: out.pv };
  }

  return { analyzeFen, newGame, kill: () => { try { eng.kill('SIGTERM'); } catch {} } };
}

async function analyzePGNWithEngine(pgn, depth = 12, thr = DEFAULT_THR, depthFast = 12) {
  const engine = startEngine();
  try {
    const chess = new Chess();
    chess.loadPgn(pgn, { sloppy: true });
    const verboseMoves = chess.history({ verbose: true });
    const game = new Chess();
    const candidates = [];
    engine.newGame(); // reset TT once per game, then reuse across positions

    // Pass 1: fast scan at low depth to find candidate mistakes
    for (const mv of verboseMoves) {
      const fenBefore = game.fen();
      const side = game.turn(); // 'w' or 'b'
      const { cp: cpBefore1, bestmove: best1 } = await engine.analyzeFen(fenBefore, depthFast);
      game.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      const fenAfter = game.fen();
      const playedUci = (mv.from + mv.to + (mv.promotion ? String(mv.promotion).toLowerCase() : ''));
      if (playedUci === best1) { continue; } // correct move => not a mistake
      const { cp: cpAfter1 } = await engine.analyzeFen(fenAfter, depthFast);
      const drop1 = Math.max(0, cpBefore1 + cpAfter1);
      const sev1 = severityFromDrop(drop1, thr);
      if (sev1) {
        candidates.push({ fenBefore, fenAfter, side, san: mv.san, playedUci });
      }
    }

    // Pass 2: deep analysis only for candidates
    const out = [];
    for (const c of candidates) {
      const { cp: cpBefore2, bestmove: best2, pv } = await engine.analyzeFen(c.fenBefore, depth);
      let drop2 = 0;
      if (c.playedUci === best2) {
        // Deep search considers it correct after all; skip
        continue;
      } else {
        const { cp: cpAfter2 } = await engine.analyzeFen(c.fenAfter, depth);
        drop2 = Math.max(0, cpBefore2 + cpAfter2);
      }
      const sev2 = severityFromDrop(drop2, thr);
      if (!sev2) continue;
      out.push({
        fen: c.fenBefore,
        side: c.side,
        played: c.san,
        best: best2,
        deltaCp: drop2,
        severity: sev2,
        pvUci: pv,
      });
    }
    return out;
  } finally {
    engine.kill();
  }
}

// Pass 1 only — return candidate positions based on fast depth
async function scanPGNWithEngine(pgn, thr = DEFAULT_THR, depthFast = 12) {
  const engine = startEngine();
  try {
    const chess = new Chess();
    chess.loadPgn(pgn, { sloppy: true });
    const verboseMoves = chess.history({ verbose: true });
    const game = new Chess();
    const candidates = [];
    engine.newGame();
    for (const mv of verboseMoves) {
      const fenBefore = game.fen();
      const side = game.turn();
      const { cp: cpBefore1, bestmove: best1 } = await engine.analyzeFen(fenBefore, depthFast);
      game.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      const fenAfter = game.fen();
      const playedUci = (mv.from + mv.to + (mv.promotion ? String(mv.promotion).toLowerCase() : ''));
      if (playedUci === best1) { continue; }
      const { cp: cpAfter1 } = await engine.analyzeFen(fenAfter, depthFast);
      const drop1 = Math.max(0, cpBefore1 + cpAfter1);
      const sev1 = severityFromDrop(drop1, thr);
      if (sev1) {
        candidates.push({ fenBefore, fenAfter, side, san: mv.san, playedUci });
      }
    }
    return candidates;
  } finally {
    engine.kill();
  }
}

// Pass 2 only — analyze provided candidates at deep depth
async function analyzeCandidatesWithEngine(candidates, depth = 12, thr = DEFAULT_THR) {
  const engine = startEngine();
  try {
    const out = [];
    engine.newGame();
    for (const c of (candidates || [])) {
      const { cp: cpBefore2, bestmove: best2, pv } = await engine.analyzeFen(c.fenBefore, depth);
      let drop2 = 0;
      if (c.playedUci === best2) {
        continue;
      } else {
        const { cp: cpAfter2 } = await engine.analyzeFen(c.fenAfter, depth);
        drop2 = Math.max(0, cpBefore2 + cpAfter2);
      }
      const sev2 = severityFromDrop(drop2, thr);
      if (!sev2) continue;
      out.push({
        fen: c.fenBefore,
        side: c.side,
        played: c.san,
        best: best2,
        deltaCp: drop2,
        severity: sev2,
        pvUci: pv,
      });
    }
    return out;
  } finally {
    engine.kill();
  }
}

const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json({ limit: '5mb' }));

// Health
app.get('/', (req, res) => {
  res.status(200).json({ ok: true });
});

// Analyze endpoint
// Body: { pgn: string, depth?: number, thresholds?: { inacc, mistake, blunder } }
app.post('/analyze', async (req, res) => {
  try {
    const { pgn, depth, thresholds, depthFast } = req.body || {};
    if (!pgn || typeof pgn !== 'string') {
      res.status(400).json({ error: 'Missing pgn' });
      return;
    }
    const d = Math.max(6, Math.min(18, parseInt(depth || 12, 10) || 12));
    const dFast = Math.max(4, Math.min(12, parseInt(depthFast || 12, 10) || 12));
    const thr = {
      inacc: Math.max(0, thresholds?.inacc ?? DEFAULT_THR.inacc),
      mistake: Math.max(0, thresholds?.mistake ?? DEFAULT_THR.mistake),
      blunder: Math.max(0, thresholds?.blunder ?? DEFAULT_THR.blunder),
    };
    const mistakes = await analyzePGNWithEngine(pgn, d, thr, dFast);
    res.status(200).json({ mistakes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

// Fast pass scan endpoint
app.post('/scan', async (req, res) => {
  try {
    const { pgn, thresholds, depthFast } = req.body || {};
    if (!pgn || typeof pgn !== 'string') { res.status(400).json({ error: 'Missing pgn' }); return; }
    const dFast = Math.max(4, Math.min(30, parseInt(depthFast || 12, 10) || 12));
    const thr = {
      inacc: Math.max(0, thresholds?.inacc ?? DEFAULT_THR.inacc),
      mistake: Math.max(0, thresholds?.mistake ?? DEFAULT_THR.mistake),
      blunder: Math.max(0, thresholds?.blunder ?? DEFAULT_THR.blunder),
    };
    const candidates = await scanPGNWithEngine(pgn, thr, dFast);
    res.status(200).json({ candidates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

// Deep pass endpoint
app.post('/analyzeCandidates', async (req, res) => {
  try {
    const { candidates, depth, thresholds } = req.body || {};
    if (!Array.isArray(candidates)) { res.status(400).json({ error: 'Missing candidates[]' }); return; }
    const d = Math.max(6, Math.min(30, parseInt(depth || 12, 10) || 12));
    const thr = {
      inacc: Math.max(0, thresholds?.inacc ?? DEFAULT_THR.inacc),
      mistake: Math.max(0, thresholds?.mistake ?? DEFAULT_THR.mistake),
      blunder: Math.max(0, thresholds?.blunder ?? DEFAULT_THR.blunder),
    };
    const mistakes = await analyzeCandidatesWithEngine(candidates, d, thr);
    res.status(200).json({ mistakes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('Stockfish backend listening on', PORT);
});
