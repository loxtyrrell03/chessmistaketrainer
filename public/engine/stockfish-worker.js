// stockfish-worker.js (bridge) — runs inside a DedicatedWorker
// Place this file next to stockfish.js and stockfish.wasm under /engine/

// Configure Module and file resolution BEFORE loading the engine
self.Module = self.Module || {};
var __WDEBUG = true;
function ts(){ try { return new Date().toISOString() + ' +' + (Math.round((self.performance?.now?.()||0))+'ms'); } catch { return new Date().toISOString(); } }
function wlog(){ try { if(__WDEBUG) self.postMessage('[bridge] '+ts()+': '+Array.prototype.map.call(arguments, String).join(' ')); } catch {} }
// Ensure the global variable name that Emscripten expects is defined
// Stockfish(Module) reads properties from this object; keep it identical to self.Module
var Module = self.Module;

// Minimal diagnostics to confirm bridge is running
try { wlog('boot'); } catch {}

// Crash hardening: catch runtime errors like WASM OOB and signal main to respawn
try {
  self.addEventListener('error', function(ev){
    try {
      const msg = String((ev && ev.message) || ev || '');
      wlog('worker error', msg);
      if (/out of bounds/i.test(msg) || /RuntimeError/i.test(msg)) {
        try { self.postMessage('__bridge_oob__'); } catch {}
        try { ev.preventDefault && ev.preventDefault(); } catch {}
        try { setTimeout(function(){ try{ self.close(); }catch{} }, 0); } catch {}
      }
    } catch {}
  });
  self.addEventListener('unhandledrejection', function(ev){
    try {
      const msg = String((ev && ev.reason && (ev.reason.message || ev.reason)) || '');
      wlog('unhandledrejection', msg);
      if (/out of bounds/i.test(msg) || /RuntimeError/i.test(msg)) {
        try { self.postMessage('__bridge_oob__'); } catch {}
        try { ev.preventDefault && ev.preventDefault(); } catch {}
        try { setTimeout(function(){ try{ self.close(); }catch{} }, 0); } catch {}
      }
    } catch {}
  });
} catch {}

// Crash hardening: catch runtime errors like WASM OOB and signal main to respawn
try {
  self.addEventListener('error', function(ev){
    try {
      const msg = String((ev && ev.message) || ev || '');
      wlog('worker error', msg);
      if (/out of bounds/i.test(msg) || /RuntimeError/i.test(msg)) {
        try { self.postMessage('__bridge_oob__'); } catch {}
        try { ev.preventDefault && ev.preventDefault(); } catch {}
        try { setTimeout(function(){ try{ self.close(); }catch{} }, 0); } catch {}
      }
    } catch {}
  });
  self.addEventListener('unhandledrejection', function(ev){
    try {
      const msg = String((ev && ev.reason && (ev.reason.message || ev.reason)) || '');
      wlog('unhandledrejection', msg);
      if (/out of bounds/i.test(msg) || /RuntimeError/i.test(msg)) {
        try { self.postMessage('__bridge_oob__'); } catch {}
        try { ev.preventDefault && ev.preventDefault(); } catch {}
        try { setTimeout(function(){ try{ self.close(); }catch{} }, 0); } catch {}
      }
    } catch {}
  });
} catch {}

// Important: give pthread helper a definite main script URL (string or Blob)
// Using an absolute URL avoids any basePath ambiguity inside nested workers.
let __ver = '';
try { const __u = new URL(self.location && self.location.href || ''); __ver = __u.search || ''; } catch {}
try {
  // Use absolute to be robust against base URL quirks
  self.Module.mainScriptUrlOrBlob = '/engine/stockfish.js' + __ver;
} catch {
  self.Module.mainScriptUrlOrBlob = '/engine/stockfish.js' + __ver;
}
try {
  // Hint the exact wasm path; Emscripten will respect this when resolving the core module
  self.Module.wasmBinaryFile = '/engine/stockfish.wasm' + __ver;
} catch {}

// Provide abort hook for clearer diagnostics
try {
  self.Module.onAbort = function(reason){
    try { wlog('onAbort', String(reason)); } catch {}
    try { self.postMessage('stockfish worker abort: ' + String(reason)); } catch {}
    try { self.postMessage('__bridge_abort__'); } catch {}
  };
} catch {}

