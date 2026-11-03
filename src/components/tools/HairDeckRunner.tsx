"use client";

import { useCallback, useEffect, useState } from "react";
import { Dices, Download, RefreshCw, Scissors, Unplug } from "lucide-react";
import { useGenerationStore } from "@/store";
import { showToast } from "@/components/Toast";
import { BlenderExportActions } from "@/components/BlenderExportActions";
import type { HubCard } from "@/lib/tools/hub";
import type { ToolImage } from "@/lib/tools/runTool";
import {
  recentRunToImagineRun,
  runGalleryImages,
} from "@/lib/historyHydration";
import {
  HAIRDECK_CFG_MAX,
  HAIRDECK_CFG_MIN,
  HAIRDECK_DEFAULT_CFG,
  HAIRDECK_DEFAULT_STEPS,
  HAIRDECK_LICENSES,
  HAIRDECK_MAX_VARIATIONS,
  HAIRDECK_REPO_URL,
  HAIRDECK_SEED_MAX,
  HAIRDECK_SETUP_STEPS,
  type HairDeckSteps,
} from "@/lib/hairdeck/config";
import type { HairDeckResult } from "@/lib/hairdeck/save";
import { ToolImageInput } from "./ToolImageInput";
import { RunFooter, RunnerShell, errorMessage } from "./RunnerShell";
import { Segmented } from "./ToolRunner";

export type HairDeckStatus =
  | { state: "checking" }
  | {
      state: "ready" | "offline" | "unset";
      local: boolean;
      error?: string;
    };

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
};
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-light-100 px-3 py-1.5 text-xs font-medium hover:bg-light-50 dark:border-dark-750 dark:hover:bg-dark-800";

const randomSeed = () => Math.floor(Math.random() * 1_000_000);

/** Put the run in history/gallery with each seed's meshes on its tile. */
function addToStore(result: HairDeckResult) {
  const run = result.run;
  if (!run) return;
  const gen = useGenerationStore.getState();
  const base = recentRunToImagineRun(run);
  gen.addRun({
    ...base,
    jobs: base.jobs.map((j, i) => ({ ...j, meshes: run.jobs[i]?.meshes })),
  });
  gen.addToGallery(
    runGalleryImages(run).map((g) => {
      const meshes = run.jobs.find((j) => j.index === g.jobIndex)?.meshes;
      return meshes?.length
        ? { ...g, meshUrl: meshes[0], meshUrls: meshes }
        : g;
    }),
  );
}

export function HairDeckSetupCard({
  status,
  onRetry,
}: {
  status: HairDeckStatus;
  onRetry: () => void;
}) {
  const offline = status.state === "offline";
  return (
    <section
      className="space-y-3 rounded-xl border border-light-100 p-4 text-sm dark:border-dark-750"
      data-testid="hairdeck-setup"
    >
      <h3 className="flex items-center gap-2 font-semibold">
        <Unplug className="h-4 w-4" />
        {offline ? "HairDeck is not answering" : "HairDeck is not connected"}
      </h3>
      {"error" in status && status.error && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {status.error}
        </p>
      )}
      <p className="text-xs text-light-500 dark:text-dark-300">
        HairDeck turns one portrait into strand-aligned 3D hair cards. It runs
        as its own app on a GPU machine, not inside ComfyUI.
      </p>
      <ol className="list-decimal space-y-2 pl-5 text-xs">
        {HAIRDECK_SETUP_STEPS.map((s) => (
          <li key={s.text}>
            {s.text}
            {s.cmd && (
              <code className="mt-1 block overflow-x-auto whitespace-pre rounded-md bg-light-50 px-2 py-1 font-mono text-[11px] dark:bg-dark-800">
                {s.cmd}
              </code>
            )}
          </li>
        ))}
      </ol>
      <button type="button" onClick={onRetry} className={BTN}>
        <RefreshCw className="h-3.5 w-3.5" /> Check again
      </button>
    </section>
  );
}

