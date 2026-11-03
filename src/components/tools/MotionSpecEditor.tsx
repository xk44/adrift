"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Plus,
  Trash2,
} from "lucide-react";
import {
  BACKGROUNDS,
  ELEMENT_SCHEMAS,
  ELEMENT_TYPES,
  LIMITS,
  TRANSITIONS,
  defaultElement,
  parseSpecText,
  type ElementType,
  type Field,
  type MotionElement,
  type MotionScene,
  type MotionSpec,
  type SpecIssue,
} from "@/lib/motion/spec";

const input =
  "w-full rounded-lg border border-light-100 dark:border-dark-750 bg-white dark:bg-dark-900 px-2 py-1.5 text-xs text-light-primary dark:text-dark-primary focus:border-splash focus:outline-none";
const label = "block space-y-1 text-[11px] text-light-500 dark:text-dark-400";
const iconBtn =
  "rounded-md p-1 text-light-500 dark:text-dark-400 hover:text-splash disabled:opacity-30";

const TYPE_LABEL: Record<ElementType, string> = {
  text: "Text",
  lowerThird: "Lower third",
  shape: "Shape",
  icon: "Icon",
  figure: "Stick figure",
  chart: "Chart",
  counter: "Counter",
  list: "List",
  arrow: "Arrow",
};

/** Keys shown first (content), the rest go under "Timing & position". */
const PRIMARY: Record<ElementType, string[]> = {
  text: ["text", "anim", "size", "weight", "align", "font"],
  lowerThird: ["title", "subtitle", "side"],
  shape: ["shape", "anim", "w", "h", "fill", "opacity", "rotation"],
  icon: ["icon", "anim", "size", "badge"],
  figure: ["pose", "say", "facing", "size"],
  chart: ["chart", "data", "unit", "w", "h"],
  counter: ["to", "from", "decimals", "prefix", "suffix", "label", "size"],
  list: ["items", "style", "size", "gap", "maxWidth"],
  arrow: ["x2", "y2", "curve"],
};

export function summarize(el: MotionElement): string {
  switch (el.type) {
    case "text":
      return el.text.replace(/\*/g, "");
    case "lowerThird":
      return `${el.title}${el.subtitle ? ` · ${el.subtitle}` : ""}`;
    case "shape":
      return `${el.shape} · ${el.anim}`;
    case "icon":
      return `${el.icon} · ${el.anim}`;
    case "figure":
      return `${el.pose}${el.say ? ` · "${el.say}"` : ""}`;
    case "chart":
      return `${el.chart} · ${el.data.length} values`;
    case "counter":
      return `${el.prefix}${el.to}${el.suffix}`;
    case "list":
      return el.items.join(" / ");
    case "arrow":
      return "arrow";
  }
}

function stepFor(f: Extract<Field, { t: "num" }>): number {
  if (f.int) return 1;
  const span = f.max - f.min;
  return span <= 2 ? 0.01 : span <= 30 ? 0.1 : 1;
}

