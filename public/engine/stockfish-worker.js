// stockfish-worker.js (bridge)
try { self.postMessage('bridge: boot'); } catch {}
// Runs Stockfish (Emscripten) inside a Web Worker and bridges messages.
// Place this file next to stockfish.js and stockfish.wasm under /engine/.

// Configure Module and locateFile so the wasm resolves within this folder
self.Module = self.Module || {};
// Ensure pthread helper gets a string URL to import for the main script
// This avoids createObjectURL(undefined) inside stockfish.worker.js
self.Module.mainScriptUrlOrBlob = 'stockfish.js';
self.Module.locateFile = function(requestedPath) {
  try {
    const noQuery = String(requestedPath).split('?')[0];
    return noQuery.split('/').pop(); // resolve to local file in this folder
  } catch { return requestedPath; }
};

// Route engine prints back to the main thread for visibility
self.Module.print = function(text) { try { self.postMessage(String(text)); } catch {} };
self.Module.printErr = function(text) { try { self.postMessage(String(text)); } catch {} };

let engine = null;
let ready = false;
const q = [];
try {
  importScripts('stockfish.js');
  try { self.postMessage('bridge: stockfish.js loaded'); } catch {}
  if (typeof Stockfish === 'function') {
    try {
      engine = Stockfish(Module);
      self.postMessage('bridge: Stockfish() created');
    } catch (e) {
      self.postMessage('bridge: Stockfish() failed: ' + (e && e.message ? e.message : String(e)));
      throw e;
    }
    // Bridge engine -> main
    engine.onmessage = function(e){
      try {
        const msg = e && e.data != null ? e.data : e;
        if (String(msg).trim() === 'uciok') ready = true;
        self.postMessage(msg);
      } catch {}
    };
    // Bridge main -> engine
    self.onmessage = function(e){
      try {
        const msg = e && e.data != null ? e.data : e;
        if (engine) engine.postMessage(msg); else q.push(msg);
      } catch {}
    };
    // Flush any queued messages that arrived early
    while (q.length) { try { engine.postMessage(q.shift()); } catch {} }
    // Signal ready path will proceed via 'uciok' after we send 'uci' from main
  } else {
    self.postMessage('stockfish worker error: Stockfish() not found after importScripts');
  }
} catch (err) {
  self.postMessage('stockfish importScripts error: ' + (err && err.message ? err.message : String(err)));
}
