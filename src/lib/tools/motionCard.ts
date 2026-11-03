/**
 * Hub card for the AI Motion Designer (explainer / kinetic-type videos).
 * Kept out of hub.ts so the registry edit there stays one line.
 */
import type { HubCard } from "./hub";

export const MOTION_DESIGNER_KEY = "special:motion_designer";

export const MOTION_MODEL_LINE =
  "Renders in your browser · optional AI outline by Qwen3-VL 8B, voice by Kokoro, music by ACE-Step";

export function motionCards(): HubCard[] {
  return [
    {
      key: MOTION_DESIGNER_KEY,
      kind: "special",
      id: "motion_designer",
      title: "Motion Designer",
      subtitle:
        "Animated explainers, kinetic type, stat reveals and lower thirds from a brief",
      icon: "Type",
      hubCategory: "Video",
      available: true,
      unavailableReason: null,
      licenseNote: null,
      checking: false,
      model: MOTION_MODEL_LINE,
      nc: false,
      aliases: [
        "motion graphics",
        "motion design",
        "explainer",
        "kinetic typography",
        "kinetic type",
        "whiteboard",
        "lower third",
        "title card",
        "intro",
        "infographic",
        "animated text",
        "stick figure",
      ],
    },
  ];
}
