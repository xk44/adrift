import { describe, expect, it } from "vitest";
import { makeZip } from "./fixtures/userToolsZip";
import {
  isZip,
  listZipEntries,
  readZipEntry,
  ZipError,
} from "@/lib/userTools/zip";

describe("user tools zip reader", () => {
  it("lists and reads stored and deflated entries", () => {
    const json = Buffer.from(JSON.stringify({ hello: "world".repeat(50) }));
    const zip = makeZip(
      [
        { name: "folder/", data: Buffer.alloc(0), method: 0 },
        { name: "folder/a.json", data: json, method: 8 },
        { name: "b.txt", data: Buffer.from("plain"), method: 0 },
      ],
      "archive comment",
    );
    expect(isZip(zip)).toBe(true);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      "folder/",
      "folder/a.json",
      "b.txt",
    ]);
    expect(entries[0].isDirectory).toBe(true);
    expect(readZipEntry(zip, entries[1]).toString()).toBe(json.toString());
    expect(readZipEntry(zip, entries[2]).toString()).toBe("plain");
  });

  it("works on a Uint8Array view", () => {
    const zip = makeZip([{ name: "x.json", data: Buffer.from("{}") }]);
    const view = new Uint8Array(
      zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length),
    );
    const [e] = listZipEntries(view);
    expect(readZipEntry(view, e).toString()).toBe("{}");
  });

  it("rejects non-zips and truncated archives", () => {
    expect(isZip(Buffer.from("{}"))).toBe(false);
    expect(() =>
      listZipEntries(Buffer.from("not a zip at all, definitely not")),
    ).toThrow(ZipError);
    const zip = makeZip([{ name: "x.json", data: Buffer.from("{}") }]);
    // Drop the start of the file so the directory offset points past the end.
    expect(() => listZipEntries(zip.subarray(10))).toThrow(ZipError);
  });

  it("enforces entry size and count caps", () => {
    const big = Buffer.alloc(5000, 65);
    const zip = makeZip([{ name: "big.json", data: big }]);
    const [e] = listZipEntries(zip);
    expect(() => readZipEntry(zip, e, { maxEntryBytes: 100 })).toThrow(
      /too large/,
    );
    const many = makeZip([
      { name: "1.json", data: Buffer.from("1") },
      { name: "2.json", data: Buffer.from("2") },
    ]);
    expect(() => listZipEntries(many, { maxEntries: 1 })).toThrow(/too many/);
  });

  it("refuses a deflate bomb that lies about its size", () => {
    const big = Buffer.alloc(200_000, 0);
    const zip = makeZip([{ name: "bomb.json", data: big }]);
    // Lie in the central directory: claim 10 bytes uncompressed.
    const entries = listZipEntries(zip);
    const lying = { ...entries[0], size: 10 };
    expect(() => readZipEntry(zip, lying, { maxEntryBytes: 1000 })).toThrow(
      ZipError,
    );
  });

  it("reports encrypted and unknown-method entries", () => {
    const zip = makeZip([
      { name: "secret.json", data: Buffer.from("{}"), encrypted: true },
    ]);
    const [e] = listZipEntries(zip);
    expect(() => readZipEntry(zip, e)).toThrow(/encrypted/);
    const odd = { ...e, encrypted: false, method: 12 };
    expect(() => readZipEntry(zip, odd)).toThrow(/unsupported/);
  });
});
