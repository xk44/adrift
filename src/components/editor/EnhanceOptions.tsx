"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { showToast, toastNodeWarnings } from "@/components/Toast";
import { useGenerationStore } from "@/store";
import { useEditorStore } from "@/store/editorStore";
import { editActionFor, type EditLora } from "@/lib/krea2/editLoras";
import { editorMaskDataUrl } from "@/lib/editorMask";
import {
  EDIT_MODES,
  EDIT_MODE_LIST,
  renderEditPrompt,
  type EditModeId,
} from "@/lib/krea2/editModes";

type EditLoraListItem = EditLora & { installed: boolean };

export const DEFAULT_ENHANCE_INSTRUCTION =
  "Enhance this image to high resolution with rich fine details. Sharpen all textures and surfaces, add microdetails and natural grain. Increase clarity and definition across all elements while preserving the original composition, lighting, and atmosphere. Image can be illustration or real photo, keep the original input style.";

type EnhanceMode =
  "detail" | "upscale_detail" | "adetailer" | "adetailer_auto" | "edit";

interface EnhanceOptionsProps {
  initialMode?: EnhanceMode;
}

const MODES: Array<{ id: EnhanceMode; label: string }> = [
  { id: "detail", label: "Detail" },
  { id: "upscale_detail", label: "Upscale + Detail" },
  { id: "adetailer", label: "ADetailer" },
  { id: "adetailer_auto", label: "Auto Refine" },
  { id: "edit", label: "Edit (LoRA)" },
];

const DEFAULTS = {
  faceDenoise: 0.38,
  handDenoise: 0.45,
  bboxThreshold: 0.5,
  cropFactor: 3.0,
  feather: 8,
  // upscale_detail (USDU node 23 in packs/krea2/upscale_detail.json)
  upscaleBy: 2.0,
  tileDenoise: 0.2,
  tileSize: 1024,
};

type WorkflowControlOverrides = Record<string, string | number | boolean>;

