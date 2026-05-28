// COOKIEGATE CORE ENGINE (BOOTSTRAP v1)

export class CookieGateEngine {
  constructor(adapter) {
    this.adapter = adapter;
    this.evidence = [];
  }

  async inspect(site) {
    // GOVERNOR GATE (prevents runaway inspect loops)
    if (typeof cg_guarded_inspect === "function") {
      return cg_guarded_inspect(site, async () => {
        const cookies = await this.adapter.getCookies(site);

        return {
          site,
          count: cookies.length,
          cookies,
          mode: this.adapter.getMode(site)
        };
      });
    }

    const cookies = await this.adapter.getCookies(site);

    return {
      site,
      count: cookies.length,
      cookies,
      mode: this.adapter.getMode(site)
    };
  }

  async wipe(site) {
    const result = await this.adapter.wipeCookies(site);

    return {
      site,
      deleted: result.deleted,
      failed: result.failed
    };
  }

  setGlobalMode(mode) {
    this.adapter.setGlobalMode(mode);
  }

  setSiteMode(site, mode) {
    this.adapter.setSiteMode(site, mode);
  }

  getEvidence() {
    return this.evidence;
  }
}


// ==============================
// COOKIEGATE DELTA EVIDENCE SYSTEM v1
// ==============================

const _CG_DELTA_EVIDENCE = {
  lastStateBySite: new Map()
};

function _cg_hash_state(cookies) {
  let h = 0;
  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i];
    const str = c.name + "|" + c.domain + "|" + c.path + "|" + c.value;
    for (let j = 0; j < str.length; j++) {
      h = (h << 5) - h + str.charCodeAt(j);
      h |= 0;
    }
  }
  return h;
}

function appendInspectEvidenceIfChanged(site, payload) {
  const currentHash = _cg_hash_state(payload.cookies || []);
  const previousHash = _CG_DELTA_EVIDENCE.lastStateBySite.get(site);

  // NO CHANGE → DO NOTHING (CRITICAL FOR RAM FIX)
  if (previousHash === currentHash) {
    return;
  }

  // UPDATE STATE
  _CG_DELTA_EVIDENCE.lastStateBySite.set(site, currentHash);

  // EMIT DELTA ONLY
  return appendEvidence("cookiegate.cookie.inspect.delta.v1", {
    site,
    count: payload.count,
    delta: true,
    cookies: payload.cookies
  });
}

function appendWipeEvidenceDelta(site, result) {
  return appendEvidence("cookiegate.cookie.wipe.delta.v1", {
    site,
    deleted: result.deleted,
    failed: result.failed,
    delta: true
  });
}


// ==============================
// COOKIEGATE UNIFIED EVIDENCE BUS v1
// ==============================

class CookieGateEvidenceBus {
  static queue = [];
  static flushIntervalMs = 2000;
  static lastFlush = Date.now();

  static emit(eventType, payload) {
    const event = {
      type: eventType,
      ts: Date.now(),
      payload
    };

    this.queue.push(event);

    // batch flush (prevents RAM spikes)
    if (this.queue.length >= 25 || (Date.now() - this.lastFlush) > this.flushIntervalMs) {
      this.flush();
    }

    return event;
  }

  static flush() {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    this.lastFlush = Date.now();

    // SINGLE OUTPUT PATH (CRITICAL UNIFICATION)
    if (typeof appendEvidence === "function") {
      appendEvidence("cookiegate.evidence.batch.v1", {
        count: batch.length,
        events: batch
      });
    }
  }
}

// ==============================
// ADAPTER FUNCTIONS (LEGACY COMPAT)
// ==============================

function appendInspectEvidenceIfChanged(site, payload) {
  return CookieGateEvidenceBus.emit(
    "cookiegate.cookie.inspect.delta.v1",
    { site, ...payload, delta: true }
  );
}

function appendWipeEvidenceDelta(site, result) {
  return CookieGateEvidenceBus.emit(
    "cookiegate.cookie.wipe.delta.v1",
    { site, ...result, delta: true }
  );
}

function appendPolicyEvent(type, payload) {
  return CookieGateEvidenceBus.emit(type, payload);
}


// ==============================
// COOKIEGATE EVENT COALESCING v1
// ==============================

const _CG_EVENT_COALESCE = {
  buffer: new Map(),
  flushMs: 1500,
  lastFlush: Date.now()
};

function _cg_coalesce_emit(key, eventFactory) {
  const now = Date.now();

  // overwrite previous event instead of stacking
  _CG_EVENT_COALESCE.buffer.set(key, eventFactory());

  if ((now - _CG_EVENT_COALESCE.lastFlush) > _CG_EVENT_COALESCE.flushMs) {
    _cg_flush_coalesced();
  }
}

