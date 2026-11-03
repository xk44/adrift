/**
 * ComfyUI input-spec normalization
 * Turns raw `/object_info` input specs (`[type, options]`) into a flat,
 * UI-friendly `InputSpecMeta`, including the modern / V3 options the
 * ComfyUI frontend honors:
 *
 *   tooltip, advanced, hidden, round/step, control_after_generate,
 *   image_upload / video_upload / audio_upload / file_upload, multiline,
 *   dynamicPrompts, remote combos, COMFY_DYNAMICCOMBO_V3,
 *   COMFY_AUTOGROW_V3, COMFY_DYNAMICGROUP_V3.
 *
 * Also hosts the pure helpers those options need at run time
 * (numeric rounding, control_after_generate stepping, dynamic-prompt
 * expansion) so they can be unit-tested without React.
 *
 * Dotted API keys follow comfy_api/latest/_io.py:
 *   DynamicCombo  → `parent` holds the selected key, children `parent.child`
 *   Autogrow      → `parent.<prefix><i>` or `parent.<name>`
 *   DynamicGroup  → `parent.<row>.<field>`
 */

// Raw object_info shapes

export type RawInputSpec = unknown[];

export interface RawInputSection {
  required?: Record<string, RawInputSpec>;
  optional?: Record<string, RawInputSpec>;
  hidden?: Record<string, unknown>;
}

export interface ObjectInfoNodeDef {
  input?: RawInputSection;
  input_order?: { required?: string[]; optional?: string[] };
  display_name?: string;
  [key: string]: unknown;
}

export type ObjectInfoIndex = Record<string, ObjectInfoNodeDef>;

// Normalized meta

export type UploadKind = "image" | "video" | "audio" | "file";
export type ControlAfterGenerateMode =
  "fixed" | "increment" | "decrement" | "randomize";

export const CONTROL_AFTER_GENERATE_MODES: ControlAfterGenerateMode[] = [
  "fixed",
  "increment",
  "decrement",
  "randomize",
];

export interface RemoteSpec {
  route: string;
  refreshButton: boolean;
  controlAfterRefresh?: "first" | "last";
  /** Optional auto-refresh interval (ms) declared by the node. */
  refresh?: number;
}

export interface DynamicComboOption {
  key: string;
  /** Child specs (required + optional merged; required wins on clash). */
  inputs: Record<string, RawInputSpec>;
}

export interface AutogrowSpec {
  prefix?: string;
  names?: string[];
  min: number;
  max?: number;
  /** The single template input name + spec each slot repeats. */
  templateName?: string;
  templateSpec?: RawInputSpec;
}

export interface DynamicGroupSpec {
  template: Record<string, RawInputSpec>;
  min: number;
  max?: number;
  groupName?: string;
}

export const DYNAMIC_COMBO_TYPE = "COMFY_DYNAMICCOMBO_V3";
export const AUTOGROW_TYPE = "COMFY_AUTOGROW_V3";
export const DYNAMIC_GROUP_TYPE = "COMFY_DYNAMICGROUP_V3";
export const MATCHTYPE_TYPE = "COMFY_MATCHTYPE_V3";

/** Widget (value-carrying) types the panel knows how to edit. */
const WIDGET_TYPES = new Set([
  "INT",
  "FLOAT",
  "STRING",
  "BOOLEAN",
  "COMBO",
  DYNAMIC_COMBO_TYPE,
]);

/** Container types whose children are addressed by dotted keys. */
const CONTAINER_TYPES = new Set([AUTOGROW_TYPE, DYNAMIC_GROUP_TYPE]);

export interface InputSpecMeta {
  /** Normalized type: INT/FLOAT/STRING/BOOLEAN/COMBO/V3 type/link type. */
  type: string;
  /** True when the panel has a dedicated editor for this type. */
  isWidget: boolean;
  /** True for socket/link types (MODEL, IMAGE, …) and `forceInput`. */
  isLink: boolean;
  /** True when the type is not one this module understands at all. */
  unknownType: boolean;
  section: "required" | "optional";
  tooltip?: string;
  displayName?: string;
  advanced: boolean;
  hidden: boolean;
  forceInput: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** FLOAT precision unit (`round`); `false` disables rounding. */
  round?: number | false;
  controlAfterGenerate: boolean;
  upload?: UploadKind;
  imageFolder?: string;
  multiline: boolean;
  dynamicPrompts: boolean;
  placeholder?: string;
  labelOn?: string;
  labelOff?: string;
  options?: string[];
  multiselect?: boolean;
  remote?: RemoteSpec;
  dynamicOptions?: DynamicComboOption[];
  autogrow?: AutogrowSpec;
  dynamicGroup?: DynamicGroupSpec;
}