function FieldInput({
  name,
  field,
  value,
  onChange,
}: {
  name: string;
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `mf-${name}`;
  switch (field.t) {
    case "num":
      return (
        <label className={label} htmlFor={id}>
          <span>{name}</span>
          <input
            id={id}
            type="number"
            className={input}
            min={field.min}
            max={field.max}
            step={stepFor(field)}
            value={typeof value === "number" ? value : ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (e.target.value === "" || !Number.isFinite(n)) return;
              onChange(Math.min(field.max, Math.max(field.min, n)));
            }}
          />
        </label>
      );
    case "str":
      return (
        <label
          className={`${label} ${field.max > 100 ? "col-span-2" : ""}`}
          htmlFor={id}
        >
          <span>{name}</span>
          {field.max > 100 ? (
            <textarea
              id={id}
              rows={2}
              className={input}
              maxLength={field.max}
              value={String(value ?? "")}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              id={id}
              className={input}
              maxLength={field.max}
              value={String(value ?? "")}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </label>
      );
    case "enum":
      return (
        <label className={label} htmlFor={id}>
          <span>{name}</span>
          <select
            id={id}
            className={input}
            value={String(value ?? "")}
            onChange={(e) => {
              const raw = e.target.value;
              const match = field.values.find((v) => String(v) === raw);
              onChange(match ?? raw);
            }}
          >
            {field.values.map((v) => (
              <option key={String(v)} value={String(v)}>
                {v === "" ? "theme" : String(v)}
              </option>
            ))}
          </select>
        </label>
      );
    case "color":
      return (
        <label className={label} htmlFor={id}>
          <span>{name}</span>
          <span className="flex items-center gap-1.5">
            <input
              id={id}
              type="color"
              className="h-7 w-9 cursor-pointer rounded border border-light-100 dark:border-dark-750 bg-transparent"
              value={typeof value === "string" && value ? value : "#ffffff"}
              onChange={(e) => onChange(e.target.value)}
            />
            {field.allowEmpty && (
              <button
                type="button"
                className="text-[11px] text-light-500 dark:text-dark-400 hover:text-splash"
                onClick={() => onChange("")}
              >
                {value ? "use theme" : "theme"}
              </button>
            )}
          </span>
        </label>
      );
    case "bool":
      return (
        <label className="flex items-center gap-2 self-end pb-1.5 text-[11px] text-light-500 dark:text-dark-400">
          <input
            type="checkbox"
            className="accent-splash"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {name}
        </label>
      );
    case "strs":
      return (
        <label className={`${label} col-span-2`} htmlFor={id}>
          <span>{name} (one per line)</span>
          <textarea
            id={id}
            rows={Math.min(
              6,
              Math.max(2, Array.isArray(value) ? value.length : 2),
            )}
            className={input}
            value={Array.isArray(value) ? value.join("\n") : ""}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split("\n")
                  .slice(0, field.max)
                  .map((l) => l.slice(0, field.itemMax)),
              )
            }
            onBlur={(e) => {
              const items = e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
              onChange(items.length ? items : ["Point"]);
            }}
          />
        </label>
      );
    case "list": {
      const rows = Array.isArray(value)
        ? (value as { label: string; value: number }[])
        : [];
      return (
        <DataField
          id={id}
          name={name}
          rows={rows}
          max={field.max}
          onChange={onChange}
        />
      );
    }
    default:
      return null;
  }
}

/** Chart data as "label = value" lines, parsed on blur. */
function DataField({
  id,
  name,
  rows,
  max,
  onChange,
}: {
  id: string;
  name: string;
  rows: { label: string; value: number }[];
  max: number;
  onChange: (v: unknown) => void;
}) {
  const text = rows.map((r) => `${r.label} = ${r.value}`).join("\n");
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <label className={`${label} col-span-2`} htmlFor={id}>
      <span>{name} (label = value, one per line)</span>
      <textarea
        id={id}
        rows={Math.min(8, Math.max(2, rows.length))}
        className={`${input} font-mono`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const parsed = draft
            .split("\n")
            .map((l) => /^(.*?)\s*[=:]\s*(-?[\d.]+)\s*$/.exec(l.trim()))
            .filter(
              (m): m is RegExpExecArray => !!m && Number.isFinite(Number(m[2])),
            )
            .slice(0, max)
            .map((m) => ({ label: m[1].slice(0, 24), value: Number(m[2]) }));
          if (parsed.length) onChange(parsed);
          else setDraft(text);
        }}
      />
    </label>
  );
}

