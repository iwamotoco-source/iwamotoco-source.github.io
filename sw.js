/* ============================================================================
 *  Venice Shell — GitHub Pages 版 Service Worker プロキシ  (rev.2)
 * ============================================================================
 *  rev.2 の変更点:
 *   ・navigation に opaque を返さない（iOS WebKit が拒否するため）
 *   ・CORS の取り方を多段化（include → omit → 公開CORSプロキシ）
 *   ・全滅時は読める診断HTMLを返す（真っ黒なエラー画面にしない）
 * ========================================================================== */

const UPSTREAM = 'https://venice.ai';

// 保険のCORSプロキシ。venice.ai が ACAO を返さないパス用。
// 別のものに変えたい場合はここを差し替える。
const PROXY = 'https://corsproxy.io/?url=';

const OWN = ['/sw.js', '/index.html'];
const BYPASS = [];            // 同居する他リポジトリ: ['/other-site']
const MARK = 'data-vs-shell';

// 上流への取り方。前から順に試し、成功した方式を次回の先頭に固定する。
const STRATEGIES = [
  { proxy: false, credentials: 'include' },
  { proxy: false, credentials: 'omit' },
  { proxy: true,  credentials: 'omit' },
];
let startAt = 0;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (OWN.indexOf(url.pathname) >= 0) return;
  if (BYPASS.some(function (p) {
        return url.pathname === p || url.pathname.indexOf(p + '/') === 0;
      })) return;

  if (url.pathname === '/manifest.webmanifest') {
    e.respondWith(staticRes(MANIFEST, 'application/manifest+json')); return;
  }
  if (url.pathname === '/icon.svg') {
    e.respondWith(staticRes(ICON, 'image/svg+xml')); return;
  }

  e.respondWith(proxy(req, url));
});

/* -------------------------------------------------------------------------- */

async function fetchUpstream(target, init) {
  let last = null;
  for (let n = 0; n < STRATEGIES.length; n++) {
    const i = (startAt + n) % STRATEGIES.length;
    const s = STRATEGIES[i];
    const cfg = {
      method: init.method,
      headers: init.headers,
      redirect: 'follow',
      mode: 'cors',
      credentials: s.credentials,
    };
    if (init.body) cfg.body = init.body;

    const url = s.proxy ? PROXY + encodeURIComponent(target) : target;
    try {
      const res = await fetch(url, cfg);
      if (res && res.status !== 0) { startAt = i; return res; }
    } catch (err) { last = err; }
  }
  return { __fail: true, err: last };
}

async function proxy(req, url) {
  const target = UPSTREAM + url.pathname + url.search;

  const headers = new Headers(req.headers);
  ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
   'accept-encoding', 'cookie', 'origin', 'referer',
   'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
   'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto'
  ].forEach(function (k) { headers.delete(k); });

  const init = { method: req.method, headers: headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { init.body = await req.arrayBuffer(); } catch (e) {}
  }

  const res = await fetchUpstream(target, init);
  if (res.__fail) return diagPage(target, res.err);

  const out = new Headers(res.headers);
  out.delete('content-length');
  out.delete('content-encoding');   // ブラウザの fetch は展開済み
  out.delete('x-frame-options');

  const csp = out.get('content-security-policy');
  if (csp) {
    const c = csp.replace(/\s*frame-ancestors[^;]*;?/i, '').replace(/^\s*;\s*/, '').trim();
    if (c) out.set('content-security-policy', c); else out.delete('content-security-policy');
  }

  if (typeof out.getSetCookie === 'function') {
    const cs = out.getSetCookie();
    if (cs.length) {
      out.delete('set-cookie');
      for (const c of cs) out.append('set-cookie', c.replace(/;\s*domain=[^;]+/gi, ''));
    }
  }

  if (res.status === 304) return new Response(null, { status: 304, headers: out });

  const ct = out.get('content-type') || '';
  if (ct.indexOf('text/html') >= 0) {
    const html = inject(await res.text());
    return new Response(html, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, headers: out });
}

function inject(html) {
  if (html.indexOf(MARK) >= 0) return html;
  const head = html.match(/<head[^>]*>/i);
  if (head) {
    const i = html.indexOf(head[0]) + head[0].length;
    return html.slice(0, i) + INJECT + html.slice(i);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) {
    const i = html.indexOf(htmlTag[0]) + htmlTag[0].length;
    return html.slice(0, i) + '<head>' + INJECT + '</head>' + html.slice(i);
  }
  return INJECT + html;
}

function staticRes(body, type) {
  return new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
}