export function EnhanceOptions({
  initialMode = "detail",
}: EnhanceOptionsProps) {
  const sourceImage = useEditorStore((s) => s.sourceImage);
  const sourceImageId = useEditorStore((s) => s.sourceImageId);
  const isProcessing = useEditorStore((s) => s.isProcessing);
  const maskCanvas = useEditorStore((s) => s.maskCanvas);
  const setProcessing = useEditorStore((s) => s.setProcessing);
  const gallery = useGenerationStore((s) => s.gallery);
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const setError = useGenerationStore((s) => s.setError);

  const [instruction, setInstruction] = useState(DEFAULT_ENHANCE_INSTRUCTION);
  const [editInstruction, setEditInstruction] = useState("");
  const [mode, setMode] = useState<EnhanceMode>(initialMode);
  const isEditMode = mode === "edit";

  // Edit-LoRA registry (family-tagged) + add-from-link.
  const [editLoras, setEditLoras] = useState<EditLoraListItem[]>([]);
  const [editLoraId, setEditLoraId] = useState<string>("");
  const [editStrength, setEditStrength] = useState(1.0);
  const [lockComposition, setLockComposition] = useState(false);
  // krea2inpaint: grow the painted mask before CropAndStitch (pixels).
  const [maskExpand, setMaskExpand] = useState(0);
  // krea2edit "skill" modes (identity/insert/try-on/swap/…) + optional 2nd ref.
  const [editModeId, setEditModeId] = useState<EditModeId>("instruct");
  const [secondRef, setSecondRef] = useState<string | null>(null); // data URL
  const editSkill = EDIT_MODES[editModeId];
  const [addUrl, setAddUrl] = useState("");
  const [addFamily, setAddFamily] = useState<EditLora["family"]>("ostris");
  const [adding, setAdding] = useState(false);

  const selectedEditLora = useMemo(
    () => editLoras.find((l) => l.id === editLoraId) ?? null,
    [editLoras, editLoraId],
  );

  const refreshEditLoras = useCallback(async () => {
    try {
      const res = await fetch("/api/krea2-edit-loras");
      const data = await res.json();
      const list: EditLoraListItem[] = data.loras ?? [];
      setEditLoras(list);
      setEditLoraId((prev) => {
        if (prev && list.some((l) => l.id === prev)) return prev;
        return (list.find((l) => l.installed) ?? list[0])?.id ?? "";
      });
    } catch {
      /* leave list empty; UI shows the empty state */
    }
  }, []);

  useEffect(() => {
    if (isEditMode && editLoras.length === 0) void refreshEditLoras();
  }, [isEditMode, editLoras.length, refreshEditLoras]);

  useEffect(() => {
    if (selectedEditLora) setEditStrength(selectedEditLora.defaultStrength);
  }, [selectedEditLora]);
  const [faceDenoise, setFaceDenoise] = useState(DEFAULTS.faceDenoise);
  const [handDenoise, setHandDenoise] = useState(DEFAULTS.handDenoise);
  const [bboxThreshold, setBboxThreshold] = useState(DEFAULTS.bboxThreshold);
  const [cropFactor, setCropFactor] = useState(DEFAULTS.cropFactor);
  const [feather, setFeather] = useState(DEFAULTS.feather);
  const [upscaleBy, setUpscaleBy] = useState(DEFAULTS.upscaleBy);
  const [tileDenoise, setTileDenoise] = useState(DEFAULTS.tileDenoise);
  const [tileSize, setTileSize] = useState(DEFAULTS.tileSize);

  const sourceRun = useMemo(() => {
    if (!sourceImageId) return null;
    return gallery.find((img) => img.id === sourceImageId) ?? null;
  }, [gallery, sourceImageId]);

  const hasRunMetadata =
    Boolean(sourceRun?.runId) && Number.isInteger(sourceRun?.jobIndex);

  const buildOverrides = useCallback(() => {
    const overrides: WorkflowControlOverrides = {};

    // Edit modes: node 2 is the edit LoRA. The instruction is sent as a parsed
    // `params.prompt` (see handleSubmit) so trailing prompt flags (--ar, --seed,
    // --lora, --sref, …) become real params instead of literal prompt text.
    if (isEditMode) {
      if (selectedEditLora) {
        overrides["2.lora_name"] = selectedEditLora.file;
        overrides["2.strength_model"] = editStrength;
      }
      return overrides;
    }

    if (
      (mode === "detail" || mode === "upscale_detail") &&
      instruction !== DEFAULT_ENHANCE_INSTRUCTION
    ) {
      overrides["8.prompt"] = instruction;
    }

    if (mode === "upscale_detail") {
      if (upscaleBy !== DEFAULTS.upscaleBy) {
        overrides["23.upscale_by"] = upscaleBy;
      }
      if (tileDenoise !== DEFAULTS.tileDenoise) {
        overrides["23.denoise"] = tileDenoise;
        overrides["23.seam_fix_denoise"] = tileDenoise;
      }
      if (tileSize !== DEFAULTS.tileSize) {
        overrides["23.tile_width"] = tileSize;
        overrides["23.tile_height"] = tileSize;
      }
    }

    if (mode === "adetailer") {
      if (faceDenoise !== DEFAULTS.faceDenoise) {
        overrides["11.denoise"] = faceDenoise;
      }
      if (handDenoise !== DEFAULTS.handDenoise) {
        overrides["21.denoise"] = handDenoise;
      }
      if (bboxThreshold !== DEFAULTS.bboxThreshold) {
        overrides["11.bbox_threshold"] = bboxThreshold;
        overrides["21.bbox_threshold"] = bboxThreshold;
      }
      if (cropFactor !== DEFAULTS.cropFactor) {
        overrides["11.bbox_crop_factor"] = cropFactor;
        overrides["21.bbox_crop_factor"] = cropFactor;
      }
      if (feather !== DEFAULTS.feather) {
        overrides["11.feather"] = feather;
        overrides["21.feather"] = feather;
      }
    }

    return overrides;
  }, [
    mode,
    isEditMode,
    selectedEditLora,
    editStrength,
    instruction,
    faceDenoise,
    handDenoise,
    bboxThreshold,
    cropFactor,
    feather,
    upscaleBy,
    tileDenoise,
    tileSize,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!sourceImage || !sourceRun || !hasRunMetadata || isProcessing) return;

    setProcessing(true, "Queuing enhance...");

    // In edit mode the concrete action comes from the selected LoRA's family
    // (grounded-encode vs Ostris), honoring the structure-lock toggle. For the
    // krea2edit family we also apply the selected "skill" mode: 2-ref modes route
    // to the dual workflow, and the instruction is run through the mode template.
    const isKrea2Edit = isEditMode && selectedEditLora?.family === "krea2edit";
    const dualRef = isKrea2Edit && editSkill.refCount === 2;
    const action =
      isEditMode && selectedEditLora
        ? dualRef
          ? "edit_instruct_dual"
          : editActionFor(
              selectedEditLora.family,
              lockComposition && selectedEditLora.family === "krea2edit",
            )
        : mode;

    // Mask-based edit (krea2inpaint → edit_inpaint): the editor's paint layer
    // is the mask (white/red = regenerate). The server 400s without one.
    const needsMask =
      isEditMode && selectedEditLora?.family === "krea2inpaint";
    let maskDataUrl: string | null = null;
    if (needsMask) {
      maskDataUrl = editorMaskDataUrl(maskCanvas);
      if (!maskDataUrl) {
        setError(
          "Inpaint needs a mask: use the Paint tool to cover the area to change.",
        );
        setProcessing(false);
        return;
      }
    }

    // Dual-reference modes need the 2nd image uploaded to ComfyUI first.
    let secondRefImage: string | undefined;
    if (dualRef) {
      if (!secondRef) {
        setError(`${editSkill.label} needs a 2nd reference image.`);
        setProcessing(false);
        return;
      }
      try {
        const up = await fetch("/api/comfy/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: secondRef, filename: "cj_ref_b.png" }),
        });
        const upData = await up.json();
        if (!up.ok || !upData.ok) {
          throw new Error(upData.error ?? `upload ${up.status}`);
        }
        secondRefImage = upData.ref as string;
      } catch (e) {
        setError(
          `2nd reference upload failed: ${e instanceof Error ? e.message : e}`,
        );
        setProcessing(false);
        return;
      }
    }

    const editParams: Record<string, unknown> = isEditMode
      ? {
          prompt: isKrea2Edit
            ? renderEditPrompt(editSkill, editInstruction)
            : editInstruction.trim(),
          ...(isKrea2Edit ? { editMode: editModeId } : {}),
          ...(secondRefImage ? { secondRefImage } : {}),
          ...(selectedEditLora?.kvCache ? { editLoraKvCache: true } : {}),
          ...(needsMask && maskExpand > 0 ? { maskExpand } : {}),
        }
      : {};

    try {
      const response = await fetch("/api/jobs/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: sourceRun.runId,
          job_index: sourceRun.jobIndex,
          action,
          client_id: clientId,
          // Edit actions live on the krea2-edit pack, not the source's family.
          // The instruction rides in `params.prompt` so its trailing prompt flags
          // are parsed (not injected as literal CLIP text).
          ...(isEditMode ? { pack_id: "krea2-edit", params: editParams } : {}),
          ...(maskDataUrl ? { mask: maskDataUrl } : {}),
          workflow_control_overrides: buildOverrides(),
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error ?? `Failed: ${mode}`);
      if (data.run) addRun(data.run);
      showToast("Enhance queued — check Create tab", "success");
      toastNodeWarnings(data);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed: ${mode}`;
      setError(message);
    } finally {
      setProcessing(false);
    }
  }, [
    sourceImage,
    sourceRun,
    hasRunMetadata,
    isProcessing,
    setProcessing,
    mode,
    isEditMode,
    selectedEditLora,
    lockComposition,
    editInstruction,
    editSkill,
    editModeId,
    secondRef,
    maskCanvas,
    maskExpand,
    clientId,
    buildOverrides,
    addRun,
    setError,
  ]);

  const handleAddFromLink = useCallback(async () => {
    if (!addUrl.trim() || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/krea2-edit-loras/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: addUrl.trim(), family: addFamily }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAddUrl("");
      await refreshEditLoras();
      if (data.id) setEditLoraId(data.id);
      showToast(`Added ${data.name}`, "success");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Add failed");
    } finally {
      setAdding(false);
    }
  }, [addUrl, adding, addFamily, refreshEditLoras, setError]);

  const submitDisabled =
    !hasRunMetadata ||
    !sourceImage ||
    isProcessing ||
    (isEditMode && (!editInstruction.trim() || !selectedEditLora?.installed));
  const submitTitle = !hasRunMetadata
    ? "Open an image from your gallery to enhance it"
    : undefined;

  return (
    <div className="space-y-3 pt-3 border-t border-[var(--border-primary)]">
      <div className="text-xs font-medium text-[var(--text-secondary)]">
        Enhance
      </div>

      <div>
        <label
          htmlFor="enhance-instruction"
          className="text-xs text-[var(--text-secondary)] mb-1.5 block"
        >
          {isEditMode ? "Edit instruction" : "Instruction"}
        </label>
        <textarea
          id="enhance-instruction"
          value={isEditMode ? editInstruction : instruction}
          onChange={(event) =>
            isEditMode
              ? setEditInstruction(event.target.value)
              : setInstruction(event.target.value)
          }
          placeholder={
            isEditMode
              ? "e.g. turn it into a watercolor painting · make it a snowy night · change her coat to red"
              : undefined
          }
          className="input text-sm min-h-32 resize-y leading-relaxed"
          rows={isEditMode ? 4 : 7}
        />
        {isEditMode && (
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-secondary)]">
            Identity-preserving edit on Krea 2 Raw (~20–40 steps).
            {selectedEditLora?.note ? ` ${selectedEditLora.note}` : ""}
          </p>
        )}
      </div>

      {isEditMode && (
        <div className="space-y-3 rounded-md border border-[var(--border-primary)] p-2.5">
          <div>
            <label
              htmlFor="edit-lora"
              className="text-xs text-[var(--text-secondary)] mb-1.5 block"
            >
              Edit LoRA
            </label>
            <select
              id="edit-lora"
              value={editLoraId}
              onChange={(e) => setEditLoraId(e.target.value)}
              className="input text-sm"
            >
              {editLoras.length === 0 && (
                <option value="">No edit LoRAs</option>
              )}
              {editLoras.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.family}
                  {l.installed ? "" : " (not downloaded)"}
                </option>
              ))}
            </select>
            {selectedEditLora && !selectedEditLora.installed && (
              <p className="mt-1 text-[11px] text-amber-500">
                Not downloaded — add it via its Hugging Face link below.
              </p>
            )}
          </div>

          <RangeControl
            label="LoRA strength"
            value={editStrength}
            min={0}
            max={1.5}
            step={0.05}
            onChange={setEditStrength}
          />

          {selectedEditLora?.family === "krea2inpaint" && (
            <div>
              <RangeControl
                label="Grow mask (px)"
                value={maskExpand}
                min={0}
                max={128}
                step={4}
                integer
                onChange={setMaskExpand}
              />
              <p className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">
                Paint the area to change with the Paint tool; only the masked
                region is regenerated and stitched back.
              </p>
            </div>
          )}

          {selectedEditLora?.family === "krea2edit" && (
            <>
              <div>
                <label
                  htmlFor="edit-skill"
                  className="text-xs text-[var(--text-secondary)] mb-1.5 block"
                >
                  Skill
                </label>
                <select
                  id="edit-skill"
                  value={editModeId}
                  onChange={(e) => setEditModeId(e.target.value as EditModeId)}
                  className="input text-sm"
                >
                  {EDIT_MODE_LIST.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.refCount === 2 ? " · 2 images" : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">
                  {editSkill.hint}
                </p>
              </div>

              {editSkill.refCount === 2 && (
                <div>
                  <label className="text-xs text-[var(--text-secondary)] mb-1.5 block">
                    {editSkill.refBLabel ?? "2nd reference"} image
                  </label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) {
                        setSecondRef(null);
                        return;
                      }
                      const reader = new FileReader();
                      reader.onload = () => setSecondRef(String(reader.result));
                      reader.readAsDataURL(file);
                    }}
                    className="text-xs text-[var(--text-secondary)]"
                  />
                  {secondRef && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={secondRef}
                      alt="2nd reference"
                      className="mt-2 h-16 w-16 rounded object-cover border border-[var(--border-primary)]"
                    />
                  )}
                  <p className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">
                    The source image is reference 1 (scene); this is reference 2
                    (subject).
                  </p>
                </div>
              )}

              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={lockComposition}
                  onChange={(e) => setLockComposition(e.target.checked)}
                />
                Lock composition (depth-control — pin shapes &amp; positions)
              </label>
            </>
          )}

          <div className="border-t border-[var(--border-primary)] pt-2">
            <label className="text-xs text-[var(--text-secondary)] mb-1.5 block">
              Add edit LoRA from Hugging Face
            </label>
            <input
              type="text"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              placeholder="https://huggingface.co/…/model.safetensors"
              className="input text-sm mb-1.5"
            />
            <div className="flex items-center gap-2">
              <select
                value={addFamily}
                onChange={(e) =>
                  setAddFamily(e.target.value as EditLora["family"])
                }
                className="input text-sm flex-1"
                title="Which edit node family this LoRA was trained for"
              >
                <option value="ostris">Ostris multi-ref</option>
                <option value="krea2edit">Grounded edit</option>
              </select>
              <button
                aria-label={adding ? "Adding…" : undefined}
                onClick={handleAddFromLink}
                disabled={!addUrl.trim() || adding}
                className="btn btn-sm shrink-0"
              >
                {adding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Add"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <label
          htmlFor="enhance-mode"
          className="text-xs text-[var(--text-secondary)] mb-1.5 block"
        >
          Mode
        </label>
        <select
          id="enhance-mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as EnhanceMode)}
          className="input text-sm"
        >
          {MODES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {mode === "adetailer" && (
        <div className="space-y-3">
          <RangeControl
            label="Face denoise"
            value={faceDenoise}
            min={0.15}
            max={0.5}
            step={0.01}
            onChange={setFaceDenoise}
          />
          <RangeControl
            label="Hand denoise"
            value={handDenoise}
            min={0.15}
            max={0.5}
            step={0.01}
            onChange={setHandDenoise}
          />
          <RangeControl
            label="BBox threshold"
            value={bboxThreshold}
            min={0}
            max={1}
            step={0.01}
            onChange={setBboxThreshold}
          />
          <RangeControl
            label="Crop factor"
            value={cropFactor}
            min={1}
            max={10}
            step={0.01}
            onChange={setCropFactor}
          />
          <RangeControl
            label="Feather"
            value={feather}
            min={0}
            max={100}
            step={1}
            integer
            onChange={setFeather}
          />
        </div>
      )}

      {mode === "upscale_detail" && (
        <div className="space-y-3">
          <RangeControl
            label="Upscale by"
            value={upscaleBy}
            min={1}
            max={4}
            step={0.05}
            onChange={setUpscaleBy}
          />
          <RangeControl
            label="Tile denoise"
            value={tileDenoise}
            min={0.1}
            max={0.5}
            step={0.01}
            onChange={setTileDenoise}
          />
          <RangeControl
            label="Tile size"
            value={tileSize}
            min={512}
            max={1536}
            step={128}
            integer
            onChange={setTileSize}
          />
        </div>
      )}

      <button
        onClick={() => void handleSubmit()}
        disabled={submitDisabled}
        title={submitTitle}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isProcessing ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Sparkles className="w-4 h-4" />
        )}
        <span className="text-sm font-medium">
          {isProcessing ? "Queuing..." : "Enhance"}
        </span>
      </button>
    </div>
  );
}

interface RangeControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  onChange: (value: number) => void;
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  integer = false,
  onChange,
}: RangeControlProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-[var(--text-secondary)]">{label}</span>
        <span className="text-xs text-[var(--text-tertiary)]">
          {integer ? value.toFixed(0) : value.toFixed(2)}
        </span>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(integer ? Math.round(next) : next);
        }}
        className="slider w-full"
      />
    </div>
  );
}

export default EnhanceOptions;