/** Largest seed the ComfyUI frontend will pick when randomizing (2^50). */
export const MAX_RANDOM_SEED = 1125899906842624;

/** Link/socket types: all-caps identifiers that aren't widget types. */
function isSocketTypeName(t: string): boolean {
  if (t === "*") return true;
  // Unrecognized V3 io types (COMFY_<NAME>_V<n>) are widgets/containers we
  // don't know yet, not sockets — let the UI degrade instead of hiding them.
  if (/^COMFY_[A-Z0-9_]+_V\d+$/.test(t)) return false;
  // "FLOAT,INT,BOOLEAN" style union sockets
  return /^[A-Z0-9_]+(,[A-Z0-9_]+)*$/.test(t) && !WIDGET_TYPES.has(t);
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clampSafe(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (v > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (v < Number.MIN_SAFE_INTEGER) return Number.MIN_SAFE_INTEGER;
  return v;
}

function mergeSections(
  sec:
    | {
        required?: Record<string, RawInputSpec>;
        optional?: Record<string, RawInputSpec>;
      }
    | undefined,
): Record<string, RawInputSpec> {
  if (!sec || typeof sec !== "object") return {};
  return { ...(sec.optional ?? {}), ...(sec.required ?? {}) };
}

/**
 * Normalize one raw object_info input spec. Never throws: anything
 * unrecognized comes back with `unknownType: true` so the UI can degrade
 * to a plain text/readonly control.
 */
export function parseInputSpec(
  raw: unknown,
  section: "required" | "optional" = "required",
): InputSpecMeta {
  const arr = Array.isArray(raw) ? raw : [];
  const head = arr[0];
  const opts: Record<string, unknown> =
    arr[1] && typeof arr[1] === "object" && !Array.isArray(arr[1])
      ? (arr[1] as Record<string, unknown>)
      : {};

  let type: string;
  let options: string[] | undefined;
  if (Array.isArray(head)) {
    // Legacy combo: the option list *is* the type.
    type = "COMBO";
    options = head.map((o) => String(o));
  } else if (typeof head === "string") {
    type = head;
  } else {
    type = "UNKNOWN";
  }

  if (type === "COMBO" && !options && Array.isArray(opts.options)) {
    options = (opts.options as unknown[]).map((o) => String(o));
  }

  const meta: InputSpecMeta = {
    type,
    isWidget: WIDGET_TYPES.has(type),
    isLink: false,
    unknownType: false,
    section,
    advanced: opts.advanced === true,
    hidden: opts.hidden === true,
    forceInput: opts.forceInput === true,
    controlAfterGenerate: opts.control_after_generate === true,
    multiline: opts.multiline === true,
    dynamicPrompts: opts.dynamicPrompts === true,
  };

  if (typeof opts.tooltip === "string" && opts.tooltip.trim()) {
    meta.tooltip = opts.tooltip.trim();
  }
  if (typeof opts.display_name === "string")
    meta.displayName = opts.display_name;
  if ("default" in opts) meta.defaultValue = opts.default;
  meta.min = clampSafe(asNumber(opts.min));
  meta.max = clampSafe(asNumber(opts.max));
  meta.step = asNumber(opts.step);
  if (opts.round === false) meta.round = false;
  else if (asNumber(opts.round) !== undefined && (opts.round as number) > 0) {
    meta.round = opts.round as number;
  }
  if (typeof opts.placeholder === "string") meta.placeholder = opts.placeholder;
  if (typeof opts.label_on === "string") meta.labelOn = opts.label_on;
  if (typeof opts.label_off === "string") meta.labelOff = opts.label_off;
  if (typeof opts.multiselect === "boolean")
    meta.multiselect = opts.multiselect;
  if (options) meta.options = options;

  if (opts.image_upload === true) meta.upload = "image";
  else if (opts.video_upload === true) meta.upload = "video";
  else if (opts.audio_upload === true) meta.upload = "audio";
  else if (opts.file_upload === true) meta.upload = "file";
  if (typeof opts.image_folder === "string")
    meta.imageFolder = opts.image_folder;

  if (opts.remote && typeof opts.remote === "object") {
    const r = opts.remote as Record<string, unknown>;
    if (typeof r.route === "string" && r.route) {
      meta.remote = {
        route: r.route,
        refreshButton: r.refresh_button === true,
        controlAfterRefresh:
          r.control_after_refresh === "first" ||
          r.control_after_refresh === "last"
            ? r.control_after_refresh
            : undefined,
        refresh: asNumber(r.refresh),
      };
    }
  }

  if (type === DYNAMIC_COMBO_TYPE) {
    const list = Array.isArray(opts.options) ? opts.options : [];
    meta.dynamicOptions = list
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({
        key: String(o.key ?? ""),
        inputs: mergeSections(o.inputs as RawInputSection | undefined),
      }));
    meta.options = meta.dynamicOptions.map((o) => o.key);
  } else if (type === AUTOGROW_TYPE) {
    const tpl = (opts.template ?? {}) as Record<string, unknown>;
    const inputs = mergeSections(tpl.input as RawInputSection | undefined);
    const [templateName, templateSpec] = Object.entries(inputs)[0] ?? [];
    meta.autogrow = {
      prefix: typeof tpl.prefix === "string" ? tpl.prefix : undefined,
      names: Array.isArray(tpl.names) ? tpl.names.map(String) : undefined,
      min: asNumber(tpl.min) ?? 0,
      max: asNumber(tpl.max),
      templateName,
      templateSpec,
    };
  } else if (type === DYNAMIC_GROUP_TYPE) {
    const tpl = (opts.template ?? {}) as RawInputSection;
    meta.dynamicGroup = {
      template: mergeSections(tpl),
      min: asNumber(opts.min) ?? 0,
      max: asNumber(opts.max),
      groupName:
        typeof opts.group_name === "string" ? opts.group_name : undefined,
    };
  }

  if (meta.forceInput) {
    meta.isLink = true;
    meta.isWidget = false;
  } else if (!meta.isWidget && !CONTAINER_TYPES.has(type)) {
    if (type === MATCHTYPE_TYPE || isSocketTypeName(type)) {
      meta.isLink = true;
    } else {
      meta.unknownType = true;
    }
  }

  return meta;
}

// Index lookups (incl. dotted V3 keys)

export interface ResolvedInputSpec {
  meta: InputSpecMeta;
  /** Top-level input that owns this (dotted) key. */
  rootKey: string;
  /** Immediate dynamic-combo parent key (full dotted path), if any. */
  dynamicParent?: string;
  /** The option key of `dynamicParent` this input belongs to. */
  dynamicOption?: string;
  /** Container (autogrow / dynamic group) key, if any. */
  container?: { key: string; kind: "autogrow" | "dynamic_group"; slot: string };
  /** Human label for dotted keys, e.g. "LoRA 1 · strength". */
  pathLabel?: string;
}

function topLevelSpecs(
  def: ObjectInfoNodeDef | undefined,
): Array<[string, RawInputSpec, "required" | "optional"]> {
  if (!def?.input) return [];
  const out: Array<[string, RawInputSpec, "required" | "optional"]> = [];
  for (const [k, v] of Object.entries(def.input.required ?? {}))
    out.push([k, v, "required"]);
  for (const [k, v] of Object.entries(def.input.optional ?? {}))
    out.push([k, v, "optional"]);
  return out;
}

function humanize(seg: string): string {
  return seg.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve the spec for `inputKey` on `classType`. Dotted keys are walked
 * through dynamic combos (using the parent's current value from
 * `values`), autogrow slots and dynamic-group rows. Returns null when the
 * class or key is not in the index.
 */
export function resolveInputSpec(
  index: ObjectInfoIndex | null | undefined,
  classType: string,
  inputKey: string,
  values: Record<string, unknown> = {},
): ResolvedInputSpec | null {
  const def = index?.[classType];
  if (!def) return null;
  const segs = inputKey.split(".");
  const top = topLevelSpecs(def).find(([k]) => k === segs[0]);
  if (!top) return null;

  let meta = parseInputSpec(top[1], top[2]);
  let path = segs[0];
  const result: ResolvedInputSpec = { meta, rootKey: segs[0] };
  const labelParts: string[] = [];

  let i = 1;
  while (i < segs.length) {
    const seg = segs[i];
    if (meta.type === DYNAMIC_COMBO_TYPE && meta.dynamicOptions) {
      const selected = values[path];
      const ordered = [
        ...meta.dynamicOptions.filter((o) => o.key === selected),
        ...meta.dynamicOptions.filter((o) => o.key !== selected),
      ];
      const hit = ordered.find((o) => seg in o.inputs);
      if (!hit) return null;
      result.dynamicParent = path;
      result.dynamicOption = hit.key;
      meta = parseInputSpec(hit.inputs[seg], "required");
      path = `${path}.${seg}`;
      labelParts.push(humanize(seg));
      i += 1;
    } else if (meta.type === AUTOGROW_TYPE && meta.autogrow) {
      const ag = meta.autogrow;
      const valid = ag.names
        ? ag.names.includes(seg)
        : ag.prefix !== undefined &&
          seg.startsWith(ag.prefix) &&
          /^\d+$/.test(seg.slice(ag.prefix.length));
      if (!valid || !ag.templateSpec) return null;
      result.container = { key: path, kind: "autogrow", slot: seg };
      meta = parseInputSpec(ag.templateSpec, "optional");
      path = `${path}.${seg}`;
      labelParts.push(seg);
      i += 1;
    } else if (meta.type === DYNAMIC_GROUP_TYPE && meta.dynamicGroup) {
      const row = seg;
      const field = segs[i + 1];
      if (
        !/^\d+$/.test(row) ||
        !field ||
        !(field in meta.dynamicGroup.template)
      )
        return null;
      result.container = { key: path, kind: "dynamic_group", slot: row };
      const groupName = meta.dynamicGroup.groupName ?? humanize(path);
      labelParts.push(`${groupName} ${Number(row) + 1}`, humanize(field));
      meta = parseInputSpec(meta.dynamicGroup.template[field], "required");
      path = `${path}.${row}.${field}`;
      i += 2;
    } else {
      return null;
    }
  }

  result.meta = meta;
  if (labelParts.length > 0) result.pathLabel = labelParts.join(" · ");
  return result;
}

/**
 * Children of the currently selected option of a dynamic combo, as
 * `[dottedKey, meta]` pairs. Used to synthesize controls for options the
 * saved workflow didn't include.
 */
export function dynamicComboChildren(
  meta: InputSpecMeta,
  parentKey: string,
  selected: unknown,
): Array<[string, InputSpecMeta]> {
  const opt = meta.dynamicOptions?.find((o) => o.key === selected);
  if (!opt) return [];
  return Object.entries(opt.inputs).map(([k, spec]) => [
    `${parentKey}.${k}`,
    parseInputSpec(spec, "required"),
  ]);
}

/**
 * Trim a full object_info payload to the given classes (and optionally
 * cap long option lists) for fixtures / lean API responses.
 */
export function trimObjectInfo(
  oi: ObjectInfoIndex,
  classes: Iterable<string>,
  maxOptions = Infinity,
): ObjectInfoIndex {
  const cap = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      if (x.length > maxOptions && x.every((v) => typeof v === "string")) {
        return x.slice(0, maxOptions);
      }
      return x.map(cap);
    }
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).map(([k, v]) => [
          k,
          cap(v),
        ]),
      );
    }
    return x;
  };
  const out: ObjectInfoIndex = {};
  for (const c of classes) {
    const def = oi[c];
    if (!def) continue;
    out[c] = {
      input: cap(def.input) as RawInputSection,
      input_order: def.input_order,
      display_name: def.display_name,
    };
  }
  return out;
}

