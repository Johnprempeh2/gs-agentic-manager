// The build id is stamped into this file at production build time (see
// stampServiceWorkerBuildId in vite.config.ts), so a deploy that changes only
// the app bundle still changes sw.js byte-for-byte. That is what makes the
// browser install a new worker, which — via skipWaiting + controllerchange —
// reloads parked tabs onto the fresh bundle. Left as the literal placeholder in
// dev, where HMR (not the worker) drives refreshes.
const BUILD_ID = "__GSAM_BUILD_ID__";
// Separate this allowlisted cache from older workers that cached arbitrary URLs.
const CACHE_NAME = `paperclip-public-assets-${BUILD_ID}`;
const privateRequests = new Set();
const privateCacheControl = /(?:^|,)\s*(?:no-store|private)(?:\s*(?:,|=)|\s*$)/i;

// Static recovery only: never cache or embed authenticated page content here.
function offlineNavigationResponse() {
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light"><meta name="theme-color" content="#121212">
<title>GS Agentic Manager is offline</title>
<style>
:root{--bg:#121212;--card:#1a1d1b;--line:rgba(255,255,255,.08);--text:#f5f5f5;--muted:#b4b9b2;--accent:#c8ff00;--ink:#0e1611;--mark:#c8ff00}
@media (prefers-color-scheme:light){:root{--bg:#f7f8f4;--card:#fff;--line:rgba(0,0,0,.08);--text:#141413;--muted:#4a5149;--accent:#1b5039;--ink:#fff;--mark:#1b5039}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}
body{font:16px/1.55 Montserrat,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;padding:max(24px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom))}
main{width:100%;max-width:420px;text-align:center;display:grid;justify-items:center;gap:14px}
.mark{width:72px;height:72px;border-radius:50%;background:var(--card);border:1px solid var(--line);display:grid;place-items:center}
.mark svg{height:40px;width:auto;color:var(--mark)}
h1{margin:6px 0 0;font-size:22px;font-weight:800;letter-spacing:-.2px}
p{margin:0;color:var(--muted)}
.status{font-size:14px;font-variant-numeric:tabular-nums}
button{margin-top:6px;border:0;border-radius:999px;padding:12px 22px;min-height:44px;font-weight:600;font-size:15px;line-height:1;font-family:inherit;background:var(--accent);color:var(--ink);cursor:pointer}
button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media (prefers-reduced-motion:no-preference){.mark{animation:breathe 2.4s ease-in-out infinite}@keyframes breathe{50%{transform:scale(.96);opacity:.85}}}
</style></head>
<body><main>
<div class="mark" aria-hidden="true"><svg viewBox="-8 -8 300 436" fill="currentColor"><polygon points="209,295 223,298 253,333 252,337 225,374 217,392 204,398 201,388 144,420 132,419 86,399 73,406 22,355 112,300"/><polygon points="262,216 265,216 265,223 259,317 223,277 123,281 26,338 0,249"/><polygon points="30,149 218,208 10,235 13,174 24,153"/><polygon points="98,69 116,71 155,114 264,116 284,179 202,189 40,137 36,127 42,116 85,77"/><polygon points="179,0 189,0 246,28 265,92 154,91 143,84 106,41 121,26"/></svg></div>
<h1>GS Agentic Manager is offline</h1>
<p id="why">The Mac that runs it is not answering. It may be asleep, restarting, or off Tailscale.</p>
<p class="status" id="status" role="status" aria-live="polite">Trying again shortly.</p>
<button type="button" id="retry">Reload page</button>
</main>
<script>
(function(){
  var why=document.getElementById("why"),status=document.getElementById("status"),wait=5;
  function explain(){why.textContent=navigator.onLine?"The Mac that runs it is not answering. It may be asleep, restarting, or off Tailscale.":"This device is offline. Reconnect and the page comes back by itself.";}
  function check(){fetch("/api/health",{cache:"no-store"}).then(function(r){if(r.ok){status.textContent="Back online. Reloading.";location.reload();}else{schedule();}}).catch(schedule);}
  function schedule(){var left=wait;status.textContent="Trying again in "+left+" s.";var t=setInterval(function(){left-=1;if(left<=0){clearInterval(t);status.textContent="Checking now.";check();}else{status.textContent="Trying again in "+left+" s.";}},1000);wait=Math.min(wait*2,30);}
  document.getElementById("retry").addEventListener("click",function(){location.reload();});
  addEventListener("online",function(){explain();check();});addEventListener("offline",explain);
  explain();schedule();
})();
</script>
</body></html>`, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function evictRequest(request) {
  await Promise.all((await caches.keys()).map(async (key) => {
    const cache = await caches.open(key);
    await cache.delete(request, { ignoreVary: true });
  }));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Vite owns development module revalidation and HMR. Passing that graph
  // through an offline worker can forward bodyless 304 responses on reload.
  // Only a stamped production build has an offline-cache contract.
  if (BUILD_ID.startsWith("__")) return;
  const { request } = event;
  const url = new URL(request.url);
  // Only immutable Vite build assets have a public offline-cache contract.
  // Never infer that application/extension responses are public from absent
  // headers, or from an in-memory classification lost when this worker restarts.
  const publicAsset = url.origin === self.location.origin && !url.search &&
    /^\/assets\/[^/]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9.]+$/.test(url.pathname);

  // Explicitly private requests must bypass BOTH cache writes and offline
  // fallback, including extension endpoints outside the host /api namespace.
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }
  if (request.cache === "no-store") {
    privateRequests.add(request.url);
    event.waitUntil(evictRequest(request).catch(() => {}));
    return;
  }

  // Network-first; only public build assets can use an offline fallback.
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        const cacheControl = response.headers.get("cache-control") ?? "";
        if (privateCacheControl.test(cacheControl)) {
          // Revoke earlier cacheable responses too. Keep an in-memory denylist
          // if storage is unavailable so offline fallback still fails closed.
          privateRequests.add(request.url);
          await evictRequest(request).catch(() => {});
        } else if (response.ok && publicAsset && !privateRequests.has(request.url)) {
          const clone = response.clone();
          await caches.open(CACHE_NAME).then(async (cache) => {
            await cache.put(request, clone);
            // A concurrent response may have revoked this URL during put().
            if (privateRequests.has(request.url)) await cache.delete(request, { ignoreVary: true });
          }).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        if (privateRequests.has(request.url)) return Response.error();
        if (!publicAsset) return request.mode === "navigate" ? offlineNavigationResponse() : Response.error();
        // Restrict lookup to this policy's cache; old arbitrary-response caches
        // must not become fallback candidates if activation cleanup fails.
        try {
          const cached = await (await caches.open(CACHE_NAME)).match(request);
          if (cached && !privateCacheControl.test(cached.headers.get("cache-control") ?? "")) return cached;
        } catch { /* Unavailable cache storage is an offline miss. */ }
        return Response.error();
      })
  );
});

// Phone notifications for decisions (Web Push). The server sends
// { title, body, url, tag, badge }; every push shows a notification (iOS
// requires one per push) and sets the Home Screen icon's count.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "GS Agentic Manager";
  const shown = self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/android-chrome-192x192.png",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    data: { url: typeof data.url === "string" ? data.url : "/" },
  });
  const badge = typeof data.badge === "number" && self.navigator && "setAppBadge" in self.navigator
    ? (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge())
    : Promise.resolve();
  event.waitUntil(Promise.all([shown, badge.catch(() => {})]));
});

// Tapping a notification opens the app where it points, reusing an open window.
// Only paths inside this app are followed.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const target = new URL(typeof raw === "string" ? raw : "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (typeof client.focus !== "function") continue;
      await client.focus();
      if (typeof client.navigate === "function") await client.navigate(target.href).catch(() => {});
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
