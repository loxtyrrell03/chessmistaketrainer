# Personal Chess Mistake Trainer — Repository Instructions

> Purpose: Give AI coding assistants full context for this project so they generate **production-ready** code that fits our architecture, UX, and constraints.

## What we’re building
A **web app** that turns a player's past games into **trainable mistake cards**. Users import games (Lichess, Chess.com, or PGN), we detect inaccuracies/mistakes/blunders, then train them via **Woodpecker** cycles and **SM-2 spaced repetition**. Positions, attempts, and scheduling live locally (MVP) and in Firestore (Pro).

### Core user loop
Import → Extract mistakes → Train (Woodpecker or SRS) → Log results → See stats/themes → Repeat.

---

## Tech stack & constraints
- **Frontend:** Single-page app (Next step may be Next.js TS + Tailwind; MVP also runs as single `index.html`).
- **Board/Rules:** Lightweight in-repo engine (`ChessLite`) for FEN/SAN, legals, checks, promotions.
- **Engine analysis:** 
  - **Client:** `stockfish.wasm` (CDN or local) as fallback.
  - **Backend (later):** Firebase Cloud Functions running Stockfish (depth 16–17) with Pub/Sub queue.
- **Storage:**
  - MVP: `localStorage`.
  - Pro: **Firebase** (Auth + Firestore) for sync & long-term stats.
- **APIs:**
  - **Lichess:** `/api/games/user/{username}?since/until&evals=true` (PGN with `[%eval ...]` if analysis exists).
  - **Chess.com:** `/pub/player/{username}/games/YYYY/MM` (PGN; we run engine ourselves).
- **No secrets in client.** OpenAI keys or server analysis stay behind Cloud Functions.

---

## Mistake detection (authoritative spec)
- **Lichess games:** Use `[%eval]` comments. Compute drop relative to **side to move** using white-centipawn evals.
- **Chess.com & manual PGN:** Run engine at target depth; for each ply:
  - `cp_before` (side to move), apply move, `cp_after` (opponent to move).
  - **Drop** = `max(0, cp_before + cp_after)`.
- **Severity thresholds (absolute Δcp):**
  - `inaccuracy`: ≥ 50 cp
  - `mistake`: ≥ 150 cp
  - `blunder`: ≥ 300 cp
- Store per mistake:  
  ```ts
  {
    id, fen, side, played, best, deltaCp, severity,
    nextReview, ef, reps, interval,
    themes?: string[], createdAt: number
  }