// Runtime helpers

function decimalsOf(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = n.toExponential();
  const [mant, exp] = s.split("e");
  const mantDecimals = (mant.split(".")[1] ?? "").length;
  return Math.max(0, mantDecimals - Number(exp));
}

/**
 * Round a numeric value the way the ComfyUI frontend does before
 * queueing: INT → integer snapped to `step` from `min`; FLOAT → multiple
 * of `round` (defaults to `step`; `round: false` disables), then clamped.
 */
export function roundNumeric(
  value: number,
  spec: {
    type?: string;
    min?: number;
    max?: number;
    step?: number;
    round?: number | false;
  },
): number {
  if (!Number.isFinite(value)) return value;
  let v = value;
  if (spec.type === "INT") {
    v = Math.round(v);
    const step = spec.step && spec.step > 1 ? Math.round(spec.step) : 1;
    if (step > 1) {
      const base = spec.min ?? 0;
      v = base + Math.round((v - base) / step) * step;
    }
  } else if (spec.type === "FLOAT") {
    const unit = spec.round === false ? undefined : (spec.round ?? spec.step);
    if (unit && unit > 0) {
      v = Math.round(v / unit) * unit;
      v = Number(v.toFixed(Math.min(20, decimalsOf(unit))));
    }
  }
  if (spec.min !== undefined && v < spec.min) v = spec.min;
  if (spec.max !== undefined && v > spec.max) v = spec.max;
  return v;
}

