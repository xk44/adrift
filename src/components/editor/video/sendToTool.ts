/**
 * Video editor → hub tool: cut a timeline range, hand it to a tool card and
 * remember the launch, so the run's result comes back to Results as a new
 * take for the same place. Shared by the Tools panel and the clip menu.
 */
import { showToast } from "@/components/Toast";
import { navigateTo } from "@/hooks/useNavSync";
import { useOverlayToolsStore } from "@/store/overlayToolsStore";
import { useToolHandoffStore } from "@/store/toolHandoffStore";
import {
  playheadFps,
  useVideoEditStore,
  type TimeRange,
} from "@/store/videoEditStore";
import {
  clipAt,
  formatTimecode,
  timelineDuration,
} from "@/lib/videoEdit/editList";
import { renderEdit } from "@/lib/videoEdit/client";
import { MAX_RANGE_SECONDS } from "@/lib/videoEdit/requests";
import {
  RETAKE_TOOL_KEY,
  retakePlan,
  retakePrefillPicks,
} from "@/lib/videoEdit/retake";
import { bridgePlan } from "@/lib/videoEdit/bridge";
import type { LightboxTool } from "@/lib/ui/lightboxTools";
import {
  picksToOccurrences,
  toolRange,
  videoToolHandoff,
  type VideoEditorTool,
} from "@/lib/videoEdit/videoTools";

const fmt = (t: number) => formatTimecode(t, 0);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function openCard(toolKey: string) {
  useOverlayToolsStore.getState().openToolFromLauncher(toolKey, false);
  navigateTo("tools");
}

/** Retake: cut the range plus context, prefill the range in the card. */
export async function sendRangeToRetake(range: TimeRange): Promise<boolean> {
  const s = useVideoEditStore.getState();
  if (!s.edit) return false;
  const plan = retakePlan(
    range,
    timelineDuration(s.edit),
    playheadFps(s.edit, range.start),
  );
  if (!plan.ok) {
    showToast(plan.reason, "info", 6000);
    return false;
  }
  const cutPlan = plan.cut;
  s.setRate(0);
  try {
    const cut = await renderEdit({
      mode: "range",
      edit: s.edit,
      start: cutPlan.cutStart,
      end: cutPlan.cutEnd,
      label: s.label,
    });
    const now = Date.now();
    const handoff = videoToolHandoff(
      { key: RETAKE_TOOL_KEY, target: { kind: "open", toolKey: RETAKE_TOOL_KEY } },
      cut,
      `${s.label || "Video"} ${fmt(cutPlan.cutStart)}-${fmt(cutPlan.cutEnd)}`,
      [],
      now,
    );
    useVideoEditStore.getState().addLaunch({
      itemId: handoff.itemId,
      title: "Retake",
      start: cutPlan.cutStart,
      end: cutPlan.cutEnd,
      cutUrl: cut.url,
      at: now,
    });
    const store = useToolHandoffStore.getState();
    store.offer(handoff);
    store.offerPrefill({
      toolKey: RETAKE_TOOL_KEY,
      settings: { picks: retakePrefillPicks(cutPlan) },
      at: now,
    });
    openCard(RETAKE_TOOL_KEY);
    return true;
  } catch (e) {
    showToast(`Could not cut the range: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}

/** Cut the part of `range` the tool renders and open the tool with it. */
export async function sendRangeToTool(
  tool: VideoEditorTool,
  range: TimeRange,
): Promise<boolean> {
  if (tool.key === RETAKE_TOOL_KEY) return sendRangeToRetake(range);
  const s = useVideoEditStore.getState();
  if (!s.edit) return false;
  if (range.end - range.start > MAX_RANGE_SECONDS) {
    showToast(
      `Tools take at most ${MAX_RANGE_SECONDS} s. Mark a shorter range with I and O.`,
      "info",
      6000,
    );
    return false;
  }
  s.setRate(0);
  try {
    const edit = s.edit;
    // Only the part the tool renders is cut, sent and later replaced.
    const part = toolRange(
      tool,
      range.start,
      range.end,
      playheadFps(edit, range.start),
    );
    const cut = await renderEdit({
      mode: "range",
      edit,
      start: part.start,
      end: part.end,
      label: s.label,
    });
    const smartTrack = tool.smartSelect
      ? picksToOccurrences(s.picks, part.start, part.end, cut, (t) => {
          const at = clipAt(edit, t);
          return at ? at.clip.src : null;
        })
      : [];
    const now = Date.now();
    const handoff = videoToolHandoff(
      tool,
      cut,
      `${s.label || "Video"} ${fmt(part.start)}-${fmt(part.end)}`,
      smartTrack,
      now,
    );
    useVideoEditStore.getState().addLaunch({
      itemId: handoff.itemId,
      title: tool.title,
      start: part.start,
      end: part.end,
      cutUrl: cut.url,
      at: now,
    });
    useToolHandoffStore.getState().offer(handoff);
    openCard(handoff.toolKey);
    return true;
  } catch (e) {
    showToast(`Could not cut the range: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}

/**
 * Bridge the cut after `clipId`: grab the last frame of that clip and the
 * first of the next, open a start/end-frame tool with both, and remember a
 * zero-length launch at the cut so the result is offered as "Insert at cut".
 */
export async function sendBridge(
  tool: Pick<LightboxTool, "key" | "title">,
  clipId: string,
): Promise<boolean> {
  const s = useVideoEditStore.getState();
  if (!s.edit) return false;
  const plan = bridgePlan(s.edit, clipId);
  if (!plan) {
    showToast("There is no next clip to bridge to.", "info", 5000);
    return false;
  }
  const edit = s.edit;
  s.setRate(0);
  try {
    const [from, to] = await Promise.all([
      renderEdit({ mode: "frame", edit, t: plan.fromT, label: s.label }),
      renderEdit({ mode: "frame", edit, t: plan.toT, label: s.label }),
    ]);
    const now = Date.now();
    const name = s.label || "Video";
    const handoff = {
      toolKey: tool.key,
      media: "image" as const,
      itemId: `video-editor:${now}`,
      url: from.url,
      label: `${name}: end of clip ${plan.left}`,
      width: from.width,
      height: from.height,
      origin: "video-editor" as const,
      moreImages: [
        {
          url: to.url,
          label: `${name}: start of clip ${plan.right}`,
          width: to.width,
          height: to.height,
        },
      ],
      at: now,
    };
    useVideoEditStore.getState().addLaunch({
      itemId: handoff.itemId,
      title: tool.title,
      start: plan.cut,
      end: plan.cut,
      cutUrl: "",
      at: now,
    });
    useToolHandoffStore.getState().offer(handoff);
    openCard(tool.key);
    return true;
  } catch (e) {
    showToast(`Could not grab the frames: ${errMsg(e)}`, "error", 8000);
    return false;
  }
}
