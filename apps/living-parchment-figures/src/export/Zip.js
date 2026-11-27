// Minimal stored (uncompressed) .zip writer, shared with Living Parchment's exporter.

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip several files without compression. `files` = [{name, data}]. Returns a Uint8Array. */
export function zipFiles(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const nameBytes = new TextEncoder().encode(f.name);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, bytes.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const centralSize = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let o = 0;
  for (const part of [...parts, ...centrals, new Uint8Array(end.buffer)]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Zip one file without compression. Returns a Uint8Array. */
export function zipSingle(name, data) {
  return zipFiles([{ name, data }]);
}
