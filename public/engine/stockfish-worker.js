// stockfish-worker.js (bridge) — runs inside a DedicatedWorker
// Place this file next to stockfish.js and stockfish.wasm under /engine/

// Configure Module and file resolution BEFORE loading the engine
self.Module = self.Module || {};
// Ensure the global variable name that Emscripten expects is defined
// Stockfish(Module) reads properties from this object; keep it identical to self.Module
var Module = self.Module;

// Minimal diagnostics to confirm bridge is running
try { self.postMessage('[bridge] boot'); } catch {}

// Important: give pthread helper a definite main script URL (string or Blob)
// Using an absolute URL avoids any basePath ambiguity inside nested workers.
try {
  // Use absolute to be robust against base URL quirks
  self.Module.mainScriptUrlOrBlob = '/engine/stockfish.js';
} catch {
  self.Module.mainScriptUrlOrBlob = '/engine/stockfish.js';
}

// Ensure both the wasm and the pthread helper resolve in this folder.
// Return absolute URLs so fetch/Worker/importScripts don't depend on base.
self.Module.locateFile = function(requestedPath /*, prefix */) {
  try {
    const name = String(requestedPath).split('?')[0].split('/').pop();
    // Always serve engine assets from /engine/
    return '/engine/' + name;
  } catch {
    return '/engine/' + requestedPath;
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
  importScripts('/engine/stockfish.js');
  if (typeof Stockfish === 'function') {
    const attach = (inst) => {
      engine = inst;
      try { self.postMessage('[bridge] engine created'); } catch {}

      // Hook outputs: prefer message listener; also set print hooks as fallback
      try {
        if (engine && typeof engine.addMessageListener === 'function') {
          engine.addMessageListener(function(line){ try { self.postMessage(String(line)); } catch {} });
          try { self.postMessage('[bridge] addMessageListener installed'); } catch {}
        } else {
          try { self.postMessage('[bridge] addMessageListener not available'); } catch {}
        }
        if (engine) {
          engine.print = function(t){ try { self.postMessage(String(t)); } catch {} };
          engine.printErr = function(t){ try { self.postMessage(String(t)); } catch {} };
          try { self.postMessage('[bridge] print hooks set'); } catch {}
        }
      } catch (hookErr) {
        try { self.postMessage('[bridge] hook error: ' + (hookErr && hookErr.message ? hookErr.message : String(hookErr))); } catch {}
      }

      // Bridge engine -> main
      if (engine) {
        engine.onmessage = function(e) {
          try {
            const msg = e && e.data != null ? e.data : e;
            self.postMessage(msg);
          } catch {}
        };
      }

      // Bridge main -> engine (flush any queued messages buffered before init)
      self.onmessage = function(e) {
        try {
          const msg = e && e.data != null ? e.data : e;
          engine && engine.postMessage && engine.postMessage(msg);
        } catch {}
      };

      // Flush queued messages and send UCI
      try { self.postMessage('[bridge] flush ' + queue.length + ' queued'); } catch {}
      while (queue.length) { try { engine.postMessage(queue.shift()); } catch {} }
      try { engine.postMessage('uci'); self.postMessage('[bridge] sent uci'); } catch (e) { try { self.postMessage('[bridge] post uci error: ' + (e && e.message ? e.message : String(e))); } catch {} }
    };

    try {
      const maybe = Stockfish(Module);
      if (maybe && typeof maybe.then === 'function') {
        // Promise resolves to engine instance
        maybe.then((inst)=>{ try { self.postMessage('[bridge] ready'); } catch {} ; attach(inst); });
      } else if (maybe && maybe.ready && typeof maybe.ready.then === 'function') {
        maybe.ready.then(()=>{ try { self.postMessage('[bridge] ready'); } catch {} ; attach(maybe); });
      } else {
        attach(maybe);
      }
    } catch (e) {
      try { self.postMessage('stockfish worker error: Stockfish() failed: ' + (e && e.message ? e.message : String(e))); } catch {}
      throw e;
    }
  } else {
    try { self.postMessage('stockfish worker error: Stockfish() not found after importScripts'); } catch {}
  }
} catch (err) {
  try { self.postMessage('stockfish importScripts error: ' + (err && err.message ? err.message : String(err))); } catch {}
}