/**
 * Value to use on the *next* run for a control_after_generate widget.
 * Mirrors ComfyUI: step by `step` (default 1), clamp to [min, max];
 * randomize picks from [min, min(max, 2^50)].
 */
export function nextControlValue(
  value: number,
  mode: ControlAfterGenerateMode,
  spec: { min?: number; max?: number; step?: number } = {},
  rng: () => number = Math.random,
): number {
  const min = spec.min ?? 0;
  const max = spec.max ?? Number.MAX_SAFE_INTEGER;
  const step = spec.step && spec.step > 0 ? spec.step : 1;
  let v = Number.isFinite(value) ? value : min;
  switch (mode) {
    case "fixed":
      return v;
    case "increment":
      v += step;
      break;
    case "decrement":
      v -= step;
      break;
    case "randomize": {
      const hi = Math.min(max, MAX_RANDOM_SEED);
      const range = Math.max(0, Math.floor((hi - min) / step));
      v = min + Math.floor(rng() * (range + 1)) * step;
      break;
    }
  }
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

/** Strip `// line` and block comments the way the ComfyUI frontend does. */
export function stripPromptComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

/**
 * Expand `{a|b|{c|d}}` dynamic-prompt syntax (ComfyUI frontend
 * semantics): comments stripped, nested groups resolved, escapes like
 * `\{` kept verbatim (backslash included) so CLIP weight escapes such as
 * `\(` survive. Unbalanced `{` is left as literal text.
 */
export function expandDynamicPrompt(
  text: string,
  rng: () => number = Math.random,
): string {
  const input = stripPromptComments(text);
  let pos = 0;

  // Parse until `stop` chars at this depth; returns the expanded text.
  function parseSequence(inGroup: boolean): {
    text: string;
    stoppedAt: string | null;
  } {
    let out = "";
    while (pos < input.length) {
      const ch = input[pos];
      if (ch === "\\" && pos + 1 < input.length) {
        out += ch + input[pos + 1];
        pos += 2;
        continue;
      }
      if (inGroup && (ch === "|" || ch === "}")) {
        return { text: out, stoppedAt: ch };
      }
      if (ch === "{") {
        const start = pos;
        pos += 1;
        const choices: string[] = [];
        let closed = false;
        while (pos <= input.length) {
          const part = parseSequence(true);
          choices.push(part.text);
          if (part.stoppedAt === "|") {
            pos += 1;
            continue;
          }
          if (part.stoppedAt === "}") {
            pos += 1;
            closed = true;
          }
          break;
        }
        if (!closed) {
          // Unbalanced: emit the raw remainder literally.
          out += input.slice(start);
          pos = input.length;
          return { text: out, stoppedAt: null };
        }
        out +=
          choices[
            Math.min(choices.length - 1, Math.floor(rng() * choices.length))
          ];
        continue;
      }
      out += ch;
      pos += 1;
    }
    return { text: out, stoppedAt: null };
  }

  return parseSequence(false).text;
}

/** True when `text` contains at least one `{…|…}` choice group. */
export function hasDynamicPromptSyntax(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return /(^|[^\\])\{[^{}]*\|/.test(text) || /(^|[^\\])\{[\s\S]*\{/.test(text);
}
