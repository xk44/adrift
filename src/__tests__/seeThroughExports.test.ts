import { describe, expect, it } from "vitest";
import { crc32 } from "zlib";
import { writePsd, PsdError } from "@/lib/layers/psd";
import { layerBlenderScript, layerPlacement } from "@/lib/layers/layerBlender";
import { crc32Bytes, writeZipBytes, ZipWriteError } from "@/lib/layers/zip";
import { layerBundleFiles } from "@/lib/layers/bundle";
import { parseLayerManifest } from "@/lib/layers/seeThrough";
import { listZipEntries, readZipEntry } from "@/lib/userTools/zip";

function rgba(w: number, h: number, seed: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i++) a[i] = (i * 7 + seed) & 255;
  return a;
}

/** Parse the bits of a PSD we write back out. */
function readPsd(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const sig = String.fromCharCode(...buf.slice(0, 4));
  const header = {
    sig,
    version: v.getUint16(4),
    channels: v.getUint16(12),
    height: v.getUint32(14),
    width: v.getUint32(18),
    depth: v.getUint16(22),
    mode: v.getUint16(24),
  };
  p = 26;
  p += 4 + v.getUint32(p); // color mode
  p += 4 + v.getUint32(p); // resources
  const lmLen = v.getUint32(p);
  const lmEnd = p + 4 + lmLen;
  p += 4;
  const liLen = v.getUint32(p);
  const liEnd = p + 4 + liLen;
  p += 4;
  const count = v.getInt16(p);
  p += 2;
  const layers = [];
  for (let i = 0; i < Math.abs(count); i++) {
    const top = v.getInt32(p);
    const left = v.getInt32(p + 4);
    const bottom = v.getInt32(p + 8);
    const right = v.getInt32(p + 12);
    const nch = v.getUint16(p + 16);
    p += 18;
    const chans = [];
    for (let c = 0; c < nch; c++) {
      chans.push({ id: v.getInt16(p), len: v.getUint32(p + 2) });
      p += 6;
    }
    const blend = String.fromCharCode(...buf.slice(p, p + 8));
    const flags = buf[p + 10];
    p += 12;
    const extra = v.getUint32(p);
    p += 4;
    const extraEnd = p + extra;
    p += 4 + v.getUint32(p); // mask
    p += 4 + v.getUint32(p); // blending ranges
    const nameLen = buf[p];
    const name = String.fromCharCode(...buf.slice(p + 1, p + 1 + nameLen));
    p += Math.ceil((nameLen + 1) / 4) * 4;
    let uname: string | null = null;
    while (p < extraEnd) {
      const key = String.fromCharCode(...buf.slice(p + 4, p + 8));
      const len = v.getUint32(p + 8);
      if (key === "luni") {
        const n = v.getUint32(p + 12);
        uname = String.fromCharCode(
          ...Array.from({ length: n }, (_, k) => v.getUint16(p + 16 + k * 2)),
        );
      }
      p += 12 + len;
    }
    expect(p).toBe(extraEnd);
    layers.push({ top, left, bottom, right, chans, blend, flags, name, uname });
  }
  const data: Uint8Array[][] = [];
  for (const l of layers) {
    const planes = [];
    for (const c of l.chans) {
      expect(v.getUint16(p)).toBe(0);
      planes.push(buf.slice(p + 2, p + c.len));
      p += c.len;
    }
    data.push(planes);
  }
  expect(p + (liEnd - p)).toBe(liEnd);
  expect(liEnd - p).toBeLessThan(2);
  p = liEnd;
  expect(v.getUint32(p)).toBe(0);
  p += 4;
  expect(p).toBe(lmEnd);
  const compression = v.getUint16(p);
  p += 2;
  const merged = buf.slice(p);
  return { header, count, layers, data, compression, merged };
}

