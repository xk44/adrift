/**
 * Minimal PSD writer: 8-bit RGB, one raw (uncompressed) RGBA layer per part,
 * and a merged image. Layers are written bottom to top, so pass them back to
 * front. A PSD has one stacking order per layer, so where parts interleave
 * the layered view is approximate; the merged image is whatever composite
 * the caller passes (the per-pixel z-buffer one), so flattened previews are
 * exact.
 */

export interface PsdLayer {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Straight-alpha RGBA, width*height*4. */
  rgba: Uint8Array | Uint8ClampedArray;
  hidden?: boolean;
}

export interface PsdDocument {
  width: number;
  height: number;
  /** Bottom first. */
  layers: readonly PsdLayer[];
  /** Merged image, straight-alpha RGBA, width*height*4. */
  composite: Uint8Array | Uint8ClampedArray;
}

export class PsdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsdError";
  }
}

const MAX_SIDE = 30000;

class Writer {
  buf: Uint8Array;
  view: DataView;
  pos = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  u8(v: number) {
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  u16(v: number) {
    this.view.setUint16(this.pos, v);
    this.pos += 2;
  }
  i16(v: number) {
    this.view.setInt16(this.pos, v);
    this.pos += 2;
  }
  u32(v: number) {
    this.view.setUint32(this.pos, v);
    this.pos += 4;
  }
  i32(v: number) {
    this.view.setInt32(this.pos, v);
    this.pos += 4;
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes(b: Uint8Array) {
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  zeros(n: number) {
    this.pos += n;
  }
}

/** Pascal name bytes: ASCII only, padded so length byte + text is a multiple of 4. */
function pascalName(name: string): Uint8Array {
  const ascii = Array.from(name, (ch) => {
    const c = ch.codePointAt(0)!;
    return c >= 0x20 && c < 0x7f ? c : 0x3f;
  }).slice(0, 255);
  const len = Math.ceil((ascii.length + 1) / 4) * 4;
  const out = new Uint8Array(len);
  out[0] = ascii.length;
  out.set(ascii, 1);
  return out;
}

function utf16Units(name: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < name.length && units.length < 1024; i++)
    units.push(name.charCodeAt(i));
  return units;
}

/** "luni" (Unicode layer name) block length, excluding its 12-byte header. */
function luniLength(units: number[]): number {
  return Math.ceil((4 + units.length * 2) / 4) * 4;
}

function extraLength(layer: PsdLayer): number {
  return (
    4 +
    4 +
    pascalName(layer.name).length +
    12 +
    luniLength(utf16Units(layer.name))
  );
}

function checkLayer(l: PsdLayer) {
  if (
    !Number.isInteger(l.width) ||
    !Number.isInteger(l.height) ||
    l.width < 0 ||
    l.height < 0
  )
    throw new PsdError(`Bad layer size for ${l.name}`);
  if (l.rgba.length < l.width * l.height * 4)
    throw new PsdError(`Layer ${l.name} has too few pixels`);
}

export function writePsd(doc: PsdDocument): Uint8Array {
  const { width, height, layers } = doc;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SIDE ||
    height > MAX_SIDE
  )
    throw new PsdError("Bad canvas size");
  if (doc.composite.length < width * height * 4)
    throw new PsdError("Composite has too few pixels");
  if (layers.length > 0x7fff) throw new PsdError("Too many layers");
  layers.forEach(checkLayer);

  // Layer info: count + records + channel data.
  let records = 0;
  let channelData = 0;
  for (const l of layers) {
    records += 16 + 2 + 4 * 6 + 12 + 4 + extraLength(l);
    channelData += 4 * (2 + l.width * l.height);
  }
  const layerInfoRaw = 2 + records + channelData;
  const layerInfoLen = layerInfoRaw + (layerInfoRaw % 2);
  const layerMaskLen = 4 + layerInfoLen + 4;
  const pixels = width * height;
  const total = 26 + 4 + 4 + 4 + layerMaskLen + 2 + 4 * pixels;

  const w = new Writer(total);
  w.ascii("8BPS");
  w.u16(1);
  w.zeros(6);
  w.u16(4);
  w.u32(height);
  w.u32(width);
  w.u16(8);
  w.u16(3);
  w.u32(0); // color mode data
  w.u32(0); // image resources

  w.u32(layerMaskLen);
  w.u32(layerInfoLen);
  // Negative: the merged image's 4th channel is its transparency, not a spare alpha.
  w.i16(-layers.length);
  for (const l of layers) {
    const plane = l.width * l.height;
    w.i32(l.top);
    w.i32(l.left);
    w.i32(l.top + l.height);
    w.i32(l.left + l.width);
    w.u16(4);
    for (const id of [-1, 0, 1, 2]) {
      w.i16(id);
      w.u32(2 + plane);
    }
    w.ascii("8BIM");
    w.ascii("norm");
    w.u8(255);
    w.u8(0);
    w.u8(l.hidden ? 0x02 : 0);
    w.u8(0);
    w.u32(extraLength(l));
    w.u32(0); // layer mask
    w.u32(0); // blending ranges
    w.bytes(pascalName(l.name));
    const units = utf16Units(l.name);
    w.ascii("8BIM");
    w.ascii("luni");
    const luni = luniLength(units);
    w.u32(luni);
    w.u32(units.length);
    for (const u of units) w.u16(u);
    w.zeros(luni - 4 - units.length * 2);
  }
  for (const l of layers) {
    const plane = l.width * l.height;
    for (const c of [3, 0, 1, 2]) {
      w.u16(0);
      const start = w.pos;
      const src = l.rgba;
      for (let i = 0; i < plane; i++) w.buf[start + i] = src[i * 4 + c];
      w.pos += plane;
    }
  }
  w.zeros(layerInfoLen - layerInfoRaw);
  w.u32(0); // global layer mask

  w.u16(0); // merged image: raw, planar R, G, B, A
  for (const c of [0, 1, 2, 3]) {
    const start = w.pos;
    const src = doc.composite;
    for (let i = 0; i < pixels; i++) w.buf[start + i] = src[i * 4 + c];
    w.pos += pixels;
  }
  if (w.pos !== total) throw new PsdError("PSD size mismatch");
  return w.buf;
}
