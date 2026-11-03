"use client";

/**
 * Reproduce panel: shows a recipe (lightbox "Reproduce", or an Adrift file
 * dropped on Create / Tools), warns about models / LoRAs this ComfyUI lacks
 * (with the usual download / tool setup links) and reopens the tool or
 * Create with its settings filled. Never submits.
 *
 * The drop listener only reads the file; whatever the drop target does with
 * it (attach, import) still happens.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Download, FileText, X } from "lucide-react";
import { showToast } from "@/components/Toast";
import { SetupToolButton } from "@/components/tools/SetupDrawer";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { readRecipeFromFile, mayCarryRecipe } from "@/lib/recipe/fileRecipe";
import { applyPlan, checkRecipe } from "@/lib/recipe/client";
import { reproducePlan } from "@/lib/recipe/reproduce";
import { openModelDownloads } from "@/lib/setupNav";
import { toolTitle } from "@/lib/tools/toolNames";
import { useUIStore } from "@/store";
import { useRecipeStore } from "@/store/recipeStore";

const DROP_PAGES = new Set(["create", "tools"]);

function stem(name: string): string {
  return (name.split("/").pop() ?? name).replace(/\.[^.]+$/, "");
}

function useRecipeDrop() {
  const activeNav = useUIStore((s) => s.activeNav);
  useEffect(() => {
    if (!DROP_PAGES.has(activeNav)) return;
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter(
        mayCarryRecipe,
      );
      if (files.length !== 1) return;
      const file = files[0];
      void (async () => {
        const parsed = await readRecipeFromFile(file).catch(() => null);
        if (!parsed?.ok) return;
        try {
          const checked = await checkRecipe(parsed);
          useRecipeStore
            .getState()
            .show({ ...checked, origin: "file", fileName: file.name });
        } catch {
          useRecipeStore.getState().show({
            recipe: parsed.recipe,
            warnings: parsed.warnings,
            missing: null,
            origin: "file",
            fileName: file.name,
          });
        }
      })();
    };
    document.addEventListener("drop", onDrop, true);
    return () => document.removeEventListener("drop", onDrop, true);
  }, [activeNav]);
}

export function RecipePanel() {
  useRecipeDrop();
  const offer = useRecipeStore((s) => s.offer);
  const close = useRecipeStore((s) => s.close);
  const boxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useDialogFocus(boxRef, !!offer, { onEscape: close });

  const plan = useMemo(
    () => (offer ? reproducePlan(offer.recipe) : null),
    [offer],
  );
  if (!offer || !plan || !mounted) return null;
  const { recipe, missing } = offer;
  const missingNames = missing ? [...missing.models, ...missing.loras] : [];
  const toolName =
    plan.kind === "tool"
      ? toolTitle(plan.toolKey, recipe.tool.label ?? recipe.tool.id)
      : recipe.tool.kind === "create"
        ? recipe.tool.mode
          ? `Create (${recipe.tool.mode})`
          : "Create"
        : (recipe.tool.label ?? recipe.tool.id);
  const openLabel =
    plan.kind === "prompt"
      ? "Open in Create"
      : plan.kind === "tool"
        ? `Open ${toolName}`
        : null;

  const open = async () => {
    setBusy(true);
    try {
      useUIStore.getState().closeLightbox();
      await applyPlan(plan);
      close();
    } catch (e) {
      showToast(
        `Couldn't open: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const notes = [
    ...offer.warnings,
    ...(plan.kind === "unsupported" ? [] : plan.notes),
    ...(missing === null
      ? ["Couldn't check models: ComfyUI is not reachable."]
      : []),
  ];
  const lora = new Map(recipe.loras.map((l) => [l.name, l.strength]));

  const node = (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        aria-hidden
        onClick={close}
      />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recipe-panel-title"
        className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-primary)] shadow-2xl"
        data-testid="recipe-panel"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-secondary)] p-4">
          <div className="min-w-0">
            <h2
              id="recipe-panel-title"
              className="text-sm font-medium text-[var(--text-primary)]"
            >
              {offer.origin === "file"
                ? "This file has an Adrift recipe"
                : "Reproduce"}
            </h2>
            <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
              {toolName}
              {recipe.seeds.length > 0 && ` · seed ${recipe.seeds[0]}`}
              {offer.fileName && ` · ${offer.fileName}`}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          {recipe.prompt && (
            <div className="flex gap-2">
              <FileText
                className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]"
                aria-hidden
              />
              <p className="line-clamp-4 break-words text-[var(--text-primary)]">
                {recipe.prompt}
              </p>
            </div>
          )}

          {(recipe.models.length > 0 || recipe.loras.length > 0) && (
            <ul className="space-y-1" aria-label="Models">
              {[
                ...recipe.models.map((m) => m.name),
                ...recipe.loras.map((l) => l.name),
              ].map((name) => {
                const isMissing = missingNames.includes(name);
                const strength = lora.get(name);
                return (
                  <li
                    key={name}
                    className="flex items-center justify-between gap-2"
                  >
                    <span
                      className={`min-w-0 truncate ${isMissing ? "text-amber-700 dark:text-amber-300" : "text-[var(--text-secondary)]"}`}
                      title={name}
                    >
                      {name}
                      {strength !== undefined && ` · ${strength}`}
                    </span>
                    {isMissing && (
                      <button
                        type="button"
                        onClick={() => {
                          close();
                          useUIStore.getState().closeLightbox();
                          openModelDownloads(stem(name));
                        }}
                        className="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                      >
                        <Download className="h-3 w-3" aria-hidden />
                        Get
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {missingNames.length > 0 && (
            <div
              role="status"
              className="rounded-lg bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200"
            >
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                {missingNames.length === 1
                  ? "1 model is not installed here"
                  : `${missingNames.length} models are not installed here`}
              </p>
              <p className="mt-0.5 text-[11px]">
                The result will differ until it is installed.
              </p>
              {plan.kind === "tool" && (
                <SetupToolButton
                  card={{
                    key: plan.toolKey,
                    id: plan.toolKey.split(":").slice(1).join(":"),
                    title: toolName,
                  }}
                />
              )}
            </div>
          )}

          {plan.kind === "unsupported" && (
            <p className="text-[var(--text-secondary)]">{plan.reason}</p>
          )}
          {notes.map((n) => (
            <p key={n} className="text-[11px] text-[var(--text-muted)]">
              {n}
            </p>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border-secondary)] p-3">
          <button
            type="button"
            onClick={close}
            className="h-8 rounded-lg border border-[var(--border-secondary)] px-3 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            {openLabel ? "Cancel" : "Close"}
          </button>
          {openLabel && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void open()}
              data-testid="recipe-open"
              className="h-8 rounded-lg bg-[var(--accent-primary)] px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {missingNames.length ? `${openLabel} anyway` : openLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}
