"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Play, Settings2, Trash2 } from "lucide-react";
import { useGenerationStore } from "@/store";
import { useUserTools, useUserToolsStore } from "@/store/userToolsStore";
import { showToast } from "@/components/Toast";
import type { ToolAudio, ToolImage, ToolVideo } from "@/lib/tools/runTool";
import {
  deleteUserToolApi,
  exportUserToolApi,
  runUserToolApi,
  updateUserToolApi,
  type UserToolMedia,
} from "@/lib/userTools/client";
import { userToolSubtitle } from "@/lib/userTools/registry";
import {
  exposedParams,
  formValuesToSend,
  initialFormValues,
  missingMediaMessage,
  type FormValue,
} from "@/lib/userTools/runnerForm";
import {
  userToolKey,
  type UserToolParam,
  type UserToolSummary,
} from "@/lib/userTools/types";
import { RunError, RunFooter, RunnerShell, errorMessage } from "../RunnerShell";
import { ToolImageInput } from "../ToolImageInput";
import { ToolVideoInput } from "../ToolVideoInput";
import { ToolAudioInput } from "../ToolAudioInput";
import { useToolHandoff } from "../useToolHandoff";
import { EditorReturnNote, useEditorOrigin } from "../EditorReturn";
import { FIELD, LABEL, NOTE, PILL_BUTTON } from "./ui";

