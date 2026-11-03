"use client";

import { useRef, useState } from "react";
import { Check, Film } from "lucide-react";
import { useGenerationStore } from "@/store";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import { showToast } from "@/components/Toast";
import type { HubCard } from "@/lib/tools/hub";
import type { EngineContext } from "@/lib/tools/templates";
import type { PreparedSource, ToolImage } from "@/lib/tools/runTool";
import {
  DEFAULT_HEADLINE,
  MAX_HEADLINE,
  MAX_PRODUCT_TEXT,
  PRODUCT_LOOKS,
  PRODUCT_STUDIO_ANIMATE_KEY,
  animateHandoff,
  compileLookPrompt,
  generatePackshot,
  productLook,
  submitProductLook,
  type ProductLookId,
} from "@/lib/tools/productStudio";
import { ToolImageInput } from "./ToolImageInput";
import { useToolHandoff } from "./useToolHandoff";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented, field } from "./ToolRunner";

type Mode = "photo" | "prompt";

const MODE_OPTIONS = [
  { id: "photo", label: "Product photo" },
  { id: "prompt", label: "Describe it" },
];

interface QueuedLook {
  look: ProductLookId;
  runId: string;
}

/**
 * Product Studio: one product, several FLUX.3 hero shots. Photo mode edits
 * the photo once per look; prompt mode first renders a FLUX.3 packshot and
 * builds the looks from it. Each finished look hands off to LTX-2.5.
 */