function _cg_flush_coalesced() {
  if (_CG_EVENT_COALESCE.buffer.size === 0) return;

  const events = Array.from(_CG_EVENT_COALESCE.buffer.values());
  _CG_EVENT_COALESCE.buffer.clear();
  _CG_EVENT_COALESCE.lastFlush = Date.now();

  if (typeof CookieGateEvidenceBus !== "undefined") {
    CookieGateEvidenceBus.emit("cookiegate.coalesced.batch.v1", {
      count: events.length,
      events
    });
  }
}

// OPTIONAL OVERRIDE HOOKS (IMPORTANT)

function appendInspectEvidenceIfChanged(site, payload) {
  return _cg_coalesce_emit(
    "inspect:" + site,
    () => ({
      type: "cookiegate.cookie.inspect.delta.v1",
      site,
      ...payload
    })
  );
}

function appendWipeEvidenceDelta(site, result) {
  return _cg_coalesce_emit(
    "wipe:" + site,
    () => ({
      type: "cookiegate.cookie.wipe.delta.v1",
      site,
      ...result
    })
  );
}


// ==============================
// COOKIEGATE SESSION MODEL v1
// ==============================

const _CG_SESSION_MODEL_V1 = {
  sessions: new Map(),
  modeStore: new Map(),
  sessionTTL: 5 * 60 * 1000
};

function _cg_get_session(site) {
  const now = Date.now();

  let s = _CG_SESSION_MODEL_V1.sessions.get(site);

  if (!s || (now - s.lastSeen) > _CG_SESSION_MODEL_V1.sessionTTL) {
    s = {
      id: crypto.randomUUID(),
      start: now,
      lastSeen: now,
      events: []
    };
  }

  s.lastSeen = now;
  _CG_SESSION_MODEL_V1.sessions.set(site, s);

  return s;
}

// ------------------------------
// MODE PERSISTENCE (CRITICAL FIX)
// ------------------------------

function _cg_get_mode(site) {
  return _CG_SESSION_MODEL_V1.modeStore.get(site) || "balanced";
}

function _cg_set_mode(site, mode) {
  _CG_SESSION_MODEL_V1.modeStore.set(site, {
    mode,
    locked: true,
    updated: Date.now()
  });
}

// ------------------------------
// COOKIE CLASSIFICATION ENGINE
// ------------------------------

function _cg_classify_cookie(c) {
  const name = (c.name || "").toLowerCase();

  if (name.includes("sess") || name.includes("session")) return "auth/session";
  if (name.includes("track") || name.includes("ad")) return "ads/tracking";
  if (name.includes("analytics") || name.includes("amcv")) return "tracking/analytics";
  if (name.includes("csrf")) return "security/csrf";

  return "unknown";
}

function _cg_score_cookie(c) {
  const type = _cg_classify_cookie(c);

  switch(type) {
    case "auth/session": return 10;
    case "ads/tracking": return 8;
    case "tracking/analytics": return 6;
    case "security/csrf": return 2;
    default: return 4;
  }
}

// ------------------------------
// ENHANCED INSPECT WITH SESSION
// ------------------------------

const _original_inspect = CookieGateEngine.prototype.inspect;

CookieGateEngine.prototype.inspect = async function(site) {

  const session = _cg_get_session(site);
  const cookies = await this.adapter.getCookies(site);

  const classified = cookies.map(c => ({
    ...c,
    category: _cg_classify_cookie(c),
    riskScore: _cg_score_cookie(c)
  }));

  const result = {
    site,
    sessionId: session.id,
    sessionAge: Date.now() - session.start,
    mode: _cg_get_mode(site),
    count: cookies.length,
    cookies: classified
  };

  session.events.push({
    type: "inspect",
    count: cookies.length,
    time: Date.now()
  });

  return result;
};

// ------------------------------
// MODE PERSISTENCE HOOKS
// ------------------------------

CookieGateEngine.prototype.setSiteMode = function(site, mode) {
  _cg_set_mode(site, mode);
};

function _cg_append_delta_evidence(event){
    window.CookieGateEvidenceBus?.publish({events:[event], count:1});
}class CookieGateBrowserObserver {
    constructor() { this.cookies = []; this.domains = new Map(); }
    scan() {
        // pseudo-code: collect all cookies across domains
        const c = document.cookie.split(';');
        for(const x of c){ this.cookies.push(x.trim()); }
    }
    getSummary() {
        return { total:this.cookies.length, domains:this.domains.size };
    }
}
window.CookieGateBrowserObserver = new CookieGateBrowserObserver();
