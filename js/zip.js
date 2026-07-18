// Minimal store-only (no compression) ZIP writer. Enough to bundle a PNG sequence + JSON
// into one download with zero dependencies. PNGs are already compressed, so "store" is fine.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class Zip {
  constructor() { this.files = []; }

  add(name, bytes) {
    this.files.push({ name: new TextEncoder().encode(name), data: new Uint8Array(bytes), crc: crc32(new Uint8Array(bytes)) });
  }

  blob() {
    const parts = [];
    const central = [];
    let offset = 0;
    const u16 = v => new Uint8Array([v & 255, (v >> 8) & 255]);
    const u32 = v => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);

    for (const f of this.files) {
      const local = concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(f.crc), u32(f.data.length), u32(f.data.length),
        u16(f.name.length), u16(0), f.name, f.data,
      ]);
      parts.push(local);
      central.push(concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(f.crc), u32(f.data.length), u32(f.data.length),
        u16(f.name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(offset), f.name,
      ]));
      offset += local.length;
    }
    const cd = concat(central);
    const end = concat([
      u32(0x06054b50), u16(0), u16(0), u16(this.files.length), u16(this.files.length),
      u32(cd.length), u32(offset), u16(0),
    ]);
    return new Blob([...parts, cd, end], { type: 'application/zip' });
  }
}

function concat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