// 全方式が失敗したとき用。opaque ではないので navigation でも安全。
function diagPage(target, err) {
  const body = '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Venice Shell</title>'
    + '<style>body{background:#0b0c0e;color:#e8e8ea;font:14px/1.7 system-ui,sans-serif;'
    + 'padding:28px}h1{font-size:16px}code{background:#1a1a1d;padding:2px 6px;border-radius:4px;'
    + 'font-size:12px;word-break:break-all}p{color:#8a8a92}</style>'
    + '<h1>上流に届きませんでした</h1>'
    + '<p>転送先</p><code>' + escapeHtml(target) + '</code>'
    + '<p>最後のエラー</p><code>' + escapeHtml(String(err && err.message || err)) + '</code>'
    + '<p>再読み込みしてみてください。</p>'
    + '<script data-vs-shell>location.href="/index.html";</' + 'script>';
  return new Response(body, {
    status: 502, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/* ========================================================================== */
/*  注入するツールバー（変更なし）                                             */
/* ========================================================================== */

const INJECT = `
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0b0c0e">
<script ${MARK}>
(function () {
  'use strict';
  if (window.__veniceShell) return;
  window.__veniceShell = true;

  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    var _reg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function () { return _reg('/sw.js', { scope: '/' }); };
  }

  var AUTO = false, busy = false;
  var state = { remaining: null, limit: null };
  var badge;

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

  function report(get) {
    var rem = num(get('x-ratelimit-remaining-requests'));
    if (rem == null) rem = num(get('x-ratelimit-remaining'));
    if (rem == null) rem = num(get('x-venice-ratelimit-remaining'));
    if (rem == null) rem = num(get('x-ratelimit-remaining-tokens'));
    if (rem == null) return;
    state.remaining = rem;
    var lim = num(get('x-ratelimit-limit-requests'));
    state.limit = lim == null ? num(get('x-ratelimit-limit')) : lim;
    paint();
    if (AUTO && rem <= 0) nuke();
  }

  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function () {
      var p = _fetch.apply(this, arguments);
      p.then(function (res) {
        try { report(function (k) { return res.headers.get(k); }); } catch (e) {}
      }, function () {});
      return p;
    };
  }

  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var xhr = this;
    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState !== 4) return;
      var map = {};
      (xhr.getAllResponseHeaders() || '').split(/\\r?\\n/).forEach(function (line) {
        var i = line.indexOf(':');
        if (i < 0) return;
        map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      });
      try { report(function (k) { return map[k] || null; }); } catch (e) {}
    });
    return _open.apply(this, arguments);
  };

  async function nuke() {
    if (busy) return;
    busy = true; paint();
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
    try {
      document.cookie.split(';').forEach(function (c) {
        var n = c.split('=')[0].trim();
        if (!n) return;
        document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      });
    } catch (e) {}
    try {
      if (indexedDB.databases) {
        var dbs = await indexedDB.databases();
        dbs.forEach(function (d) { if (d.name) indexedDB.deleteDatabase(d.name); });
      }
    } catch (e) {}
    try {
      if (window.caches) {
        var ks = await caches.keys();
        await Promise.all(ks.map(function (k) { return caches.delete(k); }));
      }
    } catch (e) {}
    state.remaining = null;
    location.replace(location.pathname);
  }

  function paint() {
    if (!badge) return;
    var t = busy ? 'リセット中…'
          : state.remaining == null ? '残量 --'
          : '残量 ' + state.remaining + (state.limit == null ? '' : '/' + state.limit);
    badge.textContent = t + (AUTO ? ' ・自動ON' : '');
    badge.title = 'クリックで自動リセットを' + (AUTO ? 'OFF' : 'ON');
  }

  function mount() {
    if (document.querySelector('[${MARK}]')) return;
    var host = document.createElement('div');
    host.setAttribute('${MARK}', '');
    host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '.bar{display:flex;gap:8px;align-items:center;font:12px/1.4 system-ui,-apple-system,sans-serif}' +
      'button{all:unset;box-sizing:border-box;cursor:pointer;padding:8px 12px;border-radius:999px;' +
      'background:rgba(15,15,17,.86);color:#fff;border:1px solid rgba(255,255,255,.16);' +
      '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);white-space:nowrap}' +
      'button:hover{background:rgba(45,45,50,.95)}' +
      '#badge{font-variant-numeric:tabular-nums;min-width:4.5em;text-align:center}' +
      '</style>' +
      '<div class="bar"><button id="reset">リセット</button><button id="badge"></button></div>';
    badge = root.getElementById('badge');
    root.getElementById('reset').addEventListener('click', nuke);
    badge.addEventListener('click', function () { AUTO = !AUTO; paint(); });
    document.documentElement.appendChild(host);
    paint();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
</script>
`;

/* ========================================================================== */

const MANIFEST = JSON.stringify({
  name: 'Venice Shell',
  short_name: 'Venice',
  start_url: '/chat/agent',
  scope: '/',
  display: 'standalone',
  background_color: '#0b0c0e',
  theme_color: '#0b0c0e',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
});

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
  + '<rect width="512" height="512" rx="112" fill="#0b0c0e"/>'
  + '<path d="M126 148 L256 374 L386 148" fill="none" stroke="#fff" '
  + 'stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/></svg>';