// Ensure both the wasm and the pthread helper resolve in this folder.
// Return absolute URLs so fetch/Worker/importScripts don't depend on base.
function __normalizeEngineAssetName(base){
  try{
    let name = String(base||'');
    name = name.split('?')[0].split('#')[0];
    name = name.split('/').pop();
    // Map hashed SF 17.x names to our shipped filenames
    // e.g. stockfish-17.1-XXXX-part-3.wasm -> stockfish-part-3.wasm
    //      stockfish-17.1-XXXX.wasm        -> stockfish.wasm
    //      stockfish-17.1-XXXX.worker.js   -> stockfish.worker.js
    const mPart = /^stockfish(?:-[^-]+)*-part-(\d+)\.wasm$/i.exec(name);
    if (mPart) return `stockfish-part-${mPart[1]}.wasm`;
    if (/^stockfish(?:-[^.]+)*\.wasm$/i.test(name)) return 'stockfish.wasm';
    if (/^stockfish(?:-[^.]+)*\.worker\.js$/i.test(name)) return 'stockfish.worker.js';
    return name;
  }catch{ return base; }
}
self.Module.locateFile = function(requestedPath /*, prefix */) {
  try {
    const raw = String(requestedPath);
    const name = __normalizeEngineAssetName(raw);
    const r = '/engine/' + name + __ver;
    wlog('locateFile', requestedPath, '->', r);
    return r;
  } catch {
    const r = '/engine/' + requestedPath + __ver;
    wlog('locateFile-catch', requestedPath, '->', r);
    return r;
  }
};

// Intercept fetch and XHR to normalize any engine asset lookups that bypass locateFile
try {
  const __origFetch = self.fetch ? self.fetch.bind(self) : null;
  if (__origFetch) {
    self.fetch = function(input, init){
      try{
        const url = (typeof input === 'string') ? input : (input && input.url) ? input.url : String(input);
        const name = __normalizeEngineAssetName(url);
        if (/^stockfish/i.test(name)){
          const newUrl = '/engine/' + name + __ver;
          wlog('fetch', url, '->', newUrl);
          return __origFetch(newUrl, init);
        }
        return __origFetch(input, init);
      }catch(e){ return __origFetch(input, init); }
    }
  }
}catch{}

try {
  const OldXHR = self.XMLHttpRequest;
  if (OldXHR) {
    self.XMLHttpRequest = function(){
      const xhr = new OldXHR();
      const oldOpen = xhr.open;
      xhr.open = function(method, url){
        try{
          const name = __normalizeEngineAssetName(url);
          if (/^stockfish/i.test(name)){
            const newUrl = '/engine/' + name + __ver;
            wlog('xhr.open', url, '->', newUrl);
            return oldOpen.apply(xhr, [method, newUrl].concat([].slice.call(arguments, 2)));
          }
        }catch{}
        return oldOpen.apply(xhr, arguments);
      };
      return xhr;
    };
  }
}catch{}

// Forward engine stdout/stderr to the main thread (used for UCI lines)
self.Module.print = function(text) { try { self.postMessage(String(text)); } catch {} };
self.Module.printErr = function(text) { try { self.postMessage(String(text)); } catch {} };

let engine = null;
const queue = [];
let __pendingReadyTimer = null;
function __armReadyokWatch(){ try { if(__pendingReadyTimer) clearTimeout(__pendingReadyTimer); __pendingReadyTimer = setTimeout(()=>{ try{ wlog('readyok timeout; re-posting isready'); engine && engine.postMessage && engine.postMessage('isready'); }catch(e){ wlog('retry isready failed', e&&e.message?e.message:String(e)); } }, 800); }catch{} }
function __clearReadyokWatch(){ try{ if(__pendingReadyTimer){ clearTimeout(__pendingReadyTimer); __pendingReadyTimer=null; wlog('readyok observed'); } }catch{} }
// Capture messages that may arrive before the engine and handler are ready
self.onmessage = function(e) {
  try {
    const msg = e && e.data != null ? e.data : e;
    // If engine is not initialized yet, buffer the message
    if (__WDEBUG) wlog('<- main', JSON.stringify(msg));
    if (!engine) { queue.push(msg); wlog('queueing (engine not ready). size=', queue.length); return; }
    try {
      engine.postMessage(msg);
      if (__WDEBUG) wlog('-> engine', JSON.stringify(msg));
      if (String(msg).trim() === 'isready') __armReadyokWatch();
    } catch (e2) {
      wlog('engine.postMessage failed', (e2 && e2.message ? e2.message : String(e2)));
      // Re-enqueue and retry shortly
      try{
        queue.push(msg);
        setTimeout(()=>{ try{ const q = queue.shift(); engine && engine.postMessage && engine.postMessage(q); wlog('retry -> engine', JSON.stringify(q)); if(String(q).trim()==='isready') __armReadyokWatch(); }catch(ex){ wlog('retry failed', ex&&ex.message?ex.message:String(ex)); } }, 50);
      }catch{}
    }
  } catch {}
};

