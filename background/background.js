<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CookieGate</title>
  <style>
    :root {
      --bg: rgba(10, 14, 24, 0.82);
      --panel: rgba(255, 255, 255, 0.08);
      --panel-strong: rgba(255, 255, 255, 0.12);
      --border: rgba(255, 255, 255, 0.14);
      --text: rgba(255, 255, 255, 0.96);
      --muted: rgba(255, 255, 255, 0.65);
      --accent: rgba(99, 102, 241, 0.95);
      --accent-soft: rgba(99, 102, 241, 0.18);
      --success: rgba(34, 197, 94, 0.95);
      --warning: rgba(245, 158, 11, 0.95);
      --danger: rgba(239, 68, 68, 0.95);
      --shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
      --radius-xl: 20px;
      --radius-lg: 16px;
      --radius-md: 12px;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 620px;
      min-height: 720px;
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(99, 102, 241, 0.18), transparent 35%),
        radial-gradient(circle at top right, rgba(56, 189, 248, 0.14), transparent 30%),
        linear-gradient(180deg, rgba(10, 14, 24, 0.96), rgba(15, 23, 42, 0.96));
    }

    body {
      padding: 16px;
    }

    .shell {
      background: var(--bg);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid var(--border);
      border-radius: 24px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .header {
      padding: 18px 18px 14px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
    }

    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .title {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.10);
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--success);
      box-shadow: 0 0 14px rgba(34, 197, 94, 0.9);
    }

    .site-block {
      display: grid;
      gap: 6px;
    }

    .site-line {
      font-size: 12px;
      color: var(--muted);
      word-break: break-word;
    }

    .meta-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255,255,255,0.03);
    }

    .meta-card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: var(--radius-md);
      padding: 10px;
    }

    .meta-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .meta-value {
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      word-break: break-word;
    }

    .controls {
      display: grid;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }

    .button-row,
    .mode-row {
      display: grid;
      gap: 10px;
    }

    .button-row {
      grid-template-columns: 1fr 1fr;
    }

    .mode-row {
      grid-template-columns: 1fr 1fr;
    }

    .control-group {
      display: grid;
      gap: 6px;
    }

    .control-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }

    button,
    select {
      width: 100%;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 14px;
      background: rgba(255,255,255,0.08);
      color: var(--text);
      padding: 11px 12px;
      font-size: 13px;
      font-weight: 600;
      outline: none;
      transition: 140ms ease;
    }

    button:hover,
    select:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.16);
    }

    button.primary {
      background: linear-gradient(180deg, rgba(99,102,241,0.92), rgba(79,70,229,0.9));
      border-color: rgba(129,140,248,0.45);
      box-shadow: 0 8px 24px rgba(79, 70, 229, 0.28);
    }

    button.primary:hover {
      filter: brightness(1.04);
    }

    button.danger {
      background: linear-gradient(180deg, rgba(239,68,68,0.92), rgba(220,38,38,0.9));
      border-color: rgba(248, 113, 113, 0.38);
      box-shadow: 0 8px 24px rgba(220, 38, 38, 0.24);
    }

    .section {
      padding: 16px 18px 18px 18px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .section-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .section-count {
      font-size: 12px;
      color: var(--muted);
    }

    .stack {
      display: grid;
      gap: 10px;
      max-height: 290px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .cookie-card,
    .evidence-card {
      border-radius: var(--radius-lg);
      border: 1px solid rgba(255,255,255,0.10);
      background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04));
      padding: 12px;
    }

    .cookie-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .cookie-name {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.25;
      word-break: break-word;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    .badge-class-auth { background: rgba(34,197,94,0.16); border-color: rgba(34,197,94,0.28); }
    .badge-class-pref { background: rgba(59,130,246,0.16); border-color: rgba(59,130,246,0.28); }
    .badge-class-track { background: rgba(245,158,11,0.16); border-color: rgba(245,158,11,0.28); }
    .badge-class-unknown { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.16); }

    .badge-policy-delete { background: rgba(239,68,68,0.16); border-color: rgba(239,68,68,0.28); }
    .badge-policy-allow { background: rgba(34,197,94,0.16); border-color: rgba(34,197,94,0.28); }
    .badge-policy-review { background: rgba(168,85,247,0.16); border-color: rgba(168,85,247,0.28); }
    .badge-policy-keep { background: rgba(56,189,248,0.16); border-color: rgba(56,189,248,0.28); }

    .cookie-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 12px;
      margin-bottom: 10px;
    }

    .field {
      min-width: 0;
    }

    .field-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 3px;
    }

    .field-value {
      font-size: 12px;
      color: var(--text);
      word-break: break-word;
    }

    .cookie-action-row {
      display: flex;
      justify-content: flex-end;
      margin-top: 6px;
    }

    .cookie-action-row button {
      width: auto;
      padding: 9px 12px;
      border-radius: 12px;
      font-size: 12px;
    }

    .evidence-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
      word-break: break-word;
    }

    .evidence-payload {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      line-height: 1.45;
      color: rgba(255,255,255,0.82);
      background: rgba(0,0,0,0.18);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 8px;
      margin-top: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty {
      color: var(--muted);
      font-style: italic;
      padding: 6px 2px;
    }

    .error {
      color: #fecaca;
      font-weight: 700;
      background: rgba(239,68,68,0.14);
      border: 1px solid rgba(239,68,68,0.26);
      border-radius: 12px;
      padding: 10px 12px;
    }

    ::-webkit-scrollbar {
      width: 10px;
    }

    ::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.14);
      border-radius: 999px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }
  html {
  color-scheme: dark;
}