describe("writePsd", () => {
  it("writes a parseable RGB PSD with layers bottom to top and the merged image", () => {
    const back = {
      name: "back hair",
      left: 2,
      top: 1,
      width: 3,
      height: 2,
      rgba: rgba(3, 2, 1),
    };
    const front = {
      name: "face",
      left: 0,
      top: 0,
      width: 2,
      height: 2,
      rgba: rgba(2, 2, 5),
      hidden: true,
    };
    const composite = rgba(5, 4, 9);
    const out = writePsd({
      width: 5,
      height: 4,
      layers: [back, front],
      composite,
    });
    const psd = readPsd(out);
    expect(psd.header).toEqual({
      sig: "8BPS",
      version: 1,
      channels: 4,
      height: 4,
      width: 5,
      depth: 8,
      mode: 3,
    });
    expect(psd.count).toBe(-2);
    expect(psd.layers.map((l) => l.name)).toEqual(["back hair", "face"]);
    expect(psd.layers.map((l) => l.uname)).toEqual(["back hair", "face"]);
    expect(psd.layers[0]).toMatchObject({
      top: 1,
      left: 2,
      bottom: 3,
      right: 5,
      blend: "8BIMnorm",
      flags: 0,
    });
    expect(psd.layers[1].flags & 2).toBe(2);
    expect(psd.layers[0].chans.map((c) => c.id)).toEqual([-1, 0, 1, 2]);
    // Alpha plane, then red.
    expect(Array.from(psd.data[0][0])).toEqual(
      [3, 7, 11, 15, 19, 23].map((i) => back.rgba[i]),
    );
    expect(Array.from(psd.data[0][1])).toEqual(
      [0, 4, 8, 12, 16, 20].map((i) => back.rgba[i]),
    );
    expect(psd.compression).toBe(0);
    expect(psd.merged.length).toBe(5 * 4 * 4);
    expect(psd.merged[0]).toBe(composite[0]);
    expect(psd.merged[20]).toBe(composite[1]);
    expect(psd.merged[60]).toBe(composite[3]);
  });

  it("keeps unicode names in luni and ASCII-folds the Pascal name", () => {
    const out = writePsd({
      width: 1,
      height: 1,
      layers: [
        {
          name: "瞳 left",
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          rgba: rgba(1, 1, 0),
        },
      ],
      composite: rgba(1, 1, 0),
    });
    const psd = readPsd(out);
    expect(psd.layers[0].name).toBe("? left");
    expect(psd.layers[0].uname).toBe("瞳 left");
  });

  it("handles empty layers and rejects bad input", () => {
    const out = writePsd({
      width: 2,
      height: 2,
      layers: [
        {
          name: "empty",
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          rgba: new Uint8Array(0),
        },
      ],
      composite: rgba(2, 2, 0),
    });
    expect(readPsd(out).layers[0].chans.every((c) => c.len === 2)).toBe(true);
    expect(() =>
      writePsd({ width: 0, height: 2, layers: [], composite: rgba(2, 2, 0) }),
    ).toThrow(PsdError);
    expect(() =>
      writePsd({
        width: 2,
        height: 2,
        layers: [
          {
            name: "x",
            left: 0,
            top: 0,
            width: 2,
            height: 2,
            rgba: rgba(1, 1, 0),
          },
        ],
        composite: rgba(2, 2, 0),
      }),
    ).toThrow(PsdError);
  });
});

describe("layerBlenderScript", () => {
  const layers = [
    {
      name: "back hair",
      path: "parts/back hair.png",
      left: 0,
      top: 0,
      width: 100,
      height: 200,
      depthMedian: 0.9,
    },
    {
      name: 'face "x"',
      path: "parts/face x.png",
      left: 50,
      top: 20,
      width: 40,
      height: 40,
      depthMedian: 0.2,
    },
  ];
  const py = layerBlenderScript({
    canvasWidth: 200,
    canvasHeight: 200,
    layers,
  });

  it("lists every part with relative paths resolved from the script folder", () => {
    expect(py).toContain('"parts/back hair.png"');
    expect(py).toContain('"parts/face x.png"');
    expect(py).toContain('"face \\"x\\""');
    expect(py).toContain('os.path.join(base, *rel.split("/"))');
    expect(py).toContain('SCRIPT_NAME = "import_layers.py"');
    expect(py).not.toMatch(/\/Users\/|C:\\\\/);
    expect(py).toContain('data.type = "ORTHO"');
    expect(py).toContain("use_backface_culling = True");
  });

  it("pushes farther parts further down -Z", () => {
    const back = layerPlacement(layers[0], 200, 200, 0.01, 1);
    const face = layerPlacement(layers[1], 200, 200, 0.01, 1);
    expect(back.z).toBeCloseTo(-0.9);
    expect(face.z).toBeCloseTo(-0.2);
    expect(back.z).toBeLessThan(face.z);
    expect(back).toMatchObject({ x: -0.5, y: 0, w: 1, h: 2 });
    expect(py).toContain('"parts/back hair.png", -0.5, 0, -0.9, 1, 2, 0)');
    expect(py).toContain("-0.2");
  });
});

