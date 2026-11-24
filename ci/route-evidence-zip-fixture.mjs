import { crc32, deflateRawSync } from "node:zlib";

// Minimal synthetic ZIP writer; `opts` mutates individual header fields.
export function zip(entries, opts = {}) {
  const locals = [];
  const cds = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "latin1");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const compressed = e.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const body = e.trailing ? Buffer.concat([compressed, Buffer.from(e.trailing)]) : compressed;
    const gap = Buffer.from(e.gap ?? "");
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const extra = e.extra ?? Buffer.alloc(0);
    const comment = Buffer.from(e.comment ?? "");
    const usize = e.usize ?? data.length;
    const crc = e.crc ?? crc32(data);
    const flags = e.flags ?? 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.version ?? 0, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(localExtra.length, 28);
    const descriptor = Buffer.alloc(flags & 8 ? (e.unsigned ? 12 : 16) : 0);
    if (descriptor.length) {
      const at = e.unsigned ? 0 : 4;
      if (at) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(e.descriptorCrc ?? crc, at);
      descriptor.writeUInt32LE(body.length, at + 4);
      descriptor.writeUInt32LE(usize, at + 8);
    }
    locals.push(gap, lh, name, localExtra, body, descriptor);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.madeBy ?? 20, 4);
    cd.writeUInt16LE(e.version ?? 0, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(usize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt16LE(comment.length, 32);
    cd.writeUInt32LE(e.attrs ?? 0, 38);
    cd.writeUInt32LE(e.local ?? offset + gap.length, 42);
    cds.push([cd, name, extra, comment]);
    offset += gap.length + 30 + name.length + localExtra.length + body.length + descriptor.length;
  }
  const localSuffix = Buffer.from(opts.localSuffix ?? "");
  locals.push(localSuffix);
  offset += localSuffix.length;
  const cdBuf = Buffer.concat((opts.reverseCentral ? cds.reverse() : cds).flat());
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(opts.comment ?? 0, 20);
  return Buffer.concat([...locals, cdBuf, end]);
}
