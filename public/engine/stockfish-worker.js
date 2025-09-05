// stockfish-worker.js (bridge) — runs inside a DedicatedWorker
// Place this file next to stockfish.js and stockfish.wasm under /engine/

// Configure Module and file resolution BEFORE loading the engine
self.Module = self.Module || {};
// Ensure the global variable name that Emscripten expects is defined
// Stockfish(Module) reads properties from this object; keep it identical to self.Module
var Module = self.Module;

// Important: give pthread helper a definite main script URL (string or Blob)
// Using an absolute URL avoids any basePath ambiguity inside nested workers.
try {
  self.Module.mainScriptUrlOrBlob = new URL('stockfish.js', self.location).href;
} catch {
  self.Module.mainScriptUrlOrBlob = 'stockfish.js';
}

// Ensure both the wasm and the pthread helper resolve in this folder.
// Return absolute URLs so fetch/Worker/importScripts don't depend on base.
self.Module.locateFile = function(requestedPath /*, prefix */) {
  try {
    const name = String(requestedPath).split('?')[0].split('/').pop();
    return new URL(name, self.location).href;
  } catch {
    return requestedPath;
  }
};

// Forward engine stdout/stderr to the main thread (used for UCI lines)
self.Module.print = function(text) { try { self.postMessage(String(text)); } catch {} };
self.Module.printErr = function(text) { try { self.postMessage(String(text)); } catch {} };

let engine = null;
const queue = [];
// Capture messages that may arrive before the engine and handler are ready
self.onmessage = function(e) {
  try {
    const msg = e && e.data != null ? e.data : e;
    // If engine is not initialized yet, buffer the message
    if (!engine) { queue.push(msg); return; }
    engine.postMessage(msg);
  } catch {}
};

// Load the Emscripten factory and create the engine instance
try {
  importScripts('stockfish.js');
  if (typeof Stockfish === 'function') {
    try {
      engine = Stockfish(Module);
    } catch (e) {
      try { self.postMessage('stockfish worker error: Stockfish() failed: ' + (e && e.message ? e.message : String(e))); } catch {}
      throw e;
    }

    // Bridge engine -> main
    // Some builds expose worker-like onmessage; others expose addMessageListener with text lines.
    engine.onmessage = function(e) {
      try {
        const msg = e && e.data != null ? e.data : e;
        self.postMessage(msg);
      } catch {}
    };
    if (typeof engine.addMessageListener === 'function') {
      try {
        engine.addMessageListener(function(line){
          try { self.postMessage(String(line)); } catch {}
        });
      } catch {}
    }

    // Bridge main -> engine (flush any queued messages buffered before init)
    self.onmessage = function(e) {
      try {
        const msg = e && e.data != null ? e.data : e;
        engine.postMessage(msg);
      } catch {}
    };

    // Flush any queued messages that arrived before engine was created
    while (queue.length) { try { engine.postMessage(queue.shift()); } catch {} }
    // The main thread sends 'uci' and proceeds through the UCI handshake.
  } else {
    try { self.postMessage('stockfish worker error: Stockfish() not found after importScripts'); } catch {}
  }
} catch (err) {
  try { self.postMessage('stockfish importScripts error: ' + (err && err.message ? err.message : String(err))); } catch {}
}