export function HairDeckCredits() {
  return (
    <details className="text-[11px] text-light-500 dark:text-dark-300">
      <summary className="cursor-pointer">Credits and licenses</summary>
      <p className="mt-1">
        <a
          href={HAIRDECK_REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          HairDeck
        </a>{" "}
        by hyz317 (Apache-2.0). Linked, not bundled. Its install uses:
      </p>
      <ul className="mt-1 list-disc pl-5">
        {HAIRDECK_LICENSES.slice(1).map((l) => (
          <li key={l.name}>
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {l.name}
            </a>
            : {l.license}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * HairDeck sidecar: portrait -> 3D hair cards (.glb per seed) through the
 * optional HairDeck service. Without HAIRDECK_BACKEND_URL it shows setup.
 */
export function HairDeckRunner({
  card,
  onBack,
}: {
  card: HubCard;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<HairDeckStatus>({ state: "checking" });
  const [image, setImage] = useState<ToolImage | null>(null);
  const [steps, setSteps] = useState<HairDeckSteps>(HAIRDECK_DEFAULT_STEPS);
  const [variations, setVariations] = useState(1);
  const [cfg, setCfg] = useState(HAIRDECK_DEFAULT_CFG);
  const [seed, setSeed] = useState(randomSeed);
  const [chains, setChains] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HairDeckResult | null>(null);

  const check = useCallback(async () => {
    setStatus({ state: "checking" });
    try {
      const res = await fetch("/api/hairdeck/status", {
        headers: { "X-Requested-With": "XMLHttpRequest" },
        cache: "no-store",
      });
      const body = (await res.json()) as {
        configured?: boolean;
        reachable?: boolean;
        local?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setStatus({
        state: !body.configured
          ? "unset"
          : body.reachable
            ? "ready"
            : "offline",
        local: body.local !== false,
        error: body.error,
      });
    } catch (e) {
      setStatus({ state: "offline", local: true, error: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const ready = status.state === "ready";
  const remote = status.state !== "checking" && !status.local;
  let validation: string | null = null;
  if (remote)
    validation = "HairDeck only runs from the computer running Adrift.";
  else if (!image) validation = "Add a portrait.";
  else if (!image.dataUrl)
    validation = "Could not read that image; pick it again.";

  const go = async () => {
    if (!image?.dataUrl) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/hairdeck/generate", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          image: image.dataUrl,
          seed,
          steps,
          cfg,
          variations,
          chains,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        (HairDeckResult & { ok?: boolean; error?: string }) | null;
      if (!res.ok || !body?.ok)
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      setResult(body);
      addToStore(body);
      showToast(`${card.title}: done.`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RunnerShell
      title={card.title}
      subtitle={card.subtitle}
      model={card.model}
      blockedReason={null}
      checking={status.state === "checking"}
      onBack={onBack}
      testId="hairdeck"
    >
      {status.state === "unset" || status.state === "offline" ? (
        <HairDeckSetupCard status={status} onRetry={() => void check()} />
      ) : (
        <>
          <fieldset disabled={busy || !ready} className="space-y-4">
            <ToolImageInput
              label="Portrait"
              value={image}
              onChange={setImage}
              needsPixels
            />
            <Segmented
              label="Quality"
              value={String(steps)}
              options={[
                { id: "50", label: "Best (50 steps)" },
                { id: "10", label: "Fast (10 steps)" },
              ]}
              onChange={(v) => setSteps(Number(v) as HairDeckSteps)}
            />
            <Segmented
              label="Variations"
              value={String(variations)}
              options={Array.from(
                { length: HAIRDECK_MAX_VARIATIONS },
                (_, i) => ({
                  id: String(i + 1),
                  label: String(i + 1),
                }),
              )}
              onChange={(v) => setVariations(Number(v))}
            />
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Guidance {cfg.toFixed(2)}</span>
              <input
                type="range"
                min={HAIRDECK_CFG_MIN}
                max={HAIRDECK_CFG_MAX}
                step={0.25}
                value={cfg}
                onChange={(e) => setCfg(Number(e.target.value))}
                className="w-full accent-splash"
              />
            </label>
            <div className="flex flex-wrap items-end gap-3 text-xs">
              <label className="space-y-1">
                <span className="block font-medium">Seed</span>
                <input
                  type="number"
                  min={0}
                  max={HAIRDECK_SEED_MAX}
                  value={seed}
                  onChange={(e) => {
                    const n = Math.trunc(Number(e.target.value));
                    if (Number.isFinite(n))
                      setSeed(Math.min(HAIRDECK_SEED_MAX, Math.max(0, n)));
                  }}
                  className="w-32 rounded-lg border border-light-100 bg-transparent px-2 py-1.5 dark:border-dark-750"
                />
              </label>
              <button
                type="button"
                onClick={() => setSeed(randomSeed())}
                className={BTN}
              >
                <Dices className="h-3.5 w-3.5" /> Random
              </button>
              <label className="flex items-center gap-2 pb-1.5">
                <input
                  type="checkbox"
                  checked={chains}
                  onChange={(e) => setChains(e.target.checked)}
                />
                Also export strand chains
              </label>
            </div>
            <p className="text-[11px] text-light-500 dark:text-dark-300">
              A clear, front-facing portrait works best. Adrift waits for the
              whole job (up to 15 minutes), so each extra variation adds time.
            </p>
          </fieldset>

          <RunFooter
            label="Make hair cards"
            busy={busy}
            disabled={!ready}
            validation={validation}
            error={error}
            queuedText={null}
            onRun={() => void go()}
            icon={<Scissors className="h-4 w-4" />}
            masterFile={false}
          />

          {result && (
            <section className="space-y-4" data-testid="hairdeck-result">
              {result.seeds.map((s) => (
                <div
                  key={s.seed}
                  className="flex flex-wrap items-start gap-3 rounded-xl border border-light-100 p-3 dark:border-dark-750"
                >
                  {s.preview && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={s.preview}
                      alt={`Prepared portrait, seed ${s.seed}`}
                      className="h-28 w-28 rounded-lg object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-2 text-xs">
                    <p className="font-medium">Seed {s.seed}</p>
                    <div className="flex flex-wrap gap-2">
                      {s.downloads
                        .filter((d) => d.kind !== "preview")
                        .map((d) => (
                          <a
                            key={d.url}
                            href={d.url}
                            download={d.name}
                            className={BTN}
                          >
                            <Download className="h-3.5 w-3.5" /> {d.name}
                          </a>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <BlenderExportActions urls={s.meshes} className={BTN} />
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      <HairDeckCredits />
    </RunnerShell>
  );
}
