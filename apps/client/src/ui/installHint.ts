/**
 * "Add to Home Screen" hint for phones playing in a browser tab. The installed app (manifest.webmanifest) opens
 * full screen and in landscape with no browser bars, which is how the game is meant to be played.
 * Shown once per browser session; never inside the installed app, on desktop, or with ?agent=1.
 */
let deferred: any = null;
// Chrome / Edge / Samsung Internet on Android: keep the native install prompt for our button
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferred = e;
  const ok = document.querySelector<HTMLElement>('#install-hint [data-k="ok"]');   // the hint is already up: offer the real button
  if (ok && !isIOS()) { ok.dataset.k = 'install'; ok.textContent = 'ADD TO HOME SCREEN'; }
});

const KEY = 'cnc.installHint';
const standalone = () => window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as any).standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function maybeShowInstallHint() {
  if (!window.matchMedia('(pointer: coarse)').matches || standalone()) return;
  try { if (sessionStorage.getItem(KEY)) return; } catch { /* storage blocked: show it */ }
  const ui = document.getElementById('ui') ?? document.body;
  const el = document.createElement('div');
  el.id = 'install-hint';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Add the game to your home screen');
  const how = isIOS()
    ? 'Tap the <b>Share</b> button <span class="ih-ico">&#x2191;&#xFE0E;</span> in Safari, then <b>Add to Home Screen</b>.'
    : 'Open your browser menu <span class="ih-ico">&#8942;</span> and choose <b>Add to Home screen</b> or <b>Install app</b>.';
  el.innerHTML = `
    <div class="ih-card">
      <h3>BEST AS AN APP</h3>
      <p>The Casino &amp; The Church plays best from your <b>home screen</b>: full screen, in landscape, with no browser bars.</p>
      <p class="ih-how">${how}</p>
      <div class="ih-row">
        <button class="btn ghost" data-k="later">MAYBE LATER</button>
        ${deferred && !isIOS() ? '<button class="btn" data-k="install">ADD TO HOME SCREEN</button>' : '<button class="btn" data-k="ok">GOT IT</button>'}
      </div>
    </div>`;
  const done = () => { try { sessionStorage.setItem(KEY, '1'); } catch { /* ignore */ } el.remove(); };
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-k]')?.dataset.k;
    if (!k) return;
    if (k === 'install' && deferred) { deferred.prompt(); deferred.userChoice?.finally?.(() => { deferred = null; }); }
    done();
  });
  ui.appendChild(el);
}
