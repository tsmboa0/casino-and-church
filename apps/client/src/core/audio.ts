import type { Zone } from '../config';

/**
 * Music + sfx through the Web Audio API.
 *
 * Why not plain <audio> volume: on iPhone, (1) the `volume` property of an <audio> element is read-only (so
 * crossfades did nothing) and (2) starting a second <audio> element pauses the first, so every click/spin sound
 * silenced the music and nothing restarted it. Here the music elements are routed through GainNodes (real
 * crossfades everywhere) and sound effects are decoded buffers played on the same AudioContext (they mix with
 * the music instead of interrupting it). A small watchdog also resumes the music if the system ever pauses it.
 */
type Track = 'main' | 'casino' | 'church';
type Sfx = 'hit' | 'roulette' | 'slots' | 'win' | 'lose' | 'blessed';
const SRC: Record<Track, string> = { main: 'audio/main.mp3', casino: 'audio/casino.mp3', church: 'audio/church.mp3' };
const VOL: Record<Track, number> = { main: 0.5, casino: 0.42, church: 0.5 };
const XFADE_S = 2.6;                       // old track fades out while the new one fades in
const SFX: Record<Sfx, string> = { hit: 'audio/hit.mp3', roulette: 'audio/roulette.mp3', slots: 'audio/slots.wav', win: 'audio/win.m4a', lose: 'audio/lose.m4a', blessed: 'audio/blessed.mp3' };

class AudioManager {
  private els = new Map<Track, HTMLAudioElement>();
  private gains = new Map<Track, GainNode>();
  private buffers = new Map<Sfx, AudioBuffer>();
  private ctx: AudioContext | null = null;
  private stopTimers = new Map<Track, number>();
  private want: Track | null = null;
  private unlocked = false;
  /** the background music (the speaker button). Game sounds have their own switch: turning the music off must not
   *  silence the reels, the wheel or a win. */
  muted = (() => { try { return localStorage.getItem('cnc.muted') === '1'; } catch { return false; } })();
  sfxMuted = (() => { try { return localStorage.getItem('cnc.sfx') === '0'; } catch { return false; } })();
  setSfxMuted(m: boolean) { this.sfxMuted = m; try { localStorage.setItem('cnc.sfx', m ? '0' : '1'); } catch { /* */ } }