describe("writeZipBytes", () => {
  it("matches zlib crc32 and round-trips through the zip reader", () => {
    const bin = new Uint8Array(1000).map((_, i) => (i * 31) & 255);
    expect(crc32Bytes(bin)).toBe(crc32(bin) >>> 0);
    expect(crc32Bytes(new Uint8Array(0))).toBe(0);
    const zip = writeZipBytes([
      { name: "parts/back hair.png", data: bin },
      { name: "README.txt", data: "héllo" },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ["parts/back hair.png", 0, 1000],
      ["README.txt", 0, 6],
    ]);
    expect(
      Buffer.from(readZipEntry(zip, entries[0])).equals(Buffer.from(bin)),
    ).toBe(true);
    expect(readZipEntry(zip, entries[1]).toString("utf8")).toBe("héllo");
  });

  it("rejects traversal and duplicates", () => {
    expect(() => writeZipBytes([{ name: "../x", data: "" }])).toThrow(
      ZipWriteError,
    );
    expect(() => writeZipBytes([{ name: "/x", data: "" }])).toThrow(
      ZipWriteError,
    );
    expect(() =>
      writeZipBytes([
        { name: "a", data: "" },
        { name: "a", data: "" },
      ]),
    ).toThrow(ZipWriteError);
  });
});

describe("layerBundleFiles", () => {
  const manifest = parseLayerManifest({
    prefix: "adrift_layers",
    timestamp: "1",
    layers: [
      {
        name: "back hair",
        filename: "a_back hair.png",
        left: 0,
        top: 0,
        right: 2,
        bottom: 2,
        depth_median: 0.8,
      },
    ],
  });
  const input = {
    manifest,
    canvas: { width: 4, height: 4 },
    parts: [
      {
        name: "back hair",
        left: 0,
        top: 0,
        width: 2,
        height: 2,
        depthMedian: 0.8,
        png: new Uint8Array([1]),
        depthPng: new Uint8Array([2]),
      },
      {
        name: "back hair",
        left: 1,
        top: 1,
        width: 2,
        height: 2,
        depthMedian: 0.3,
        png: new Uint8Array([3]),
        depthPng: null,
      },
    ],
    compositePng: new Uint8Array([4]),
    psd: new Uint8Array([5]),
  };

  it("all: parts, depth, json, psd, composite, script, readme", () => {
    const names = layerBundleFiles("all", input).map((f) => f.name);
    expect(names).toEqual([
      "parts/back hair.png",
      "depth/back hair_depth.png",
      "parts/back hair_2.png",
      "layers.json",
      "layers.psd",
      "composite.png",
      "import_layers.py",
      "layers.glb",
      "README.txt",
    ]);
    const files = layerBundleFiles("all", input);
    const readme = String(files.find((f) => f.name === "README.txt")!.data);
    expect(readme).toContain(
      "Layers by see-through (shitagaki-lab, MIT node pack; weights RAIL++-M)",
    );
    expect(readme).toContain("approximate");
    const json = JSON.parse(
      String(files.find((f) => f.name === "layers.json")!.data),
    );
    expect(json.layers[1]).toMatchObject({
      file: "parts/back hair_2.png",
      depth_file: null,
      right: 3,
    });
    expect(() => writeZipBytes(files)).not.toThrow();
  });

  it("parts and blender variants", () => {
    expect(layerBundleFiles("parts", input).map((f) => f.name)).not.toContain(
      "import_layers.py",
    );
    const blender = layerBundleFiles("blender", input).map((f) => f.name);
    expect(blender).toContain("import_layers.py");
    expect(blender).toContain("layers.glb");
    expect(blender).not.toContain("layers.psd");
    // Depth maps ship so the script can add relief.
    expect(blender).toContain("depth/back hair_depth.png");
  });
});
