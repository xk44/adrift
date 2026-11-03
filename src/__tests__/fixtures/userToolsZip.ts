import { deflateRawSync } from "zlib";

export interface FileSpec {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  encrypted?: boolean;
}

/** Minimal zip writer for tests (CRC left 0: the reader does not check it). */
export function makeZip(files: FileSpec[], comment = ""): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const method = f.method ?? 8;
    const body = method === 8 ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name, "utf8");
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(f.encrypted ? 1 : 0, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(f.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(f.encrypted ? 1 : 0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    centrals.push(cen, name);
    offset += loc.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const c = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, eocd, c]);
}
