/* ============================================================================
 *  Venice Shell — GitHub Pages 版 Service Worker プロキシ
 * ============================================================================
 *  venice.ai を自オリジンに転送し、リセットボタンを注入する。
 *  ・このファイルはオリジンのルート（/<user>.github.io/sw.js）に置くこと。
 *    プロジェクトページ（/repo/）だとスコープが届かず /_next/... が 404 になる。
 *  ・同居する他リポジトリがあれば BYPASS に足す。
 *  ・キャッシュはしない。venice.ai 自身のキャッシュ戦略に任せる。
 * ========================================================================== */

const UPSTREAM = 'https://venice.ai';

// GitHub Pages がそのまま配るファイル（プロキシしない）
const OWN = ['/sw.js', '/index.html'];

// 同じオリジンに同居する他リポジトリ（venice.ai に投げてはいけないもの）
// 例: const BYPASS = ['/my-other-site', '/sandbox'];
const BYPASS = [];

const MARK = 'data-vs-shell';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;            // 別オリジンは素通し
  if (OWN.indexOf(url.pathname) >= 0) return;                // GitHub のファイル
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

async function proxy(req, url) {
  const target = UPSTREAM + url.pathname + url.search;

  const headers = new Headers(req.headers);
  // ブラウザ側で面倒を見てくれる / 上流に渡すと邪魔なもの
  ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
   'accept-encoding', 'cookie', 'origin', 'referer',
   'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
   'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto'
  ].forEach(function (k) { headers.delete(k); });

  const init = {
    method: req.method,
    headers: headers,
    redirect: 'follow',      // ブラウザの fetch は manual で Location が読めないため
    credentials: 'omit',     // venice.ai は ACAO:* を返すので include は使えない
    mode: 'cors',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();

  let res;
  try {
    res = await fetch(target, init);
  } catch (err) {
    // CORS が無いパスへの保険。サブリソースなら opaque でも通る。
    try {
      const opaque = await fetch(target, {
        method: req.method, mode: 'no-cors', redirect: 'follow', credentials: 'omit',
      });
      if (opaque.type === 'opaque') return opaque;
      res = opaque;
    } catch (err2) {
      return new Response('venice shell: ' + err.message, {
        status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }

  const out = new Headers(res.headers);
  out.delete('content-length');
  out.delete('content-encoding');   // ブラウザの fetch は展開済み
  out.delete('x-frame-options');

  // CSP の frame-ancestors だけ外す（将来 iframe で包みたくなったときのため）
  const csp = out.get('content-security-policy');
  if (csp) {
    const c = csp.replace(/\s*frame-ancestors[^;]*;?/i, '').replace(/^\s*;\s*/, '').trim();
    if (c) out.set('content-security-policy', c); else out.delete('content-security-policy');
  }

  // Set-Cookie の Domain を剥がして自オリジンの Cookie として保存させる
  if (typeof out.getSetCookie === 'function') {
    const cs = out.getSetCookie();
    if (cs.length) {
      out.delete('set-cookie');
      for (const c of cs) out.append('set-cookie', c.replace(/;\s*domain=[^;]+/gi, ''));
    }
  }

  // 304 はブラウザのキャッシュに任せる（キャッシュ済みHTMLには注入済み）
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
  return new Response(body, {
    headers: { 'content-type': type, 'cache-control': 'no-cache' },
  });
}

/* ========================================================================== */
/*  注入するツールバー                                                         */
/* ========================================================================== */

const INJECT = `
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0b0c0e">
<script ${MARK}>
(function () {
  'use strict';
  if (window.__veniceShell) return;
  window.__veniceShell = true;

  // --- アプリが別の Service Worker を登録しようとしたら、こちらの登録に寄せる ---
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    var _reg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function () {
      return _reg('/sw.js', { scope: '/' });
    };
  }

  var DEBUG = /[?&]vsdebug=1/.test(location.search);
  var AUTO = false;
  var busy = false;
  var state = { remaining: null, limit: null };
  var badge;

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

  // ---------- クォータの観測（ヘッダ名は venice.ai 次第なので候補を広く拾う） ----------
  function report(get) {
    if (DEBUG) console.log('[vs] response header:', get('__dump__'));
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

  // ---------- リセット ----------
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
    // Service Worker は残す（消すと起動役の index.html に飛ばされるため）
    state.remaining = null;
    location.replace(location.pathname);
  }

  // ---------- ツールバー（Shadow DOM でCSS衝突を回避） ----------
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
      'button:active{transform:translateY(1px)}' +
      '#badge{font-variant-numeric:tabular-nums;min-width:4.5em;text-align:center}' +
      '</style>' +
      '<div class="bar"><button id="reset">リセット</button><button id="badge"></button></div>';
    badge = root.getElementById('badge');
    root.getElementById('reset').addEventListener('click', nuke);
    badge.addEventListener('click', function () { AUTO = !AUTO; paint(); });
    document.documentElement.appendChild(host);
    paint();
  }

  function boot() { mount(); if (DEBUG) console.log('[vs] shell ready'); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
</script>
`;

/* ========================================================================== */
/*  マニフェスト / アイコン                                                    */
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
