/**
 * Integer-scale adaptive viewport (PLAN §5.1).
 * Picks an integer device-pixel scale so that pixels stay square and crisp on every phone,
 * then derives the logical resolution from the real screen size.
 */
export interface ViewportInfo { w: number; h: number; scale: number; dpr: number; cssW: number; cssH: number; }

const TARGET_H = 224; // logical rows we want visible (14 tiles)

export function computeViewport(): ViewportInfo {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const physW = Math.floor(window.innerWidth * dpr);
  const physH = Math.floor(window.innerHeight * dpr);
  const scale = Math.max(1, Math.round(physH / TARGET_H));
  const w = Math.max(240, Math.floor(physW / scale));
  const h = Math.max(160, Math.floor(physH / scale));
  return { w, h, scale, dpr, cssW: (w * scale) / dpr, cssH: (h * scale) / dpr };
}

export function applyCanvasSize(canvas: HTMLCanvasElement, v: ViewportInfo) {
  canvas.style.width = `${v.cssW}px`;
  canvas.style.height = `${v.cssH}px`;
  canvas.style.imageRendering = 'pixelated';
}
