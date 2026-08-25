// ---------------------------------------------------------------------------
//  zip.js -- a minimal, dependency-free ZIP writer (store method, no deflate).
//
//  The project has no build step and no node_modules, and the brief requires
//  free/open tooling only, so pulling in a zip library is not an option.  A
//  stored (uncompressed) archive is a handful of well-documented records and
//  every unzip tool reads it; the payload here is JSON, PNG and glTF, which
//  are already compressed or tiny, so deflate would buy almost nothing.
//
//  Format: local file header + data per entry, then a central directory, then
//  the end-of-central-directory record (PKWARE APPNOTE 4.3).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time, which is what the format stores */
function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5)
             | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5)
             | (d.getDate() & 31);
  return { time, date };
}

export class Zip {
  constructor() {
    this.entries = [];
    this.enc = new TextEncoder();
  }

  /** @param path forward-slash relative path @param data string | Uint8Array */
  add(path, data) {
    const bytes = typeof data === "string" ? this.enc.encode(data) : new Uint8Array(data);
    this.entries.push({ path, bytes });
    return this;
  }

  build(now = new Date(2026, 0, 1, 12, 0, 0)) {
    const { time, date } = dosTime(now);
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const e of this.entries) {
      const name = this.enc.encode(e.path);
      const crc = crc32(e.bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // local file header signature
      local.setUint16(4, 20, true);           // version needed
      local.setUint16(6, 0x0800, true);       // UTF-8 filename flag
      local.setUint16(8, 0, true);            // method: store
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, e.bytes.length, true);
      local.setUint32(22, e.bytes.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, e.bytes);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);     // central directory signature
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, e.bytes.length, true);
      cen.setUint32(24, e.bytes.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);

      offset += 30 + name.length + e.bytes.length;
    }

    let cenSize = 0;
    for (const c of central) cenSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);       // end of central directory
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);

    let total = offset + cenSize + 22;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    for (const c of central) { out.set(c, p); p += c.length; }
    out.set(new Uint8Array(end.buffer), p);
    return out;
  }

  blob(now) { return new Blob([this.build(now)], { type: "application/zip" }); }
}
