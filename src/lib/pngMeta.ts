/**
 * Client-safe PNG text-chunk reader + Adrift/ComfyUI metadata interpreter.
 * ComfyUI's SaveImage writes tEXt chunks "prompt" (API graph), "workflow"
 * (UI graph) and any extra_pnginfo key (we add "cj"). No dependencies.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIG.every((b, i) => bytes[i] === b);
}

/** Read tEXt and uncompressed iTXt chunks. zTXt/compressed iTXt are skipped. */
export function readPngTextChunks(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPng(bytes)) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const start = pos + 8;
    const end = start + len;
    if (end > bytes.length) break;
    if (type === "tEXt") {
      const data = bytes.subarray(start, end);
      const nul = data.indexOf(0);
      if (nul > 0) {
        out[latin1.decode(data.subarray(0, nul))] = utf8.decode(
          data.subarray(nul + 1),
        );
      }
    } else if (type === "iTXt") {
      const data = bytes.subarray(start, end);
      const nul = data.indexOf(0);
      // keyword\0 compressionFlag compressionMethod lang\0 translated\0 text
      if (nul > 0 && data[nul + 1] === 0) {
        const langEnd = data.indexOf(0, nul + 3);
        const transEnd = langEnd >= 0 ? data.indexOf(0, langEnd + 1) : -1;
        if (transEnd >= 0) {
          out[latin1.decode(data.subarray(0, nul))] = utf8.decode(
            data.subarray(transEnd + 1),
          );
        }
      }
    } else if (type === "IEND") {
      break;
    }
    pos = end + 4; // skip CRC
  }
  return out;
}

export interface CjMeta {
  params?: Record<string, unknown>;
  [k: string]: unknown;
}

export type ImportedMeta =
  | { kind: "cj"; cj: CjMeta; promptText: string | null; workflow?: unknown }
  | { kind: "workflow"; workflow: unknown }
  | { kind: "none" };

function tryJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Decide what to restore from a set of text chunks or a parsed .json file. */
export function interpretMeta(chunks: Record<string, string>): ImportedMeta {
  const cj = tryJson(chunks.cj);
  const workflow = tryJson(chunks.workflow);
  const prompt = tryJson(chunks.prompt);
  const graph = workflow ?? prompt;
  if (isObj(cj)) {
    const params = isObj(cj.params) ? cj.params : undefined;
    const text =
      typeof params?.fullPrompt === "string"
        ? params.fullPrompt
        : typeof params?.prompt === "string"
          ? params.prompt
          : null;
    return {
      kind: "cj",
      cj: { ...cj, params },
      promptText: text,
      workflow: graph,
    };
  }
  if (graph !== undefined) return { kind: "workflow", workflow: graph };
  return { kind: "none" };
}

/** Interpret a dropped file: PNG (chunks) or .json (workflow / API prompt). */
export async function readImportFile(file: File): Promise<ImportedMeta> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPng(bytes)) return interpretMeta(readPngTextChunks(bytes));
  const json = tryJson(utf8.decode(bytes));
  if (isObj(json)) {
    // A saved Adrift export may carry the cj block at top level.
    if (isObj(json.cj) && isObj((json.cj as CjMeta).params)) {
      return interpretMeta({
        cj: JSON.stringify(json.cj),
        workflow: JSON.stringify(json.workflow ?? json),
      });
    }
    return { kind: "workflow", workflow: json };
  }
  return { kind: "none" };
}
