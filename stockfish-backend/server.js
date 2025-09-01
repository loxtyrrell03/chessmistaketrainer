import express from 'express';
import { Chess } from 'chess.js';
import { spawn } from 'node:child_process';

// Severity thresholds (centipawns)
const DEFAULT_THR = { inacc: 50, mistake: 150, blunder: 300 };

function severityFromDrop(cp, thr = DEFAULT_THR) {
  const x = Math.abs(Math.round(cp));
  if (x >= thr.blunder) return 'blunder';
  if (x >= thr.mistake) return 'mistake';
  if (x >= thr.inacc) return 'inaccuracy';
  return null;
}

function startEngine() {
  const eng = spawn('stockfish');
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

  eng.stdout.on('data', (chunk) => {
    buf += chunk;
    let lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line === 'uciok') { readyUci = true; send('isready'); continue; }
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

  async function analyzeFen(fen, depth = 12) {
    await waitReady();
    lastScore = { cp: 0, mate: null };
    lastPV = [];
    send('ucinewgame');
    send('position fen ' + fen);
    const p = new Promise((res) => resolvers.push(res));
    send('go depth ' + depth);
    const out = await p;
    const cp = out.score.mate !== null ? (out.score.mate > 0 ? 10000 : -10000) : out.score.cp;
    return { cp, bestmove: out.bestmove, pv: out.pv };
  }

  return { analyzeFen, kill: () => { try { eng.kill('SIGTERM'); } catch {} } };
}

async function analyzePGNWithEngine(pgn, depth = 12, thr = DEFAULT_THR) {
  const engine = startEngine();
  try {
    const chess = new Chess();
    chess.loadPgn(pgn, { sloppy: true });
    const verboseMoves = chess.history({ verbose: true });
    const game = new Chess();
    const mistakes = [];
    for (const mv of verboseMoves) {
      const fenBefore = game.fen();
      const side = game.turn(); // 'w' or 'b'
      const { cp: cpBefore, bestmove, pv } = await engine.analyzeFen(fenBefore, depth);
      // apply the move
      game.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      const fenAfter = game.fen();
      const { cp: cpAfter } = await engine.analyzeFen(fenAfter, depth);
      const drop = Math.max(0, cpBefore + cpAfter);
      const sev = severityFromDrop(drop, thr);
      if (sev) {
        mistakes.push({
          fen: fenBefore,
          side,
          played: mv.san,
          best: bestmove,
          deltaCp: drop,
          severity: sev,
          pvUci: pv,
        });
      }
    }
    return mistakes;
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
    const { pgn, depth, thresholds } = req.body || {};
    if (!pgn || typeof pgn !== 'string') {
      res.status(400).json({ error: 'Missing pgn' });
      return;
    }
    const d = Math.max(6, Math.min(18, parseInt(depth || 12, 10) || 12));
    const thr = {
      inacc: Math.max(0, thresholds?.inacc ?? DEFAULT_THR.inacc),
      mistake: Math.max(0, thresholds?.mistake ?? DEFAULT_THR.mistake),
      blunder: Math.max(0, thresholds?.blunder ?? DEFAULT_THR.blunder),
    };
    const mistakes = await analyzePGNWithEngine(pgn, d, thr);
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