function ElementEditor({
  el,
  index,
  count,
  onChange,
  onRemove,
  onMove,
}: {
  el: MotionElement;
  index: number;
  count: number;
  onChange: (el: MotionElement) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const schema = ELEMENT_SCHEMAS[el.type];
  const primary = PRIMARY[el.type].filter((k) => k in schema);
  const rest = Object.keys(schema).filter((k) => !primary.includes(k));
  const rec = el as unknown as Record<string, unknown>;
  const set = (k: string, v: unknown) =>
    onChange({ ...(el as object), [k]: v } as unknown as MotionElement);
  return (
    <li className="rounded-lg border border-light-100 dark:border-dark-750">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-light-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-light-500" />
          )}
          <span className="font-medium text-light-primary dark:text-dark-primary">
            {TYPE_LABEL[el.type]}
          </span>
          <span className="truncate text-light-500 dark:text-dark-400">
            {summarize(el)}
          </span>
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label="Move element up"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label="Move element down"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconBtn}
          onClick={onRemove}
          aria-label="Remove element"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-light-100 dark:border-dark-750 p-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {primary.map((k) => (
              <FieldInput
                key={k}
                name={k}
                field={schema[k]}
                value={rec[k]}
                onChange={(v) => set(k, v)}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMore((m) => !m)}
            className="text-[11px] text-light-500 dark:text-dark-400 hover:text-splash"
          >
            {more ? "Hide" : "Show"} timing, position & color
          </button>
          {more && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {rest.map((k) => (
                <FieldInput
                  key={k}
                  name={k}
                  field={schema[k]}
                  value={rec[k]}
                  onChange={(v) => set(k, v)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function move<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const out = arr.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function SceneEditor({
  scene,
  index,
  count,
  active,
  onChange,
  onRemove,
  onMove,
  onDuplicate,
  onSeek,
}: {
  scene: MotionScene;
  index: number;
  count: number;
  active: boolean;
  onChange: (s: MotionScene) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate: () => void;
  onSeek: () => void;
}) {
  const [open, setOpen] = useState(index === 0);
  const [adding, setAdding] = useState<ElementType>("text");
  const set = <K extends keyof MotionScene>(k: K, v: MotionScene[K]) =>
    onChange({ ...scene, [k]: v });
  // Label a scene by its words (headline, list, lower third), not décor.
  const CONTENT: ElementType[] = ["text", "lowerThird", "list", "counter", "chart", "figure"];
  const title =
    [...scene.elements]
      .sort((a, b) => Number(!CONTENT.includes(a.type)) - Number(!CONTENT.includes(b.type)))
      .map(summarize)
      .find((s) => s && s !== "arrow") ?? "Empty scene";
  return (
    <li
      className={`rounded-xl border ${active ? "border-splash/60" : "border-light-100 dark:border-dark-750"} bg-white/60 dark:bg-dark-900/40`}
    >
      <div className="flex items-center gap-1 px-3 py-2">
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            onSeek();
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-splash/15 text-[10px] font-semibold text-splash">
            {index + 1}
          </span>
          <span className="truncate text-xs font-medium text-light-primary dark:text-dark-primary">
            {title}
          </span>
          <span className="flex-shrink-0 text-[11px] tabular-nums text-light-500 dark:text-dark-400">
            {scene.duration.toFixed(1)}s
          </span>
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label="Move scene up"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label="Move scene down"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={count >= LIMITS.scenes}
          onClick={onDuplicate}
          aria-label="Duplicate scene"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconBtn}
          disabled={count <= 1}
          onClick={onRemove}
          aria-label="Remove scene"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-light-100 dark:border-dark-750 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className={label}>
              <span>Seconds</span>
              <input
                type="number"
                className={input}
                min={LIMITS.sceneSeconds.min}
                max={LIMITS.sceneSeconds.max}
                step={0.1}
                value={scene.duration}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0)
                    set(
                      "duration",
                      Math.min(
                        LIMITS.sceneSeconds.max,
                        Math.max(LIMITS.sceneSeconds.min, n),
                      ),
                    );
                }}
              />
            </label>
            <label className={label}>
              <span>Transition in</span>
              <select
                className={input}
                value={scene.transition}
                onChange={(e) =>
                  set("transition", e.target.value as MotionScene["transition"])
                }
              >
                {TRANSITIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              <span>Transition s</span>
              <input
                type="number"
                className={input}
                min={0}
                max={3}
                step={0.1}
                value={scene.transitionDur}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n))
                    set("transitionDur", Math.min(3, Math.max(0, n)));
                }}
              />
            </label>
            <label className={label}>
              <span>Background</span>
              <select
                className={input}
                value={scene.background}
                onChange={(e) =>
                  set("background", e.target.value as MotionScene["background"])
                }
              >
                <option value="">same as video</option>
                {BACKGROUNDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={label}>
            <span>Narration (voiceover line)</span>
            <textarea
              rows={2}
              maxLength={300}
              className={input}
              value={scene.narration}
              onChange={(e) => set("narration", e.target.value)}
            />
          </label>
          <ul className="space-y-1.5">
            {scene.elements.map((el, i) => (
              <ElementEditor
                key={`${i}-${el.type}`}
                el={el}
                index={i}
                count={scene.elements.length}
                onChange={(next) =>
                  set(
                    "elements",
                    scene.elements.map((e, k) => (k === i ? next : e)),
                  )
                }
                onRemove={() =>
                  set(
                    "elements",
                    scene.elements.filter((_, k) => k !== i),
                  )
                }
                onMove={(dir) => set("elements", move(scene.elements, i, dir))}
              />
            ))}
          </ul>
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Element type"
              className={`${input} w-auto`}
              value={adding}
              onChange={(e) => setAdding(e.target.value as ElementType)}
            >
              {ELEMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={scene.elements.length >= LIMITS.elements}
              onClick={() =>
                set("elements", [...scene.elements, defaultElement(adding)])
              }
              className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-light-100 dark:border-dark-750 px-2.5 py-1.5 text-xs text-light-500 dark:text-dark-400 hover:border-splash/60 hover:text-splash disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Add element
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Form editor for the scene list. */
export function MotionSceneForm({
  spec,
  activeScene,
  onChange,
  onSeekScene,
}: {
  spec: MotionSpec;
  activeScene: number;
  onChange: (spec: MotionSpec) => void;
  onSeekScene: (index: number) => void;
}) {
  const setScenes = (scenes: MotionScene[]) => onChange({ ...spec, scenes });
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {spec.scenes.map((s, i) => (
          <SceneEditor
            key={i}
            scene={s}
            index={i}
            count={spec.scenes.length}
            active={i === activeScene}
            onChange={(next) =>
              setScenes(spec.scenes.map((x, k) => (k === i ? next : x)))
            }
            onRemove={() => setScenes(spec.scenes.filter((_, k) => k !== i))}
            onMove={(dir) => setScenes(move(spec.scenes, i, dir))}
            onDuplicate={() =>
              setScenes([
                ...spec.scenes.slice(0, i + 1),
                structuredClone(s),
                ...spec.scenes.slice(i + 1),
              ])
            }
            onSeek={() => onSeekScene(i)}
          />
        ))}
      </ul>
      <button
        type="button"
        disabled={spec.scenes.length >= LIMITS.scenes}
        onClick={() =>
          setScenes([
            ...spec.scenes,
            {
              duration: 3,
              background: "",
              transition: "fade",
              transitionDur: 0.6,
              narration: "",
              elements: [defaultElement("text", { text: "New *scene*" })],
            },
          ])
        }
        className="flex items-center gap-1 rounded-lg border border-dashed border-light-100 dark:border-dark-750 px-3 py-2 text-xs text-light-500 dark:text-dark-400 hover:border-splash/60 hover:text-splash disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" /> Add scene
      </button>
    </div>
  );
}

/** Raw JSON editor: strict validation, applied explicitly. */
export function MotionJsonEditor({
  spec,
  onApply,
}: {
  spec: MotionSpec;
  onApply: (spec: MotionSpec) => void;
}) {
  const pretty = JSON.stringify(spec, null, 2);
  const [draft, setDraft] = useState(pretty);
  const [errors, setErrors] = useState<SpecIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(pretty);
  }, [pretty, dirty]);
  const apply = () => {
    const r = parseSpecText(draft, "strict");
    setErrors(r.errors);
    if (r.ok && r.spec) {
      setDirty(false);
      onApply(r.spec);
    }
  };
  return (
    <div className="space-y-2">
      <textarea
        aria-label="Scene spec JSON"
        spellCheck={false}
        className={`${input} h-80 font-mono text-[11px] leading-relaxed`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={!dirty}
          className="rounded-lg bg-splash px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Validate & apply
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(pretty);
            setDirty(false);
            setErrors([]);
          }}
          disabled={!dirty}
          className="rounded-lg border border-light-100 dark:border-dark-750 px-3 py-1.5 text-xs text-light-500 dark:text-dark-400 hover:text-splash disabled:opacity-40"
        >
          Revert
        </button>
        <span className="text-[11px] text-light-500 dark:text-dark-400">
          Strict schema: unknown keys, wrong types and out-of-range values are
          rejected.
        </span>
      </div>
      {errors.length > 0 && (
        <ul
          role="alert"
          className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg bg-red-500/10 p-2 font-mono text-[11px] text-red-500"
        >
          {errors.slice(0, 30).map((e, i) => (
            <li key={i}>
              {e.path || "(root)"}: {e.message}
            </li>
          ))}
          {errors.length > 30 && <li>…and {errors.length - 30} more</li>}
        </ul>
      )}
    </div>
  );
}
