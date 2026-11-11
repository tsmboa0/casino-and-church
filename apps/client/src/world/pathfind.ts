import type { CollisionGrid } from './collision';

export interface Pt { x: number; y: number }

/** Grid A* over 8px cells with line-of-sight smoothing. Used by tour guides. */
export function findPath(grid: CollisionGrid, a: Pt, b: Pt, worldW: number, worldH: number): Pt[] {
  const S = 8;
  const cols = Math.ceil(worldW / S), rows = Math.ceil(worldH / S);
  const idx = (cx: number, cy: number) => cy * cols + cx;
  const blockedCache = new Map<number, boolean>();
  const blocked = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return true;
    const k = idx(cx, cy);
    let v = blockedCache.get(k);
    if (v === undefined) { v = grid.feetBlocked(cx * S + S / 2, cy * S + S / 2, 10, 6); blockedCache.set(k, v); }
    return v;
  };
  const nearestFree = (p: Pt): [number, number] => {
    const cx = Math.floor(p.x / S), cy = Math.floor(p.y / S);
    if (!blocked(cx, cy)) return [cx, cy];
    for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) === r && !blocked(cx + dx, cy + dy)) return [cx + dx, cy + dy];
    return [cx, cy];
  };
  const [sx, sy] = nearestFree(a), [gx, gy] = nearestFree(b);
  const open: number[] = [idx(sx, sy)];
  const came = new Map<number, number>();
  const g = new Map<number, number>([[idx(sx, sy), 0]]);
  const f = new Map<number, number>([[idx(sx, sy), Math.hypot(gx - sx, gy - sy)]]);
  const inOpen = new Set(open);
  const goal = idx(gx, gy);
  let guard = 0;
  while (open.length && guard++ < 30000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if ((f.get(open[i]) ?? 1e9) < (f.get(open[bi]) ?? 1e9)) bi = i;
    const cur = open.splice(bi, 1)[0]; inOpen.delete(cur);
    if (cur === goal) break;
    const cx = cur % cols, cy = Math.floor(cur / cols);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (blocked(nx, ny)) continue;
      if (dx && dy && (blocked(cx + dx, cy) || blocked(cx, cy + dy))) continue;
      const ni = idx(nx, ny);
      const ng = (g.get(cur) ?? 0) + (dx && dy ? 1.414 : 1);
      if (ng < (g.get(ni) ?? 1e9)) {
        came.set(ni, cur); g.set(ni, ng); f.set(ni, ng + Math.hypot(gx - nx, gy - ny));
        if (!inOpen.has(ni)) { open.push(ni); inOpen.add(ni); }
      }
    }
  }
  const raw: Pt[] = [];
  let c: number | undefined = goal;
  if (!came.has(goal) && goal !== idx(sx, sy)) return [b];
  while (c !== undefined) { raw.push({ x: (c % cols) * S + S / 2, y: Math.floor(c / cols) * S + S / 2 }); c = came.get(c); }
  raw.reverse();
  // string-pulling smoothing
  const los = (p: Pt, q: Pt) => {
    const n = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 4);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (grid.feetBlocked(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, 10, 6)) return false;
    }
    return true;
  };
  const out: Pt[] = [];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !los(raw[i], raw[j])) j--;
    out.push(raw[j]); i = j;
  }
  if (!out.length) out.push(b);
  out[out.length - 1] = b;
  return out;
}
