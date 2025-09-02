// stockfish-worker.js
// Robust wrapper: sets Module.locateFile to resolve the wasm reliably,
// then imports the real stockfish.js glue with importScripts.
// Place this file in public/engine/ next to stockfish.js and stockfish.wasm.

self.Module = self.Module || {};

// Make locateFile robust: resolve to the same folder as this worker (project-relative)
self.Module.locateFile = function(requestedPath, prefix) {
  try {
    // extract basename (strip any directory or query string)
    // examples handled:
    //  - "stockfish.wasm"
    //  - "./stockfish.wasm"
    //  - "some/path/stockfish.wasm?version=123"
    //  - "stockfish.wasm.wasm" => we take basename which avoids doubling paths
    const url = requestedPath + '';
    // strip query string
    const noQuery = url.split('?')[0];
    // take basename
    const parts = noQuery.split('/');
    const base = parts[parts.length - 1] || noQuery;
    // final path relative to this worker's folder
    return base;
  } catch (err) {
    // fallback naive basename
    try { return (requestedPath+'').split('/').pop(); } catch { return requestedPath; }
  }
};

// route Emscripten prints to main thread so you see loader logs
self.Module.print = function(text) { self.postMessage(String(text)); };
self.Module.printErr = function(text) { self.postMessage(String(text)); };

// import the actual stockfish glue (relative to this worker's folder)
try {
  importScripts('stockfish.js');
} catch (err) {
  // send a clear error so it shows in the main page console
  self.postMessage('stockfish importScripts error: ' + (err && err.message ? err.message : String(err)));
}
