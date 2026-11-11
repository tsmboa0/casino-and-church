/** Little-endian borsh writer/reader for the NEAR types we actually sign. */

export class Writer {
  private parts: Uint8Array[] = [];
  u8(n: number) { this.parts.push(Uint8Array.of(n & 0xff)); }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.parts.push(b);
  }
  u64(n: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    this.parts.push(b);
  }
  u128(n: bigint) {
    const b = new Uint8Array(16);
    const v = new DataView(b.buffer);
    v.setBigUint64(0, n & ((1n << 64n) - 1n), true);
    v.setBigUint64(8, n >> 64n, true);
    this.parts.push(b);
  }
  raw(data: Uint8Array) { this.parts.push(data); }
  bytes(data: Uint8Array) { this.u32(data.length); this.raw(data); }
  str(s: string) { this.bytes(new TextEncoder().encode(s)); }
  finish(): Uint8Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

export class Reader {
  private o = 0;
  private buf: Uint8Array;
  constructor(buf: Uint8Array) { this.buf = buf; }
  get rest() { return this.buf.length - this.o; }
  u8() { return this.buf[this.o++]!; }
  u32() {
    const n = new DataView(this.buf.buffer, this.buf.byteOffset + this.o, 4).getUint32(0, true);
    this.o += 4;
    return n;
  }
  u64() {
    const n = new DataView(this.buf.buffer, this.buf.byteOffset + this.o, 8).getBigUint64(0, true);
    this.o += 8;
    return n;
  }
  u128() {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
  bytes() {
    const n = this.u32();
    const out = this.buf.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
  str() { return new TextDecoder().decode(this.bytes()); }
  raw(n: number) {
    const out = this.buf.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
}