// Load the Emscripten factory and create the engine instance
try {
  wlog('importScripts /engine/stockfish.js'+__ver);
  importScripts('/engine/stockfish.js'+__ver);
  if (typeof Stockfish === 'function') {
    const attach = (inst) => {
      engine = inst;
      try { wlog('engine created'); } catch {}

      // Hook outputs: prefer message listener; also set print hooks as fallback
      try {
        if (engine && typeof engine.addMessageListener === 'function') {
          engine.addMessageListener(function(line){ try { __WDEBUG && wlog('engine->', String(line).slice(0,500)); self.postMessage(String(line)); } catch {} });
          try { wlog('addMessageListener installed'); } catch {}
        } else {
          try { wlog('addMessageListener not available'); } catch {}
        }
        if (engine) {
          engine.print = function(t){ try { self.postMessage(String(t)); } catch {} };
          engine.printErr = function(t){ try { self.postMessage(String(t)); } catch {} };
          try { wlog('print hooks set'); } catch {}
        }
      } catch (hookErr) {
        try { wlog('hook error:', (hookErr && hookErr.message ? hookErr.message : String(hookErr))); } catch {}
      }

      // Bridge engine -> main
      if (engine) {
        engine.onmessage = function(e) {
          try {
            const msg = e && e.data != null ? e.data : e;
            try { __WDEBUG && wlog('engine.onmessage ->', String(msg).slice(0,500)); } catch {}
            self.postMessage(msg);
            try { if(String(msg).trim()==='readyok') __clearReadyokWatch(); }catch{}
          } catch {}
        };
      }

      // Bridge main -> engine (flush any queued messages buffered before init)
      self.onmessage = function(e) {
        try {
          const msg = e && e.data != null ? e.data : e;
          if (__WDEBUG) wlog('<- main (bridge active)', JSON.stringify(msg));
          try {
            engine && engine.postMessage && engine.postMessage(msg);
            if (__WDEBUG) wlog('-> engine (bridge active)', JSON.stringify(msg));
            if (String(msg).trim() === 'isready') __armReadyokWatch();
          } catch (ex) {
            wlog('engine.postMessage (bridge active) failed', (ex && ex.message ? ex.message : String(ex)));
            try{
              // Retry once after a short delay
              setTimeout(()=>{ try{ engine && engine.postMessage && engine.postMessage(msg); wlog('retry -> engine (bridge active)', JSON.stringify(msg)); if (String(msg).trim()==='isready') __armReadyokWatch(); }catch(ex2){ wlog('retry failed (bridge active)', ex2 && ex2.message ? ex2.message : String(ex2)); } }, 50);
            }catch{}
          }
        } catch {}
      };

      // Flush queued messages and send UCI
      try { wlog('flush', String(queue.length), 'queued'); } catch {}
      while (queue.length) { try { const q = queue.shift(); engine.postMessage(q); __WDEBUG && wlog('flushed -> engine', JSON.stringify(q)); } catch {} }
      try { engine.postMessage('uci'); wlog('sent uci'); } catch (e) { try { wlog('post uci error:', (e && e.message ? e.message : String(e))); } catch {} }
    };

    try {
      const maybe = Stockfish(Module);
      if (maybe && typeof maybe.then === 'function') {
        // Promise resolves to engine instance
        maybe.then((inst)=>{ try { wlog('module ready (promise)'); } catch {} ; attach(inst); });
      } else if (maybe && maybe.ready && typeof maybe.ready.then === 'function') {
        maybe.ready.then(()=>{ try { wlog('module ready (ready.then)'); } catch {} ; attach(maybe); });
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