  constructor() {
    (Object.keys(SRC) as Track[]).forEach(t => { const a = new Audio(SRC[t]); a.loop = true; a.preload = 'auto'; a.crossOrigin = 'anonymous'; this.els.set(t, a); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.els.forEach(a => a.pause()); void this.ctx?.suspend(); }
      else { void this.ctx?.resume(); this.keepAlive(); }
    });
    window.setInterval(() => this.keepAlive(), 1500);
    // any tap is also a chance to resume a context the OS suspended (incoming call, Siri, etc.)
    document.addEventListener('pointerdown', () => { if (this.ctx?.state === 'suspended') void this.ctx.resume(); this.keepAlive(); }, { capture: true });
  }

  get current() { return this.want; }
  get isUnlocked() { return this.unlocked; }

  /** call from inside a user gesture */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC();
      this.els.forEach((el, t) => {
        const g = this.ctx!.createGain(); g.gain.value = 0;
        this.ctx!.createMediaElementSource(el).connect(g).connect(this.ctx!.destination);
        this.gains.set(t, g);
      });
      (Object.keys(SFX) as Sfx[]).forEach(k => fetch(SFX[k]).then(r => r.arrayBuffer()).then(b => this.ctx!.decodeAudioData(b)).then(buf => this.buffers.set(k, buf)).catch(() => { /* missing sfx is not fatal */ }));
    } catch { this.ctx = null; }
    if (this.want) this.fadeIn(this.want);
  }

  /** make `t` the only track playing (null = silence) */
  music(t: Track | null) {
    if (this.want === t) return;
    const prev = this.want; this.want = t;
    if (prev) this.fadeOut(prev);
    if (t && this.unlocked) this.fadeIn(t);
  }
  /** the crossroads plays the main theme; each realm has its own track */
  zone(z: Zone) { this.music(z === 'plaza' ? 'main' : z); }

  private setGain(t: Track, to: number, seconds: number) {
    const el = this.els.get(t)!, g = this.gains.get(t);
    if (!g || !this.ctx) { el.volume = to; return; }                   // no Web Audio: best effort
    const now = this.ctx.currentTime, p = g.gain;
    p.cancelScheduledValues(now); p.setValueAtTime(p.value, now);
    // equal-power-ish curve: setTargetAtTime approaches the target exponentially, no dips or bumps
    p.setTargetAtTime(to, now, seconds / 4);
  }
  private fadeIn(t: Track) {
    const el = this.els.get(t)!;
    window.clearTimeout(this.stopTimers.get(t));
    if (this.muted || this.held) return;            // music off, or a game panel is open: stay quiet
    void this.ctx?.resume();
    if (el.paused) el.play().catch(() => { /* retried by keepAlive */ });
    this.setGain(t, VOL[t], XFADE_S);
  }
  private fadeOut(t: Track) {
    this.setGain(t, 0, XFADE_S);
    window.clearTimeout(this.stopTimers.get(t));
    this.stopTimers.set(t, window.setTimeout(() => { if (this.want !== t) this.els.get(t)!.pause(); }, XFADE_S * 1000 + 200));
  }
  /** if the wanted track is not playing (the OS paused it, a call came in...), start it again */
  private keepAlive() {
    if (!this.unlocked || this.muted || this.held || !this.want || document.hidden) return;
    const el = this.els.get(this.want)!;
    if (el.paused) { el.play().catch(() => {}); this.setGain(this.want, VOL[this.want], 0.8); }
  }

  private held = false;
  /**
   * A game panel is open: the background music fades out and stops, so the machine's own sounds (reels, wheel,
   * win/lose) play alone; release() fades the same track back in. Sound effects have their own switch, so this
   * never silences them.
   */
  hold() {
    if (this.held) return; this.held = true;
    const t = this.want; if (!t) return;
    this.setGain(t, 0, 0.6);
    window.clearTimeout(this.stopTimers.get(t));
    this.stopTimers.set(t, window.setTimeout(() => { if (this.held) this.els.get(t)!.pause(); }, 700));
  }
  release() {
    if (!this.held) return; this.held = false;
    if (this.want && this.unlocked) this.fadeIn(this.want);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('cnc.muted', m ? '1' : '0'); } catch { /* */ }
    // the pause is a tracked timer, so un-muting within 0.3 s cancels it (it used to stop the music anyway)
    if (m) this.els.forEach((a, t) => { window.clearTimeout(this.stopTimers.get(t)); this.setGain(t, 0, 0.2); this.stopTimers.set(t, window.setTimeout(() => { if (this.muted) a.pause(); }, 300)); });
    else if (this.want && this.unlocked) this.fadeIn(this.want);
  }

  /** one-shot sound; `maxS` cuts a long clip short with a soft fade. Returns a stop function. */
  play(name: Sfx, vol = 0.6, maxS = 0): (fadeS?: number) => void {
    return this.start(name, vol, false, maxS);
  }
  /** a sound that repeats until the returned stop() is called (a spinning wheel, the reels) */
  /** stop(fadeS) fades out over fadeS seconds (default 0.25) */
  loop(name: Sfx, vol = 0.6): (fadeS?: number) => void {
    return this.start(name, vol, true, 0);
  }
  private start(name: Sfx, vol: number, loop: boolean, maxS: number): (fadeS?: number) => void {
    const none = () => {};
    if (this.sfxMuted || !this.unlocked) return none;
    const buf = this.buffers.get(name);
    if (this.ctx && buf) {
      const ctx = this.ctx, s = ctx.createBufferSource(), g = ctx.createGain(); g.gain.value = vol;
      s.buffer = buf; s.loop = loop; s.connect(g).connect(ctx.destination); s.start();
      let done = false;
      const stop = (fade = 0.25) => {
        if (done) return; done = true;
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fade);
        try { s.stop(t + fade + 0.02); } catch { /* already stopped */ }
      };
      if (maxS > 0) window.setTimeout(() => stop(0.5), maxS * 1000);
      return (fadeS?: number) => stop(fadeS ?? 0.25);
    }
    if (this.ctx) return none;               // still decoding: skip rather than interrupt the music with an <audio> element
    const a = new Audio(SFX[name]); a.volume = vol; a.loop = loop; a.play().catch(() => {});
    if (maxS > 0) window.setTimeout(() => a.pause(), maxS * 1000);
    return () => a.pause();
  }
}
export const audio = new AudioManager();
