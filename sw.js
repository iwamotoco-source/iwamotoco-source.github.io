/* Venice Shell SW rev.3 — サブパス対応 + プロキシローテ */
const UPSTREAM = 'https://venice.ai';
const BASE = self.location.pathname.replace(/\/sw\.js\$/, '/');

// ★ 複数プロキシでローテ。これが実質IPローテになる
const PROXIES = [
  'https://corsproxy.io/?url=',
  'https://api.allorigins.win/raw?url=',
  'https://thingproxy.freeboard.io/fetch/',
];
let proxyIdx = 0;
function nextProxy() {
  const p = PROXIES[proxyIdx % PROXIES.length];
  proxyIdx++;
  return p;
}

const MARK = 'data-vs-shell';
const OWN = ['sw.js', 'index.html', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', function (e) {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const rel = url.pathname.slice(BASE.length);
  if (OWN.indexOf(rel) >= 0) return;

  if (rel === 'manifest.webmanifest')
    return e.respondWith(new Response(MANIFEST,
      { headers: { 'content-type': 'application/manifest+json' } }));
  if (rel === 'icon.svg')
    return e.respondWith(new Response(ICON,
      { headers: { 'content-type': 'image/svg+xml' } }));

  e.respondWith(proxy(req, url));
});

async function proxy(req, url) {
  const rel = url.pathname.slice(BASE.length);
  const target = UPSTREAM + '/' + rel + url.search;

  const headers = new Headers(req.headers);
  ['host','connection','keep-alive','transfer-encoding','upgrade',
   'accept-encoding','origin','referer','sec-fetch-site','sec-fetch-mode',
   'sec-fetch-dest','sec-fetch-user','cf-connecting-ip','x-forwarded-for',
   'x-forwarded-proto'].forEach(k => headers.delete(k));

  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await req.arrayBuffer(); } catch (e) {}
  }

  // ① 直接 fetch（クッキー込み）
  let res = await tryFetch(target, { method: req.method, headers, body,
    credentials: 'include', mode: 'cors' });

  // ② 直接 fetch（クッキーなし）
  if (!res) res = await tryFetch(target, { method: req.method, headers, body,
    credentials: 'omit', mode: 'cors' });

  // ③ プロキシ経由（IPローテ）
  if (!res) {
    for (let i = 0; i < PROXIES.length && !res; i++) {
      const p = nextProxy();
      res = await tryFetch(p + encodeURIComponent(target),
        { method: req.method, headers, body, credentials: 'omit', mode: 'cors' });
    }
  }

  if (!res) return diagPage(target);

  const out = new Headers(res.headers);
  out.delete('content-length');
  out.delete('content-encoding');
  out.delete('x-frame-options');
  const csp = out.get('content-security-policy');
  if (csp) {
    const c = csp.replace(/\s*frame-ancestors[^;]*;