import { howToHtml, playHowTo } from './howto';
import { AVATARS, ATLAS_BASE, type Realm } from '../config';
import { store, clearProfile, type Profile } from '../core/state';
import { atlasDom } from '../core/atlasDom';
import { icon } from './icons';
import { backend } from '../core/backend';
import { NAME_MAX, PASSWORD_MIN, cleanName, nameProblem, passwordProblem } from '@cnc/shared';

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
  /** live game (a chain backend) = real accounts; the offline demo has none */
  const accounts = !!backend.signIn;
  const draft: {
    name: string; avatar: string;
    securing?: boolean;                 // an existing guest is setting a password (keeps the wallet and chips)
    created?: boolean;                  // the account exists now: BACK must not sign up twice
    signedIn?: { username: string; avatar: string; toursDone: { casino: boolean; church: boolean } };
  } = { name: '', avatar: AVATARS[0].id };
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
      <div class="cta">${ctaHtml(p)}</div>
      <small class="fine">Testnet &middot; play money &middot; NEAR HACKATHON 2026</small>
    </div>`;
    root.querySelector('#play')?.addEventListener('click', nameStep);
    root.querySelector('#new')?.addEventListener('click', () => { clearProfile(); store.profile = null; nameStep(); });
    root.querySelector('#cont')?.addEventListener('click', () => finish(p!));
    root.querySelector('#signin')?.addEventListener('click', signInStep);
    root.querySelector('#create')?.addEventListener('click', () => { draft.securing = false; nameStep(); });
    root.querySelector('#secure')?.addEventListener('click', () => { draft.securing = true; draft.name = p?.username ?? ''; nameStep(); });
    root.querySelector('#switch')?.addEventListener('click', () => {
      if (!confirm('Sign out on this device? You can sign back in any time with your username and password.')) return;
      backend.signOut?.(); clearProfile(); store.profile = null; title();
    });
  };
  /** the title's buttons. Live game: real accounts (username + password). Offline demo: no accounts. */
  const ctaHtml = (p: Profile | null) => {
    if (!accounts) {
      return p ? `<button class="btn big pulse" id="cont"><span>CONTINUE</span><small>${p.username}</small></button><button class="btn ghost" id="new">NEW GAME</button>`
        : `<button class="btn big pulse" id="play">PLAY THE DEMO</button>`;
    }
    const linked = backend.linkedAccount?.();
    if (linked && p) return `<button class="btn big pulse" id="cont"><span>CONTINUE</span><small>${p.username}</small></button><button class="btn ghost" id="switch">SWITCH ACCOUNT</button>`;
    // a guest wallet from before accounts existed: let its owner keep the chips by setting a password
    if (!linked && backend.hasDeviceWallet?.()) return `<button class="btn big pulse" id="secure"><span>SECURE MY ACCOUNT</span><small>${p ? p.username : 'keep your chips'}</small></button><button class="btn ghost" id="signin">SIGN IN</button>`;
    return `<button class="btn big pulse" id="signin">SIGN IN</button><button class="btn ghost" id="create">CREATE ACCOUNT</button>`;
  };

  // ---------------------------------------------------------------- sign in (any device)
  const signInStep = () => {
    root.innerHTML = `
    <div class="ob card px">
      <h2>Welcome back</h2>
      <p class="sub">Sign in to continue with your chips, LUCK and FAITH.</p>
      <div class="field col"><input id="su" maxlength="${NAME_MAX}" spellcheck="false" autocomplete="username" autocapitalize="off" placeholder="Username" value="${draft.name}" />
        <input id="sp" type="password" autocomplete="current-password" placeholder="Password" /></div>
      <small class="hint" id="s-hint">Your password never leaves this device.</small>
      <div class="row"><button class="btn ghost" id="back">BACK</button><button class="btn" id="go">SIGN IN</button></div>
    </div>`;
    const u = root.querySelector('#su') as HTMLInputElement, pw = root.querySelector('#sp') as HTMLInputElement;
    const go = root.querySelector('#go') as HTMLButtonElement, hint = root.querySelector('#s-hint') as HTMLElement;
    const submit = async () => {
      if (go.disabled) return;
      if (!u.value.trim() || !pw.value) { hint.textContent = 'Enter your username and password.'; hint.className = 'hint bad'; return; }
      if (!backend.linkedAccount?.() && backend.hasDeviceWallet?.()
        && !confirm('This device has a guest wallet with no password. Signing in replaces it, and its chips are lost unless you secure it first. Sign in anyway?')) return;
      go.disabled = true; go.textContent = 'UNLOCKING...'; hint.textContent = 'Unlocking your wallet on this device...'; hint.className = 'hint wait';
      try {
        const r = await backend.signIn!(u.value, pw.value);
        draft.name = r.username;
        if (r.avatar) finish({ username: r.username, avatar: r.avatar, startRealm: 'plaza' as any, toursDone: r.toursDone });
        else { draft.signedIn = r; avatarStep(); }
      } catch (e) {
        hint.textContent = e instanceof Error ? e.message : 'Could not sign in.'; hint.className = 'hint bad';
        go.disabled = false; go.textContent = 'SIGN IN';
      }
    };
    go.addEventListener('click', submit);
    [u, pw].forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); }));
    root.querySelector('#back')!.addEventListener('click', title);
    (draft.name ? pw : u).focus();
  };

  // ---------------------------------------------------------------- 1. name
  const nameStep = () => {
    root.innerHTML = `
    <div class="ob card px">
      ${dots(1)}
      <h2>${!accounts ? 'What shall we call you, wanderer?' : draft.securing ? 'Secure your account' : 'Create your account'}</h2>
      <p class="sub">${accounts ? 'Your username is how you sign in, on any device.' : 'Your name travels between both worlds.'}</p>
      <div class="field">
        <input id="nm" maxlength="${NAME_MAX}" spellcheck="false" autocomplete="${accounts ? 'username' : 'off'}" autocapitalize="off" placeholder="${accounts ? 'Username' : 'Your name'}" value="${draft.name}" />
        <button class="btn ghost sq" id="dice" title="Random name">${icon('dice', 20)}</button>
      </div>
      <small class="hint" id="nm-hint">3 to ${NAME_MAX} letters or numbers. Names are unique.</small>
      ${accounts ? `<div class="field col"><input id="pw1" type="password" autocomplete="new-password" placeholder="Password" />
        <input id="pw2" type="password" autocomplete="new-password" placeholder="Type it again" /></div>
      <small class="hint" id="pw-hint">At least ${PASSWORD_MIN} characters. We never see it: forget it and the account cannot be recovered.</small>` : ''}
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
    // say what happens to the wallet, briefly and truthfully
    const note = root.querySelector('#wnote') as HTMLElement;
    note.innerHTML = accounts
      ? `${icon('wallet', 12)}<span>${draft.securing ? 'Your NEAR wallet on this device' : 'A NEAR wallet is created for you. It'} is encrypted with your password on this device; our server only ever stores that locked copy.</span>`
      : `${icon('wallet', 12)}<span>Demo mode: chips are pretend and nothing is saved on chain.</span>`;
    note.hidden = false;
    // live game: the password creates (or secures) the account before the avatar step
    const pw1 = root.querySelector('#pw1') as HTMLInputElement | null, pw2 = root.querySelector('#pw2') as HTMLInputElement | null;
    const pwHint = root.querySelector('#pw-hint') as HTMLElement | null;
    const proceed = async () => {
      if (next.disabled) return;
      if (!accounts) return avatarStep();
      const bad = passwordProblem(pw1!.value) ?? (pw1!.value !== pw2!.value ? 'The two passwords do not match' : null);
      if (bad) { pwHint!.textContent = bad; pwHint!.className = 'hint bad'; return; }
      next.disabled = true; next.textContent = 'CREATING...';
      pwHint!.textContent = draft.securing ? 'Locking your wallet with your password...' : 'Creating your wallet and locking it with your password...'; pwHint!.className = 'hint wait';
      try {
        await backend.signUp!(draft.name, pw1!.value);
        draft.created = true;
        // a guest who already has a character goes straight back in
        const p = store.profile;
        if (draft.securing && p) return finish({ ...p, username: draft.name });
        avatarStep();
      } catch (e) {
        pwHint!.textContent = e instanceof Error ? e.message : 'Could not create the account.'; pwHint!.className = 'hint bad';
        next.disabled = false; next.textContent = 'NEXT';
      }
    };
    [inp, pw1, pw2].forEach(i => i?.addEventListener('keydown', (e) => { if (e.key === 'Enter') void proceed(); }));
    root.querySelector('#dice')!.addEventListener('click', () => { inp.value = randomName(); check(); });
    root.querySelector('#back')!.addEventListener('click', title);
    next.addEventListener('click', () => void proceed());
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
      <div class="row">${draft.created || draft.signedIn ? '' : '<button class="btn ghost" id="back">BACK</button>'}<button class="btn big" id="next">NEXT</button></div>
    </div>`;
    const upd = () => {
      const a = AVATARS.find(x => x.id === draft.avatar)!;
      (root.querySelector('#prev') as HTMLElement).setAttribute('style', spriteCss(a.id, 'walk_down', k + 2));
      root.querySelector('#av-name')!.textContent = a.name; root.querySelector('#av-blurb')!.textContent = a.blurb;
      root.querySelectorAll('.av').forEach(b => b.classList.toggle('sel', (b as HTMLElement).dataset.id === a.id));
    };
    root.querySelectorAll<HTMLElement>('.av').forEach(b => b.addEventListener('click', () => { draft.avatar = b.dataset.id!; upd(); }));
    upd();
    root.querySelector('#back')?.addEventListener('click', nameStep);
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
    root.querySelector('#go')!.addEventListener('click', () => finish({ username: draft.name, avatar: draft.avatar, startRealm: 'plaza' as any, toursDone: draft.signedIn?.toursDone ?? { casino: false, church: false } }));
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
