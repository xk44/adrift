"use client";

/**
 * Account settings card: embed the Adrift recipe (tool, settings, prompt,
 * seed, model names) in output files. Server setting, default on.
 */

import { useEffect, useState } from "react";
import { showToast } from "@/components/Toast";

const API = "/api/settings/recipe";

export function RecipeEmbedSettings() {
  const [embed, setEmbed] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(API)
      .then((r) => r.json())
      .then((d: { ok?: boolean; embed?: boolean }) => {
        if (alive && d?.ok && typeof d.embed === "boolean") setEmbed(d.embed);
      })
      .catch(() => {
        if (alive) showToast("Couldn't load the recipe setting.", "error");
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (next: boolean) => {
    const prev = embed;
    setEmbed(next);
    setSaving(true);
    try {
      const res = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embed: next }),
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || d.ok === false)
        throw new Error(typeof d.error === "string" ? d.error : `HTTP ${res.status}`);
    } catch (e) {
      setEmbed(prev);
      showToast(
        `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const checked = embed ?? true;
  return (
    <div
      className="flex items-start justify-between gap-4"
      data-testid="recipe-embed-settings"
    >
      <div className="min-w-0 flex-1">
        <span
          id="recipe-embed-label"
          className="text-xs font-medium text-[var(--text-primary)]"
        >
          Embed recipe in files
        </span>
        <p className="mt-0.5 text-[10px] text-pretty text-[var(--text-muted)]">
          New images and videos carry how they were made (tool, settings,
          prompt, seed, model and LoRA names; never paths or keys), so
          dropping one back into Adrift can reproduce it. When off, the recipe
          is stripped from new files and kept only in this Adrift&apos;s
          library. ComfyUI still writes its own graph unless it runs with
          --disable-metadata.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby="recipe-embed-label"
        disabled={embed == null || saving}
        onClick={() => void save(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors duration-200 flex-shrink-0 disabled:opacity-50 ${
          checked ? "bg-splash" : "bg-light-200 dark:bg-dark-600"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
    </div>
  );
}
