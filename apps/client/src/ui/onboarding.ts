import { howToHtml, playHowTo } from './howto';
import { AVATARS, ATLAS_BASE, type Realm } from '../config';
import { store, clearProfile, type Profile } from '../core/state';
import { atlasDom } from '../core/atlasDom';
import { icon } from './icons';
import { backend } from '../core/backend';
import { NAME_MAX, cleanName, nameProblem } from '@cnc/shared';

let MANIFEST: any = null;
export const setManifest = (m: any) => { MANIFEST = m; };

/** CSS for a sprite-sheet cell of a character (idle/walk rows), scale k */
export function spriteCss(id: string, row = 'idle_down', k = 3): string {
  const c = MANIFEST?.chars?.[id]; if (!c) return '';
  const r = c.rows[row] ?? c.rows.idle_down;
  return `--k:${k};--cols:${c.cols};--rows:${Object.keys(c.rows).length};--row:${r.row};--frames:${r.frames};--ms:${r.frames * r.ms}ms;background-image:url(${ATLAS_BASE}chars/${id}.png)`;
}
/** head crop used by the HUD chip */
export function faceCss(id: string): string {
  const c = MANIFEST?.chars?.[id]; if (!c) return '';
  const k = 2;
  return `background-image:url(${ATLAS_BASE}chars/${id}.png);background-size:${c.cols * 16 * k}px ${Object.keys(c.rows).length * 32 * k}px;background-position:0 -14px`;
}

const NAMES_A = ['Lucky', 'Gilded', 'Humble', 'Silver', 'Wandering', 'Velvet', 'Midnight', 'Neon', 'Sacred', 'Crimson'];
const NAMES_B = ['Fox', 'Saint', 'Dealer', 'Pilgrim', 'Magpie', 'Gambler', 'Cardinal', 'Raven', 'Pioneer', 'Sparrow'];
const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const randomName = () => `${rnd(NAMES_A)}${rnd(NAMES_B)}${Math.floor(Math.random() * 90 + 10)}`.slice(0, NAME_MAX);

