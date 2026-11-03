import type { HubCard } from "@/lib/tools/hub";
import {
  HAIRDECK_KEY,
  HAIRDECK_LICENSES,
  HAIRDECK_MODEL_LINE,
  HAIRDECK_REPO_URL,
} from "./config";

/**
 * Always listed: without HAIRDECK_BACKEND_URL the runner shows the setup
 * card instead of controls, so the card is the way to discover it.
 */
export function hairdeckCard(): HubCard {
  return {
    key: HAIRDECK_KEY,
    kind: "special",
    id: "hairdeck",
    title: "Hair Cards (HairDeck)",
    subtitle: "One portrait to game-ready 3D hair cards, via the optional HairDeck sidecar",
    icon: "Scissors",
    hubCategory: "Image",
    available: true,
    unavailableReason: null,
    licenseNote: null,
    checking: false,
    model: HAIRDECK_MODEL_LINE,
    nc: false,
    // HairDeck itself is Apache-2.0, but it needs the gated SAM 3 and DINOv3
    // weights under their own custom licenses: not counted as "commercial OK".
    weights: "check",
    weightSources: HAIRDECK_LICENSES.filter((l) => l.license !== "Apache-2.0").map((l) => ({
      license: l.license,
      url: l.url,
    })),
    aliases: ["hair", "hair cards", "hairstyle", "3d hair", "groom", "strands", "hairdeck", "vrm"],
  };
}

/** docs/TOOLS.md "Optional sidecars" section. */
export function hairdeckDocLines(): string[] {
  return [
    "## Optional sidecars",
    "",
    "Tools backed by a separate service instead of a ComfyUI graph. The card is always listed;",
    "until the service is configured it shows how to run it.",
    "",
    "| Tool | Service | Env | Output |",
    "|---|---|---|---|",
    "| Hair Cards (HairDeck) | [HairDeck](" +
      HAIRDECK_REPO_URL +
      ") Gradio demo (`python demo/app.py --port 7860`), reached over its HTTP API | `HAIRDECK_BACKEND_URL` (loopback; `HAIRDECK_ALLOW_REMOTE=1` for a LAN host) | per seed: hair-card `.glb` (with and without head proxy, optional strand chains) and card/chain JSON, saved to `output/adrift_hairdeck`; Export for Blender |",
    "",
    "HairDeck by hyz317 is Apache-2.0 (code and checkpoints). Adrift links to it and vendors nothing;",
    "the HairDeck install pulls in models under their own terms:",
    "",
    ...HAIRDECK_LICENSES.map((l) => `- ${l.name}: ${l.license} (${l.url})`),
    "",
    "VRM export needs HairDeck's session state, so it runs in the HairDeck UI or CLI, not through Adrift.",
    "",
  ];
}