select {
  width: 100%;
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 14px;
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.96);
  padding: 11px 12px;
  font-size: 13px;
  font-weight: 600;
  outline: none;
  transition: 140ms ease;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}

select:hover {
  background: rgba(255,255,255,0.12);
  border-color: rgba(255,255,255,0.16);
}

select:focus {
  border-color: rgba(129,140,248,0.45);
  box-shadow: 0 0 0 3px rgba(99,102,241,0.18);
}

select option {
  background: #111827;
  color: #f8fafc;
}

select option:checked {
  background: #4f46e5;
  color: #ffffff;
}
</style>
</head>
<body>
  <div class="shell">
    <div class="header">
      <div class="title-row">
        <h2 class="title">CookieGate</h2>
        <div class="status-pill" id="statusPill">
          <span class="status-dot"></span>
          <span id="status">READY</span>
        </div>
      </div>
      <div class="site-block">
        <div class="site-line" id="site">Site: -</div>
      </div>
    </div>

    <div class="meta-bar">
      <div class="meta-card">
        <div class="meta-label">Global</div>
        <div class="meta-value" id="metaGlobal">-</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Site</div>
        <div class="meta-value" id="metaSite">-</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Effective</div>
        <div class="meta-value" id="metaEffective">-</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Tracked Tabs</div>
        <div class="meta-value" id="metaTrackedTabs">-</div>
      </div>
    </div>

    <div class="controls">
      <div class="button-row">
        <button id="inspect" class="primary">Inspect Cookies</button>
        <button id="wipeNow" class="danger">Wipe Site Now</button>
      </div>

      <div class="mode-row">
        <div class="control-group">
          <label class="control-label" for="globalMode">Global Mode</label>
          <select id="globalMode">
            <option value="strict">strict</option>
            <option value="balanced">balanced</option>
            <option value="trusted">trusted</option>
          </select>
        </div>

        <div class="control-group">
          <label class="control-label" for="siteMode">Site Mode</label>
          <select id="siteMode">
            <option value="">inherit-global</option>
            <option value="strict">strict</option>
            <option value="balanced">balanced</option>
            <option value="trusted">trusted</option>
          </select>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">Cookies</div>
        <div class="section-count" id="cookieCount">0 detected</div>
      </div>
      <div id="results" class="stack">
        <div class="empty">No inspection run yet.</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">Evidence</div>
        <div class="section-count" id="evidenceCount">0 events</div>
      </div>
      <div id="evidence" class="stack">
        <div class="empty">No evidence loaded yet.</div>
      </div>
    </div>
  </div>

  <script src="popup.js"></script>
</body>
</html>
