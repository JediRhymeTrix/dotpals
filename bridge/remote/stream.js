// A drop-in replacement for EventSource that only holds a connection open while the app is in use.
//   visible        → connected (real time)
//   hidden 15 s    → the connection is closed: no radio, no server work, no battery. Web Push covers you.
//   visible again  → reconnects at once and asks only for what it missed (`since=<last id>`)
// The dashboard's own code is untouched: it still does `new EventSource('/events')`. Runs in <head>
// before it, as a classic script. It announces its state to the page ('dotpals:stream').
(() => {
  const Native = window.EventSource;
  if (!Native || window.__dotpalsStream) return;
  window.__dotpalsStream = true;
  const GRACE = 15_000;
  const state = { value: 'connecting', since: 0, lastId: '' };
  const announce = (value, extra = {}) => { state.value = value; window.dispatchEvent(new CustomEvent('dotpals:stream', { detail: { state: value, ...extra } })); };
  window.dotpalsStream = { state: () => state.value, lastId: () => state.lastId };

  class Foreground {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    #url; #native = null; #timer = null; #closed = false; #listeners = new Map(); #bound = new Set(); #retry = null; #fails = 0;
    onopen = null; onerror = null; onmessage = null;
    readyState = 0;
    constructor(url) {
      this.#url = String(url);
      this.url = this.#url;
      this.withCredentials = true;
      document.addEventListener('visibilitychange', this.#visibility);
      addEventListener('online', this.#wake);
      addEventListener('pageshow', this.#wake);
      if (document.visibilityState === 'visible') this.#connect(); else { this.readyState = 0; announce('paused'); }
    }
    addEventListener(name, fn) {
      if (typeof fn !== 'function') return;
      if (!this.#listeners.has(name)) this.#listeners.set(name, new Set());
      this.#listeners.get(name).add(fn);
      this.#bind(name);
    }
    removeEventListener(name, fn) { this.#listeners.get(name)?.delete(fn); }
    dispatchEvent() { return true; }
    close() {
      this.#closed = true;
      this.readyState = 2;
      clearTimeout(this.#timer);
      clearTimeout(this.#retry);
      document.removeEventListener('visibilitychange', this.#visibility);
      removeEventListener('online', this.#wake);
      removeEventListener('pageshow', this.#wake);
      this.#drop();
    }
    #drop() { if (this.#native) { this.#native.close(); this.#native = null; this.#bound.clear(); } }
    #bind(name) {
      if (!this.#native || this.#bound.has(name)) return;
      this.#bound.add(name);
      this.#native.addEventListener(name, (e) => this.#deliver(name, e));
    }
    #deliver(name, e) {
      if (e.lastEventId) state.lastId = e.lastEventId;
      if (name === 'message' && typeof this.onmessage === 'function') this.onmessage(e);
      for (const fn of [...(this.#listeners.get(name) ?? [])]) { try { fn.call(this, e); } catch (err) { console.error(err); } }
    }
    #connect() {
      if (this.#closed || this.#native) return;
      announce('connecting');
      const url = state.lastId ? `${this.#url}${this.#url.includes('?') ? '&' : '?'}since=${encodeURIComponent(state.lastId)}` : this.#url;
      this.readyState = 0;
      const es = new Native(url, { withCredentials: true });
      this.#native = es;
      es.onopen = (e) => {
        this.readyState = 1;
        this.#fails = 0;
        announce('live');
        if (typeof this.onopen === 'function') this.onopen(e);
        for (const fn of [...(this.#listeners.get('open') ?? [])]) fn.call(this, e);
      };
      es.onerror = (e) => {
        this.readyState = es.readyState === 2 ? 2 : 0;
        if (es.readyState === 2) {
          // The browser gave up (the server said no: signed out, or it's down). Retry quietly with a back-off.
          this.#drop();
          announce(++this.#fails > 3 ? 'closed' : 'offline', { status: 'refused' });
          if (!this.#closed && document.visibilityState === 'visible') this.#retry = setTimeout(() => this.#connect(), Math.min(30_000, 1000 * 2 ** this.#fails));
        } else announce('offline');
        if (typeof this.onerror === 'function') this.onerror(e);
      };
      this.#bound.clear();
      for (const name of this.#listeners.keys()) this.#bind(name);
      this.#bind('message');
    }
    #visibility = () => {
      if (this.#closed) return;
      if (document.visibilityState === 'visible') { clearTimeout(this.#timer); this.#timer = null; this.#connect(); }
      else if (!this.#timer) this.#timer = setTimeout(() => { this.#timer = null; this.#drop(); this.readyState = 0; announce('paused'); }, GRACE);
    };
    #wake = () => { if (!this.#closed && document.visibilityState === 'visible' && !this.#native) { clearTimeout(this.#retry); this.#connect(); } };
  }
  window.EventSource = Foreground;
})();