export function ProductStudioRunner({
  card,
  ctx,
  onBack,
}: {
  card: HubCard;
  ctx: EngineContext;
  onBack: () => void;
}) {
  void ctx;
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const runs = useGenerationStore((s) => s.runs);

  const [mode, setMode] = useState<Mode>("photo");
  const [image, setImage] = useState<ToolImage | null>(null);
  const [product, setProduct] = useState("");
  const [headline, setHeadline] = useState(DEFAULT_HEADLINE);
  const [looks, setLooks] = useState<ProductLookId[]>(
    PRODUCT_LOOKS.map((l) => l.id),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedLook[]>([]);
  const cancelled = useRef(false);

  useToolHandoff(card.key, {
    onImage: (img) => {
      setMode("photo");
      setImage(img);
    },
    onError: setError,
  });

  const toggle = (id: ProductLookId) =>
    setLooks((cur) =>
      cur.includes(id) ? cur.filter((l) => l !== id) : [...cur, id],
    );
  const ordered = PRODUCT_LOOKS.filter((l) => looks.includes(l.id));

  let validation: string | null = null;
  if (ordered.length === 0) validation = "Pick at least one look.";
  else if (mode === "photo" && !image) validation = "Add a product photo.";
  else if (mode === "prompt" && !product.trim())
    validation = "Describe the product.";

  const run = async () => {
    setBusy(true);
    setError(null);
    setQueued([]);
    cancelled.current = false;
    try {
      let source = image;
      if (mode === "prompt") {
        setStatus("Rendering the packshot with FLUX 3...");
        source = await generatePackshot(
          {
            fetchImpl: fetch,
            clientId,
            onRun: addRun,
            isCancelled: () => cancelled.current,
          },
          product,
        );
      }
      if (!source) throw new Error("Add a product photo.");
      const prepared: PreparedSource = {};
      const out: QueuedLook[] = [];
      for (const look of ordered) {
        setStatus(`Queueing ${look.label}...`);
        const r = await submitProductLook({
          fetchImpl: fetch,
          image: source,
          look: look.id,
          product: mode === "prompt" ? product : product || undefined,
          headline,
          clientId,
          prepared,
        });
        addRun(r);
        out.push({ look: look.id, runId: r.run_id });
        setQueued([...out]);
      }
      showToast(
        `${out.length} FLUX 3 looks queued. Progress shows in Create.`,
        "success",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStatus(null);
      setBusy(false);
    }
  };

  const animate = (q: QueuedLook) => {
    const r = runs.find((x) => x.run_id === q.runId);
    const job = r?.jobs?.[0];
    const url = job?.images?.[0];
    if (!r || !job || !url) return;
    const look = productLook(q.look);
    const store = useToolHandoffStore.getState();
    store.offer(
      animateHandoff({
        runId: r.run_id,
        jobIndex: job.index ?? 0,
        url,
        label: `Product Studio · ${look?.label ?? q.look}`,
        width: r.width ?? 0,
        height: r.height ?? 0,
        now: Date.now(),
      }),
    );
    if (look)
      store.offerPrefill({
        toolKey: PRODUCT_STUDIO_ANIMATE_KEY,
        settings: { text: look.motion },
        at: Date.now(),
      });
    useOverlayToolsStore
      .getState()
      .openToolFromLauncher(PRODUCT_STUDIO_ANIMATE_KEY, false);
  };

  const preview = ordered[0]
    ? compileLookPrompt(ordered[0].id, {
        product: product || undefined,
        headline,
      })
    : "";

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={card.available ? null : card.unavailableReason}
      checking={card.checking}
      onBack={onBack}
      testId="product-studio-runner"
    >
      <Segmented
        label="Start from"
        value={mode}
        options={MODE_OPTIONS}
        onChange={(id) => setMode(id as Mode)}
        disabled={busy}
      />

      {mode === "photo" && (
        <ToolImageInput
          label="Product photo"
          value={image}
          onChange={setImage}
        />
      )}

      <section className="space-y-1.5">
        <label
          htmlFor="product-studio-product"
          className="text-xs font-medium text-light-primary dark:text-dark-primary"
        >
          {mode === "prompt" ? "Product" : "What is it? (optional)"}
        </label>
        <input
          id="product-studio-product"
          className={field}
          maxLength={MAX_PRODUCT_TEXT}
          placeholder="a matte beige tin of hand balm with an orange sun logo"
          value={product}
          onChange={(e) => setProduct(e.target.value)}
        />
      </section>

      <section className="space-y-1.5" aria-label="Looks">
        <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
          Looks
        </span>
        <div className="grid grid-cols-2 gap-2">
          {PRODUCT_LOOKS.map((l) => {
            const on = looks.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={busy}
                onClick={() => toggle(l.id)}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  on
                    ? "border-splash bg-splash/10"
                    : "border-light-100 dark:border-dark-750"
                }`}
              >
                <Check
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${on ? "text-splash" : "opacity-0"}`}
                />
                <span>
                  <span className="block text-xs font-medium text-light-primary dark:text-dark-primary">
                    {l.label}
                  </span>
                  <span className="block text-[11px] text-light-500 dark:text-dark-400">
                    {l.blurb}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {looks.includes("billboard") && (
        <section className="space-y-1.5">
          <label
            htmlFor="product-studio-headline"
            className="text-xs font-medium text-light-primary dark:text-dark-primary"
          >
            Billboard headline
          </label>
          <input
            id="product-studio-headline"
            className={field}
            maxLength={MAX_HEADLINE}
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
          />
        </section>
      )}

      {preview && (
        <details className="text-[11px] text-light-500 dark:text-dark-400">
          <summary className="cursor-pointer">
            Prompt sent ({ordered[0].label})
          </summary>
          <p className="mt-1 font-mono">{preview}</p>
        </details>
      )}

      <RunFooter
        label={`Generate ${ordered.length || ""} look${ordered.length === 1 ? "" : "s"}`}
        busy={busy}
        disabled={!card.available}
        validation={validation}
        error={error}
        queuedText={
          status ?? (queued.length ? `${queued.length} queued.` : null)
        }
        onRun={run}
      />

      {queued.length > 0 && (
        <section className="grid grid-cols-2 gap-3" aria-label="Results">
          {queued.map((q) => {
            const r = runs.find((x) => x.run_id === q.runId);
            const job = r?.jobs?.[0];
            const url = job?.status === "done" ? job.images?.[0] : undefined;
            const look = productLook(q.look);
            return (
              <figure
                key={q.runId}
                className="space-y-1.5 rounded-lg border border-light-100 dark:border-dark-750 p-2"
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt={look?.label ?? q.look}
                    className="w-full rounded-md object-cover"
                  />
                ) : (
                  <div className="flex aspect-[4/5] items-center justify-center rounded-md bg-light-50 dark:bg-dark-800 text-[11px] text-light-500 dark:text-dark-400">
                    {job?.status === "error" ? "Failed" : "Rendering..."}
                  </div>
                )}
                <figcaption className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
                    {look?.label ?? q.look}
                  </span>
                  <button
                    type="button"
                    disabled={!url}
                    onClick={() => animate(q)}
                    className="inline-flex items-center gap-1 rounded-md border border-light-100 dark:border-dark-750 px-2 py-1 text-[11px] disabled:opacity-40"
                  >
                    <Film className="h-3 w-3" />
                    Animate with LTX
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </section>
      )}
    </RunnerShell>
  );
}
