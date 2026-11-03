import { describe, expect, it, vi } from "vitest";
import {
  comfyProxyUrl,
  extractOutputs,
  groupOutputs,
  type ExtractedOutput,
  type HistoryEntryLike,
} from "@/lib/comfy/outputs";
import { pickFinalOutput } from "@/lib/tools/pickOutput";
import { waitForOutputs, type RunnerDeps } from "@/lib/tools/pipelineRunner";
import { runVoiceChange } from "@/lib/tools/voiceChangerRunner";

/** Same mapping as GET /api/comfy/history/[promptId] (toMediaFile). */
function mediaFiles(entry: HistoryEntryLike) {
  const extracted = extractOutputs(entry);
  const groups = groupOutputs(extracted);
  const map = (o: ExtractedOutput) => ({
    ...o.view!,
    url: comfyProxyUrl(o.view!),
    nodeId: o.nodeId,
    nodeTitle: o.nodeTitle,
    ...(o.classType ? { classType: o.classType } : {}),
  });
  return {
    images: [...groups.image, ...groups.animated].map(map),
    videos: groups.video.map(map),
    audios: groups.audio.map(map),
  };
}

/** prompt = [number, prompt_id, graph, extra_data, outputs_to_execute] */
function entry(
  graph: Record<string, { class_type: string; _meta?: { title: string } }>,
  outputs: Record<string, unknown>,
): HistoryEntryLike {
  return { prompt: [0, "pid", graph, {}, Object.keys(outputs)], outputs };
}

// VibeVoice / Chatterbox TTS nodes show their own preview (temp FLAC) and
// list before the graph's SaveAudioMP3.
const ttsHistory = entry(
  {
    "3": { class_type: "VibeVoiceSingleSpeakerNode", _meta: { title: "TTS" } },
    "7": { class_type: "SaveAudioMP3", _meta: { title: "Save Speech" } },
  },
  {
    "3": {
      audio: [
        {
          filename: "ComfyUI_temp_qzxkv_00001_.flac",
          subfolder: "",
          type: "temp",
        },
      ],
    },
    "7": {
      audio: [
        {
          filename: "adrift_dub_00001_.mp3",
          subfolder: "audio",
          type: "output",
        },
      ],
    },
  },
);

// VHS_VideoCombine with save_output=false writes a temp mp4 under "gifs";
// the graph's SaveVideo writes the final under "images" (animated: [true]).
const videoHistory = entry(
  {
    "11": {
      class_type: "VHS_VideoCombine",
      _meta: { title: "Video Combine (preview)" },
    },
    "12": { class_type: "SaveVideo", _meta: { title: "Save Video" } },
  },
  {
    "11": {
      gifs: [
        {
          filename: "ComfyUI_temp_abcde_00001.mp4",
          subfolder: "",
          type: "temp",
          format: "video/h264-mp4",
        },
      ],
    },
    "12": {
      images: [
        {
          filename: "adrift_clip_00001_.mp4",
          subfolder: "video",
          type: "output",
        },
      ],
      animated: [true],
    },
  },
);

describe("pickFinalOutput", () => {
  it("prefers the saved audio over a node's temp preview", () => {
    const { audios } = mediaFiles(ttsHistory);
    expect(audios.map((a) => a.type)).toEqual(["temp", "output"]);
    const pick = pickFinalOutput(audios);
    expect(pick?.filename).toBe("adrift_dub_00001_.mp3");
    expect(pick?.nodeId).toBe("7");
  });

  it("prefers the SaveVideo file over a VHS temp preview", () => {
    const { videos } = mediaFiles(videoHistory);
    expect(videos).toHaveLength(2);
    expect(pickFinalOutput(videos)?.filename).toBe("adrift_clip_00001_.mp4");
  });

  it("prefers a Save* node over a Preview* node when both are output type", () => {
    const files = [
      { filename: "a.png", type: "output", nodeTitle: "PreviewImage" },
      {
        filename: "b.png",
        type: "output",
        nodeTitle: "My result",
        classType: "SaveImage",
      },
    ];
    expect(pickFinalOutput(files)?.filename).toBe("b.png");
  });

  it("drops a ComfyUI_temp_ name even when the type is missing", () => {
    const files = [
      { filename: "ComfyUI_temp_x_00001_.flac" },
      { filename: "music_00001_.mp3" },
    ];
    expect(pickFinalOutput(files)?.filename).toBe("music_00001_.mp3");
  });

  it("honours a named save node first", () => {
    const files = [
      {
        filename: "sheet.png",
        type: "output",
        nodeId: "20",
        nodeTitle: "Save contact sheet",
      },
      {
        filename: "views.png",
        type: "output",
        nodeId: "21",
        nodeTitle: "Save views",
      },
    ];
    expect(pickFinalOutput(files)?.filename).toBe("sheet.png");
    expect(pickFinalOutput(files, { nodeId: "21" })?.filename).toBe(
      "views.png",
    );
  });

  it("keeps history order between equal files and falls back to a temp file", () => {
    const saved = [
      { filename: "one.mp4", type: "output" },
      { filename: "two.mp4", type: "output" },
    ];
    expect(pickFinalOutput(saved)?.filename).toBe("one.mp4");
    const onlyTemp = [{ filename: "ComfyUI_temp_y_00001_.mp3", type: "temp" }];
    expect(pickFinalOutput(onlyTemp)?.filename).toBe(
      "ComfyUI_temp_y_00001_.mp3",
    );
    expect(pickFinalOutput([])).toBeUndefined();
    expect(pickFinalOutput(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Runner: history polling + pick, end to end over a mock fetch
// ---------------------------------------------------------------------------

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deps(history: HistoryEntryLike): RunnerDeps {
  let n = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    if (url === "/api/comfy/upload")
      return json({
        ref: `up${++n}${String(body?.filename).slice(-4)} [input]`,
      });
    if (url === "/api/jobs/seed-run")
      return json({ run: { run_id: `seed${++n}`, jobs: [{ index: 0 }] } });
    if (url === "/api/jobs/action")
      return json({
        run: { run_id: `r${++n}`, jobs: [{ index: 0, prompt_id: `p${n}` }] },
      });
    if (url.startsWith("/api/comfy/history/"))
      return json({ ok: true, ...mediaFiles(history) });
    throw new Error(`unexpected ${url}`);
  });
  return {
    fetchImpl,
    clientId: "c1",
    measure: async () => 3,
    sleep: async () => {},
    pollMs: 0,
  };
}

describe("runners use the saved file", () => {
  it("waitForOutputs keeps node info for the pick", async () => {
    const out = await waitForOutputs(deps(ttsHistory), "p1");
    expect(out.audios[0]).toMatchObject({ type: "temp", nodeId: "3" });
    expect(pickFinalOutput(out.audios)?.type).toBe("output");
  });

  it("voice changer returns the saved MP3, not the temp preview", async () => {
    const audio = {
      id: "a",
      previewUrl: "blob:a",
      dataUrl: "data:audio/wav;base64,AAAA",
      label: "a.wav",
      duration: 8,
    };
    const res = await runVoiceChange(
      {
        source: "audio",
        audio,
        target: { ...audio, id: "t", label: "t.mp3" },
        quality: "best",
        match: "natural",
      },
      deps(ttsHistory),
    );
    expect(res.audio.url).toContain("adrift_dub_00001_.mp3");
    expect(res.audio.url).toContain("type=output");
  });
});
