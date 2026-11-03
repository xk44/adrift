import zlib from "zlib";
import { describe, expect, it } from "vitest";
import { NEUTRAL_GRADE, presetSettings } from "@/lib/tools/colorGrade";
import {
  GRADE_PNG_KEY,
  addPngTextChunk,
  asciiJson,
  gradeExportNames,
  gradeSidecar,
} from "@/lib/tools/colorGradeExport";
import { readPngTextChunks } from "@/lib/pngMeta";

/** Minimal valid 1x1 RGBA PNG (IHDR, IDAT, IEND) with real CRCs. */
function tinyPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

describe("color grade export provenance", () => {
  const settings = presetSettings(
    // First non-neutral look, whatever the list holds.
    "teal_orange",
  );

  it("sidecar carries tool, look, every slider, size and a safe source", () => {
    const s = gradeSidecar({
      preset: "",
      settings: { ...NEUTRAL_GRADE, contrast: 20, grain: 5 },
      width: 4000,
      height: 3000,
      source: "beach.jpg",
      now: new Date("2026-10-27T00:00:00Z"),
    });
    expect(s).toEqual({
      kind: "adrift.color_grade",
      version: 1,
      tool: "color_grade",
      preset: "",
      presetLabel: null,
      settings: { ...NEUTRAL_GRADE, contrast: 20, grain: 5 },
      width: 4000,
      height: 3000,
      source: "beach.jpg",
      created: "2026-10-27T00:00:00.000Z",
    });
    expect(
      gradeSidecar({
        preset: "none",
        settings,
        width: 1,
        height: 1,
        source: "data:image/png;base64,AAAA",
      }).source,
    ).toBeNull();
    expect(Object.keys(s.settings).sort()).toEqual(
      Object.keys(NEUTRAL_GRADE).sort(),
    );
  });

  it("uses the shared Adrift download names (tool ids use dashes)", () => {
    expect(gradeExportNames(1761523200000)).toEqual({
      png: "Adrift_color-grade_1761523200000_v1.png",
      json: "Adrift_color-grade_1761523200000_v1.grade.json",
    });
  });

  it("asciiJson escapes non-ASCII so it fits a tEXt chunk", () => {
    const text = asciiJson({ source: "café ☕" });
    expect(text).toBe('{"source":"caf\\u00e9 \\u2615"}');
    expect(JSON.parse(text)).toEqual({ source: "café ☕" });
  });

  it("embeds the sidecar in the PNG where the importer reads it", () => {
    const png = tinyPng();
    const sidecar = gradeSidecar({
      preset: "",
      settings: { ...NEUTRAL_GRADE, exposure: 1 },
      width: 1,
      height: 1,
      source: "x.png",
    });
    const out = addPngTextChunk(png, GRADE_PNG_KEY, asciiJson(sidecar));
    expect(out.length).toBeGreaterThan(png.length);
    const chunks = readPngTextChunks(out);
    expect(JSON.parse(chunks[GRADE_PNG_KEY])).toEqual(sidecar);
    // Still a decodable PNG: CRC of the new chunk checks out.
    const view = new DataView(out.buffer);
    const len = view.getUint32(33);
    expect(String.fromCharCode(...out.subarray(37, 41))).toBe("tEXt");
    const again = addPngTextChunk(png, GRADE_PNG_KEY, asciiJson(sidecar));
    expect(view.getUint32(41 + len)).toBe(
      new DataView(again.buffer).getUint32(41 + len),
    );
    expect(addPngTextChunk(new Uint8Array([1, 2, 3]), "k", "v")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
