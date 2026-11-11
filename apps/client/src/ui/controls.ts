import { input, type Btn } from '../core/input';
import { bus } from '../core/bus';

const GLYPH = {
  x: `<svg viewBox="0 0 24 24" class="gl"><path d="M5 5l14 14M19 5L5 19" stroke="#7db2ff" stroke-width="3.4" stroke-linecap="square" fill="none"/></svg>`,
  o: `<svg viewBox="0 0 24 24" class="gl"><circle cx="12" cy="12" r="7" stroke="#ff7b8a" stroke-width="3.4" fill="none"/></svg>`,
  s: `<svg viewBox="0 0 24 24" class="gl"><rect x="5.5" y="5.5" width="13" height="13" stroke="#ff93de" stroke-width="3.4" fill="none"/></svg>`,
  t: `<svg viewBox="0 0 24 24" class="gl"><path d="M12 4.5L20 19H4z" stroke="#68e8a8" stroke-width="3.2" stroke-linejoin="miter" fill="none"/></svg>`,
};
const ARROW = (rot: number) => `<svg viewBox="0 0 24 24" class="ar" style="transform:rotate(${rot}deg)"><path d="M12 6l7 11H5z" fill="currentColor"/></svg>`;

export function mountControls(root: HTMLElement) {
  root.innerHTML = `
  <div class="pad face" id="face">
    <button class="fb ci" data-b="cancel" aria-label="Back">${GLYPH.o}</button>
    <button class="fb cr" data-b="interact" aria-label="Interact">${GLYPH.x}</button>
    
  </div>`;

  // never let the browser see these touches as a gesture (two thumbs would otherwise look like a pinch)
  ['touchstart', 'touchmove', 'touchend'].forEach(t => root.addEventListener(t, (e) => e.preventDefault(), { passive: false }));

  mountTouchSurface();

  // ---- face buttons (independent multitouch)
  root.querySelectorAll<HTMLButtonElement>('.fb').forEach((b) => {
    const k = b.dataset.b as Btn;
    b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); b.classList.add('on'); input.press(k); vib(k === 'interact' ? 12 : 8); e.preventDefault(); });
    const up = () => { b.classList.remove('on'); input.release(k); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}
/**
 * The whole scene is the control surface:
 *  - tap / click  -> walk there by pathfinding (tapping a prop walks up and opens it)
 *  - press + drag -> a floating joystick appears under the thumb, so there is no pad hiding the scene
 */
function mountTouchSurface() {
  const surface = document.getElementById('game')!;
  const joy = document.createElement('div'); joy.id = 'joy'; joy.innerHTML = '<i></i>'; document.getElementById('ui')!.appendChild(joy);
  const knob = joy.firstElementChild as HTMLElement;
  const R = 46, DRAG = 10;
  let pid = -1, ox = 0, oy = 0, t0 = 0, dragging = false;
  const setJoy = (dx: number, dy: number) => {
    const len = Math.hypot(dx, dy), k = len > R ? R / len : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const m = Math.min(1, len / R); const dead = 0.18;
    if (m < dead) return input.setTouchDir(0, 0);
    const s = (m - dead) / (1 - dead);
    input.setTouchDir((dx / len) * s, (dy / len) * s);
  };
  surface.addEventListener('pointerdown', (e) => {
    if (pid !== -1) return;
    pid = e.pointerId; ox = e.clientX; oy = e.clientY; t0 = performance.now(); dragging = false;
    surface.setPointerCapture(pid); e.preventDefault();
  });
  surface.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - ox, dy = e.clientY - oy;
    if (!dragging && Math.hypot(dx, dy) > DRAG) {
      dragging = true; joy.style.left = `${ox}px`; joy.style.top = `${oy}px`; joy.classList.add('on');
    }
    if (dragging) setJoy(dx, dy);
  });
  const end = (e: PointerEvent, cancelled: boolean) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    if (dragging) { joy.classList.remove('on'); knob.style.transform = ''; input.setTouchDir(0, 0); }
    else if (!cancelled && performance.now() - t0 < 500) { bus.emit('worldTap', e.clientX, e.clientY); vib(6); }
    dragging = false;
  };
  surface.addEventListener('pointerup', (e) => end(e, false));
  surface.addEventListener('pointercancel', (e) => end(e, true));
  surface.addEventListener('lostpointercapture', (e) => end(e, true));
  surface.addEventListener('contextmenu', (e) => e.preventDefault());
}
export const setControlsVisible = (v: boolean) => {
  const c = document.getElementById('controls'); if (!c) return;
  c.classList.toggle('show', v);
  // touch devices get the pad by default; desktop users have a keyboard (the menu can turn the pad on)
  let pref: string | null = null; try { pref = localStorage.getItem('cnc.pad'); } catch { /* */ }
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  c.classList.toggle('hidden', pref === '0' || (pref === null && !coarse));
};
/** fade the pad when it has not been touched for a while so it never hides the scene */
export function autoFadePad() {
  const c = document.getElementById('controls')!; let t = 0;
  const wake = () => { c.classList.remove('idle'); window.clearTimeout(t); t = window.setTimeout(() => c.classList.add('idle'), 2600); };
  c.addEventListener('pointerdown', wake); window.addEventListener('keydown', wake); wake();
}
export function vib(ms: number) { try { if (localStorage.getItem('cnc.haptics') !== '0') navigator.vibrate?.(ms); } catch { /* */ } }