export async function startOnboarding(manifest: any, onDone: (p: Profile) => void) {
  MANIFEST = manifest;
  const root = document.getElementById('onboarding')!;
  root.className = 'show';
  const draft = { name: '', avatar: AVATARS[0].id };
  const k = window.innerHeight >= 520 ? 3 : 2;
  // never scroll, never clip: scale the current screen to fit whatever the window is
  const fit = () => {
    const c = root.firstElementChild as HTMLElement | null; if (!c) return;
    c.style.transform = ''; c.style.setProperty('--fit', '1');
    const sc = Math.min(1, ((root.clientHeight || window.innerHeight) - 20) / c.offsetHeight, ((root.clientWidth || window.innerWidth) - 20) / c.offsetWidth);
    if (sc < 1) c.style.transform = `scale(${sc})`;
  };
  new MutationObserver(() => requestAnimationFrame(fit)).observe(root, { childList: true });
  window.addEventListener('resize', fit);

  const dots = (n: number) => `<div class="dots">${[1, 2, 3].map(i => `<i class="${i === n ? 'on' : i < n ? 'done' : ''}"></i>`).join('')}</div>`;
  const finish = (p: Profile) => { root.className = ''; root.innerHTML = ''; onDone(p); };

  // ---------------------------------------------------------------- 0. title
  const title = () => {
    const p = store.profile;
    root.innerHTML = `
    <div class="ob title">
      <div class="logo">
        <div class="l1">THE CASINO</div>
        <div class="amp"><i></i><span>&amp;</span><i></i></div>
        <div class="l2">THE CHURCH</div>
      </div>
      <p class="tagline">Balance is survival.</p>
      <div class="cta">
        ${p ? `<button class="btn big pulse" id="cont"><span>CONTINUE</span><small>${p.username}</small></button><button class="btn ghost" id="new">NEW GAME</button>` : `<button class="btn big pulse" id="play">PLAY AS GUEST</button>`}
        <i class="cta-br"></i>
        <button class="btn social" id="social">${icon('wallet', 16)}<span>SIGN IN WITH SOCIALS</span></button>
        <i class="cta-br"></i>
        <div class="soon" id="soon" hidden><b>NEAR AUTH &middot; COMING SOON</b><span>Sign in with Google, Apple or email and keep your account on every device.</span></div>
      </div>
      <small class="fine">Testnet &middot; play money &middot; NEAR HACKATHON 2026</small>
    </div>`;
    root.querySelector('#play')?.addEventListener('click', nameStep);
    root.querySelector('#new')?.addEventListener('click', () => { clearProfile(); store.profile = null; nameStep(); });
    root.querySelector('#cont')?.addEventListener('click', () => finish(p!));
    let soonTimer = 0;
    root.querySelector('#social')!.addEventListener('click', () => {
      const s = root.querySelector('#soon') as HTMLElement; s.hidden = false; s.classList.remove('pop'); void s.offsetWidth; s.classList.add('pop');
      window.clearTimeout(soonTimer); soonTimer = window.setTimeout(() => { if (s.isConnected) s.hidden = true; }, 2500);
    });
  };

  // ---------------------------------------------------------------- 1. name
  const nameStep = () => {
    root.innerHTML = `
    <div class="ob card px">
      ${dots(1)}
      <h2>What shall we call you, wanderer?</h2>
      <p class="sub">Your name travels between both worlds.</p>
      <div class="field">
        <input id="nm" maxlength="${NAME_MAX}" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Your name" value="${draft.name}" />
        <button class="btn ghost sq" id="dice" title="Random name">${icon('dice', 20)}</button>
      </div>
      <small class="hint" id="nm-hint">3 to ${NAME_MAX} letters or numbers. Names are unique.</small>
      <div class="wallet-note" id="wnote" hidden></div>
      <div class="row"><button class="btn ghost" id="back">BACK</button><button class="btn" id="next" disabled>NEXT</button></div>
    </div>`;
    const inp = root.querySelector('#nm') as HTMLInputElement, next = root.querySelector('#next') as HTMLButtonElement;
    const hint = root.querySelector('#nm-hint') as HTMLElement;
    const say = (t: string, kind: '' | 'ok' | 'bad' | 'wait') => { hint.textContent = t; hint.className = `hint ${kind}`; };
    // rules locally, then (debounced) ask the server whether the name is free; the newest answer wins
    let seq = 0, timer = 0;
    const check = () => {
      inp.value = inp.value.replace(/[^A-Za-z0-9_' -]/g, '').slice(0, NAME_MAX);
      draft.name = cleanName(inp.value);
      const problem = draft.name ? nameProblem(draft.name) : null;
      window.clearTimeout(timer);
      if (!draft.name) { next.disabled = true; say(`3 to ${NAME_MAX} letters or numbers. Names are unique.`, ''); return; }
      if (problem) { next.disabled = true; say(problem, 'bad'); return; }
      if (!backend.checkName) { next.disabled = false; say('', 'ok'); return; }
      next.disabled = true; say('Checking...', 'wait');
      const mine = ++seq, name = draft.name;
      timer = window.setTimeout(async () => {
        const r = await backend.checkName!(name).catch(() => ({ available: true } as { available: boolean; reason?: string }));
        if (mine !== seq) return;
        next.disabled = !r.available;
        say(r.available ? `\u2713 ${name} is yours` : (r.reason ?? 'That name is taken'), r.available ? 'ok' : 'bad');
      }, 350);
    };
    inp.addEventListener('input', check); check();
    // the guest wallet already exists (it is opened at boot): say so, briefly and truthfully
    const note = root.querySelector('#wnote') as HTMLElement;
    if (backend.wallet) {
      void backend.wallet().then((w) => {
        if (!note.isConnected) return;
        const id = `${w.accountId.slice(0, 6)}&hellip;${w.accountId.slice(-4)}`;
        note.innerHTML = `${icon('wallet', 12)}<span>A NEAR wallet <b>${id}</b> was created for you${w.encrypted ? ', encrypted and saved on this device' : ' and saved on this device'}. Back it up any time from Settings.</span>`;
        note.hidden = false;
      }).catch(() => { /* no wallet yet: say nothing */ });
    } else {
      note.innerHTML = `${icon('wallet', 12)}<span>Demo mode: chips are pretend and nothing is saved on chain.</span>`;
      note.hidden = false;
    }
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !next.disabled) avatarStep(); });
    root.querySelector('#dice')!.addEventListener('click', () => { inp.value = randomName(); check(); });
    root.querySelector('#back')!.addEventListener('click', title);
    next.addEventListener('click', avatarStep);
  };

  // ---------------------------------------------------------------- 2. avatar
  const avatarStep = () => {
    root.innerHTML = `
    <div class="ob card wide px">
      ${dots(2)}
      <h2>Choose your wanderer</h2>
      <div class="av-wrap">
        <div class="av-grid" id="grid">
          ${AVATARS.map(a => `<button class="av ${a.id === draft.avatar ? 'sel' : ''}" data-id="${a.id}" aria-label="${a.name}"><div class="spr idle" style="${spriteCss(a.id, 'idle_down', k)}"></div><span>${a.name.replace('The ', '')}</span></button>`).join('')}
        </div>
        <div class="av-prev px2">
          <div class="stage"><div class="spr walk" id="prev" style="${spriteCss(draft.avatar, 'walk_down', k + 2)}"></div><div class="shadow"></div></div>
          <b id="av-name"></b><small id="av-blurb"></small>
        </div>
      </div>
      <div class="row"><button class="btn ghost" id="back">BACK</button><button class="btn big" id="next">NEXT</button></div>
    </div>`;
    const upd = () => {
      const a = AVATARS.find(x => x.id === draft.avatar)!;
      (root.querySelector('#prev') as HTMLElement).setAttribute('style', spriteCss(a.id, 'walk_down', k + 2));
      root.querySelector('#av-name')!.textContent = a.name; root.querySelector('#av-blurb')!.textContent = a.blurb;
      root.querySelectorAll('.av').forEach(b => b.classList.toggle('sel', (b as HTMLElement).dataset.id === a.id));
    };
    root.querySelectorAll<HTMLElement>('.av').forEach(b => b.addEventListener('click', () => { draft.avatar = b.dataset.id!; upd(); }));
    upd();
    root.querySelector('#back')!.addEventListener('click', nameStep);
    root.querySelector('#next')!.addEventListener('click', howStep);
  };

  // ---------------------------------------------------------------- 3. how to play
  const howStep = () => {
    root.innerHTML = `
    <div class="ob card wide px howcard">
      ${dots(3)}
      <h2>How to play</h2>
      ${howToHtml()}
      <div class="row"><button class="btn ghost" id="back">BACK</button><button class="btn big" id="go">LET'S GO</button></div>
    </div>`;
    playHowTo(root);
    root.querySelector('#back')!.addEventListener('click', avatarStep);
    root.querySelector('#go')!.addEventListener('click', () => finish({ username: draft.name, avatar: draft.avatar, startRealm: 'plaza' as any, toursDone: { casino: false, church: false } }));
  };

  title();
}

/** "Tap to start": the first user gesture, which is what lets the browser play music from the home page on. */
export function showSplash(onTap: () => void): Promise<void> {
  return new Promise((res) => {
    const root = document.getElementById('onboarding')!;
    root.className = 'show';
    root.innerHTML = `
    <div class="ob title splash">
      <div class="logo"><div class="l1">THE CASINO</div><div class="amp"><i></i><span>&amp;</span><i></i></div><div class="l2">THE CHURCH</div></div>
      <p class="tagline">Balance is survival.</p>
      <div class="tap">TAP TO START</div>
      <small class="fine">Best played in landscape with sound on${(/iPhone|iPad/.test(navigator.userAgent) && !(navigator as any).standalone) ? '<br>For full screen: Share \u2192 Add to Home Screen' : ''}</small>
    </div>`;
    const go = () => { window.removeEventListener('keydown', go); root.removeEventListener('pointerdown', go); onTap(); res(); };
    root.addEventListener('pointerdown', go); window.addEventListener('keydown', go);
  });
}