/** Tools page runner for an imported workflow ("user:<id>"). */
export function UserToolRunner({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const tools = useUserTools();
  const tool = tools?.find((t) => t.id === id) ?? null;
  if (!tool) {
    return (
      <RunnerShell
        title={tools === null ? "Loading…" : "Tool not found"}
        subtitle={
          tools === null ? "" : "This imported tool was deleted or is not available."
        }
        checking={tools === null}
        onBack={onBack}
        testId="user-tool-runner"
      >
        <span />
      </RunnerShell>
    );
  }
  return <Runner key={tool.id} tool={tool} onBack={onBack} />;
}

type MediaState = Record<string, UserToolMedia | null>;

function Runner({
  tool,
  onBack,
}: {
  tool: UserToolSummary;
  onBack: () => void;
}) {
  const clientId = useGenerationStore((s) => s.clientId);
  const addRun = useGenerationStore((s) => s.addRun);
  const key = userToolKey(tool.id);
  const params = useMemo(() => exposedParams(tool.params), [tool.params]);
  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    initialFormValues(tool.params),
  );
  const [media, setMedia] = useState<MediaState>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [managing, setManaging] = useState(false);

  const firstImage = params.find((p) => p.kind === "image");
  const firstVideo = params.find((p) => p.kind === "video");
  const editorOrigin = useEditorOrigin(tool.name);
  useToolHandoff(key, {
    onHandoff: editorOrigin.onHandoff,
    onImage: firstImage
      ? (image) =>
          setMedia((m) => ({ ...m, [firstImage.key]: { kind: "image", image } }))
      : undefined,
    onVideo: firstVideo
      ? (video) =>
          setMedia((m) => ({ ...m, [firstVideo.key]: { kind: "video", video } }))
      : undefined,
    onError: setError,
  });

  // Opened from the editor with a selection: use it as the mask input.
  const maskParam = params.find((p) => p.kind === "mask");
  const editorMask = editorOrigin.editorMask;
  useEffect(() => {
    if (!maskParam || !editorMask) return;
    const image: ToolImage = {
      id: `editor-mask:${Date.now()}`,
      source: "upload",
      previewUrl: editorMask,
      dataUrl: editorMask,
      label: "Editor selection",
      width: 0,
      height: 0,
    };
    setMedia((m) => ({ ...m, [maskParam.key]: { kind: "image", image } }));
  }, [maskParam, editorMask]);

  const validation = missingMediaMessage(tool.params, (k) => !!media[k]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setQueued(false);
    try {
      const picked: Record<string, UserToolMedia> = {};
      for (const [k, m] of Object.entries(media)) if (m) picked[k] = m;
      const r = await runUserToolApi({
        fetchImpl: fetch,
        id: tool.id,
        values: formValuesToSend(tool.params, values),
        media: picked,
        clientId,
        onWarnings: (w) => showToast(w[0], "info", 6000),
      });
      addRun(r);
      editorOrigin.track(r.run_id);
      setQueued(true);
      showToast(`${tool.name}: queued. Progress shows in Create.`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setMediaFor = (p: UserToolParam, m: UserToolMedia | null) =>
    setMedia((s) => ({ ...s, [p.key]: m }));

  return (
    <RunnerShell
      title={tool.name}
      subtitle={userToolSubtitle(tool)}
      model={`Imported workflow · ${tool.workflowType}`}
      onBack={onBack}
      testId="user-tool-runner"
      studio
      recentKey={`user:${tool.id}`}
    >
      {editorOrigin.fromEditor && <EditorReturnNote />}
      <fieldset disabled={busy} className="space-y-4">
        {params.length === 0 && (
          <p className={NOTE}>
            This tool has no settings. It runs the workflow as imported.
          </p>
        )}
        {params.map((p) => (
          <ParamField
            key={p.key}
            param={p}
            value={values[p.key]}
            media={media[p.key] ?? null}
            onValue={(v) => setValues((s) => ({ ...s, [p.key]: v }))}
            onMedia={(m) => setMediaFor(p, m)}
          />
        ))}
      </fieldset>
      <RunFooter
        label="Generate"
        busy={busy}
        disabled={false}
        validation={validation}
        error={error}
        queuedText={queued ? "Queued. Results show in Create." : null}
        onRun={() => void run()}
        icon={<Play className="h-4 w-4" />}
      />
      <div className="border-t border-light-100 pt-4 dark:border-dark-750">
        <button
          type="button"
          onClick={() => setManaging((v) => !v)}
          aria-expanded={managing}
          className={PILL_BUTTON}
        >
          <Settings2 className="h-3.5 w-3.5" /> Edit tool
        </button>
        {managing && <ManageTool tool={tool} onDeleted={onBack} />}
      </div>
    </RunnerShell>
  );
}

function ParamField({
  param: p,
  value,
  media,
  onValue,
  onMedia,
}: {
  param: UserToolParam;
  value: FormValue | undefined;
  media: UserToolMedia | null;
  onValue: (v: FormValue) => void;
  onMedia: (m: UserToolMedia | null) => void;
}) {
  if (p.kind === "image" || p.kind === "mask") {
    return (
      <ToolImageInput
        label={p.label}
        value={media?.kind === "image" ? media.image : null}
        onChange={(image: ToolImage | null) =>
          onMedia(image ? { kind: "image", image } : null)
        }
      />
    );
  }
  if (p.kind === "video") {
    return (
      <ToolVideoInput
        label={p.label}
        value={media?.kind === "video" ? media.video : null}
        onChange={(video: ToolVideo | null) =>
          onMedia(video ? { kind: "video", video } : null)
        }
        note="The workflow decides how much of the clip it uses."
      />
    );
  }
  if (p.kind === "audio") {
    return (
      <ToolAudioInput
        label={p.label}
        value={media?.kind === "audio" ? media.audio : null}
        onChange={(audio: ToolAudio | null) =>
          onMedia(audio ? { kind: "audio", audio } : null)
        }
      />
    );
  }
  const id = `ut-${p.key}`;
  if (p.kind === "prompt" || p.kind === "negative") {
    return (
      <div>
        <label htmlFor={id} className={LABEL}>
          {p.label}
        </label>
        <textarea
          id={id}
          rows={p.kind === "prompt" ? 3 : 2}
          value={String(value ?? "")}
          onChange={(e) => onValue(e.target.value)}
          placeholder={p.kind === "negative" ? "Things to avoid" : "Describe what you want"}
          className={`${FIELD} resize-y`}
        />
      </div>
    );
  }
  return (
    <div className="max-w-xs">
      <label htmlFor={id} className={LABEL}>
        {p.label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={p.min}
        max={p.max}
        step={p.step ?? (p.kind === "seed" || p.kind === "steps" ? 1 : "any")}
        value={value ?? ""}
        placeholder={p.kind === "seed" ? "Random" : undefined}
        onChange={(e) => onValue(e.target.value === "" ? "" : e.target.value)}
        className={`${FIELD} tabular-nums`}
      />
    </div>
  );
}

function ManageTool({
  tool,
  onDeleted,
}: {
  tool: UserToolSummary;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(tool.name);
  const [params, setParams] = useState(tool.params);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await updateUserToolApi(fetch, tool.id, {
        name: name.trim(),
        params,
      });
      useUserToolsStore.getState().upsert(next);
      showToast("Saved.", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportPack = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await exportUserToolApi(fetch, tool.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`Exported ${filename}.`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteUserToolApi(fetch, tool.id);
      useUserToolsStore.getState().remove(tool.id);
      showToast(`${tool.name} was removed.`, "info");
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3" data-testid="user-tool-manage">
      <div className="max-w-sm">
        <label htmlFor="ut-name" className={LABEL}>
          Name
        </label>
        <input
          id="ut-name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
        />
      </div>
      {params.length > 0 && (
        <div>
          <span className={LABEL}>Settings shown when you run it</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {params.map((p) => (
              <label key={p.key} className="flex items-center gap-1.5 text-xs text-light-primary dark:text-dark-primary">
                <input
                  type="checkbox"
                  checked={p.exposed}
                  onChange={() =>
                    setParams((ps) =>
                      ps.map((x) =>
                        x.key === p.key ? { ...x, exposed: !x.exposed } : x,
                      ),
                    )
                  }
                  className="h-3.5 w-3.5 accent-splash"
                />
                {p.label}
              </label>
            ))}
          </div>
        </div>
      )}
      {tool.source.url && (
        <p className={NOTE}>
          Imported from{" "}
          <a
            href={tool.source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-splash hover:underline"
          >
            Civitai
          </a>
          .
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !name.trim()}
          className={PILL_BUTTON}
        >
          Save changes
        </button>
        <button
          type="button"
          onClick={() => void exportPack()}
          disabled={busy}
          data-testid="user-tool-export"
          title="Download a .zip with the workflow, settings and a README of the models and custom nodes it needs. Import it with Import workflow."
          className={PILL_BUTTON}
        >
          <Download className="h-3.5 w-3.5" /> Export .zip
        </button>
        {confirming ? (
          <>
            <span className="text-xs text-light-500 dark:text-dark-400">
              Remove this tool? Your images stay.
            </span>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              data-testid="user-tool-delete-confirm"
              className="flex h-9 items-center gap-1.5 rounded-full bg-red-500/10 px-3.5 text-xs font-medium text-red-600 hover:bg-red-500/20 dark:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={PILL_BUTTON}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove tool
          </button>
        )}
      </div>
      {error && <RunError message={error} />}
    </div>
  );
}
