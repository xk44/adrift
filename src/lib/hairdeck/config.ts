/**
 * HairDeck sidecar (hyz317/HairDeck, Apache-2.0): one portrait -> strand-
 * aligned 3D hair cards (.glb). It is a separate Python app (Gradio demo),
 * not a ComfyUI node, so Adrift talks to it over HTTP when
 * HAIRDECK_BACKEND_URL is set. Shared by the routes, the runner and the docs.
 */
import { isLoopbackHostname } from "@/lib/net/bindPolicy";
import { sniffImageType } from "@/lib/net/readCapped";

export const HAIRDECK_KEY = "special:hairdeck";
export const HAIRDECK_REPO_URL = "https://github.com/hyz317/HairDeck";
export const HAIRDECK_WEIGHTS_URL = "https://huggingface.co/hyz317/HairDeck";
export const HAIRDECK_MODEL_LINE = "HairDeck sidecar · Apache-2.0";

/** Licenses of what the HairDeck install pulls in (linked, never vendored). */
export const HAIRDECK_LICENSES: readonly {
  name: string;
  license: string;
  url: string;
}[] = [
  {
    name: "HairDeck code + checkpoints",
    license: "Apache-2.0",
    url: HAIRDECK_REPO_URL,
  },
  {
    name: "SAM 3 (hair segmentation, gated)",
    license: "SAM License",
    url: "https://huggingface.co/facebook/sam3",
  },
  {
    name: "DINOv3 (image encoder, gated)",
    license: "DINOv3 License",
    url: "https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m",
  },
  {
    name: "BiRefNet matting",
    license: "MIT",
    url: "https://github.com/ZhengPeng7/BiRefNet",
  },
  {
    name: "Blender + VRM Add-on (optional VRM export)",
    license: "GPL",
    url: "https://www.blender.org/about/license/",
  },
];

/** Commands shown on the "not connected" card (GPU machine, then this one). */
export const HAIRDECK_SETUP_STEPS: readonly { text: string; cmd?: string }[] = [
  {
    text: "On the GPU machine, install HairDeck from its README (its own Python env; accept the SAM 3 and DINOv3 licenses on Hugging Face).",
  },
  {
    text: "Start the demo. It listens on 127.0.0.1 only:",
    cmd: "python demo/app.py --port 7860",
  },
  {
    text: "If it runs on another machine, tunnel the port to this one:",
    cmd: "ssh -N -L 7860:127.0.0.1:7860 <gpu-host>",
  },
  {
    text: "Point Adrift at it in .env.local, then restart Adrift:",
    cmd: "HAIRDECK_BACKEND_URL=http://127.0.0.1:7860",
  },
];

export const HAIRDECK_STEPS = [10, 50] as const;
export type HairDeckSteps = (typeof HAIRDECK_STEPS)[number];
export const HAIRDECK_DEFAULT_STEPS: HairDeckSteps = 50;
export const HAIRDECK_CFG_MIN = 1;
export const HAIRDECK_CFG_MAX = 4;
export const HAIRDECK_DEFAULT_CFG = 2;
export const HAIRDECK_MAX_VARIATIONS = 4;
export const HAIRDECK_SEED_MAX = 2_147_483_647;
/** Decoded portrait cap (the demo itself accepts up to 60 MB). */
export const HAIRDECK_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Raw JSON body cap: base64 of the image plus a little. */
export const HAIRDECK_MAX_BODY_BYTES =
  Math.ceil((HAIRDECK_MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;

export interface HairDeckRequest {
  image: { mime: "image/png" | "image/jpeg" | "image/webp"; bytes: Uint8Array };
  seed: number;
  steps: HairDeckSteps;
  cfg: number;
  variations: number;
  chains: boolean;
}

export type HairDeckConfig =
  | { configured: false }
  | { configured: true; url: string }
  | { configured: true; url: null; error: string };

/**
 * HAIRDECK_BACKEND_URL, normalized (no trailing slash). The demo binds
 * loopback, so a non-loopback host needs HAIRDECK_ALLOW_REMOTE=1.
 */
export function hairdeckConfig(
  envVars: Record<string, string | undefined> = process.env,
): HairDeckConfig {
  const raw = envVars.HAIRDECK_BACKEND_URL?.trim();
  if (!raw) return { configured: false };
  const bad = (error: string) => ({
    configured: true as const,
    url: null,
    error,
  });
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad("HAIRDECK_BACKEND_URL is not a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return bad("HAIRDECK_BACKEND_URL must be an http(s) URL.");
  if (u.username || u.password || u.search || u.hash)
    return bad(
      "HAIRDECK_BACKEND_URL must not carry credentials, a query or a fragment.",
    );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopbackHostname(host) && envVars.HAIRDECK_ALLOW_REMOTE !== "1")
    return bad(
      "HAIRDECK_BACKEND_URL must point at this machine (tunnel the port with ssh -L), or set HAIRDECK_ALLOW_REMOTE=1.",
    );
  return {
    configured: true,
    url: `${u.origin}${u.pathname.replace(/\/+$/, "")}`,
  };
}

const DATA_URL_RE =
  /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Strict parse of the POST /api/hairdeck/generate body. */
export function parseHairDeckRequest(
  body: unknown,
): { ok: true; value: HairDeckRequest } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!body || typeof body !== "object" || Array.isArray(body))
    return fail("Expected a JSON object.");
  const b = body as Record<string, unknown>;
  const allowed = new Set([
    "image",
    "seed",
    "steps",
    "cfg",
    "variations",
    "chains",
  ]);
  const extra = Object.keys(b).find((k) => !allowed.has(k));
  if (extra) return fail(`Unknown field "${extra}".`);

  if (typeof b.image !== "string") return fail("image must be a data: URL.");
  const m = DATA_URL_RE.exec(b.image);
  if (!m) return fail("image must be a base64 PNG, JPEG or WebP data: URL.");
  if (Math.floor((m[2].length * 3) / 4) > HAIRDECK_MAX_IMAGE_BYTES + 2)
    return fail(
      `image is larger than ${HAIRDECK_MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    );
  const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
  if (bytes.length > HAIRDECK_MAX_IMAGE_BYTES)
    return fail(
      `image is larger than ${HAIRDECK_MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    );
  const mime = m[1] as HairDeckRequest["image"]["mime"];
  if (sniffImageType(bytes) !== mime)
    return fail("image content does not match its type.");

  const seed = b.seed;
  if (
    typeof seed !== "number" ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > HAIRDECK_SEED_MAX
  )
    return fail(`seed must be an integer from 0 to ${HAIRDECK_SEED_MAX}.`);
  const steps = b.steps ?? HAIRDECK_DEFAULT_STEPS;
  if (!HAIRDECK_STEPS.includes(steps as HairDeckSteps))
    return fail(`steps must be one of ${HAIRDECK_STEPS.join(", ")}.`);
  const cfg = b.cfg ?? HAIRDECK_DEFAULT_CFG;
  if (
    typeof cfg !== "number" ||
    !Number.isFinite(cfg) ||
    cfg < HAIRDECK_CFG_MIN ||
    cfg > HAIRDECK_CFG_MAX ||
    !Number.isInteger(cfg * 4)
  )
    return fail(
      `cfg must be ${HAIRDECK_CFG_MIN} to ${HAIRDECK_CFG_MAX} in steps of 0.25.`,
    );
  const variations = b.variations ?? 1;
  if (
    typeof variations !== "number" ||
    !Number.isInteger(variations) ||
    variations < 1 ||
    variations > HAIRDECK_MAX_VARIATIONS
  )
    return fail(`variations must be 1 to ${HAIRDECK_MAX_VARIATIONS}.`);
  const chains = b.chains ?? false;
  if (typeof chains !== "boolean") return fail("chains must be true or false.");

  return {
    ok: true,
    value: {
      image: { mime, bytes },
      seed,
      steps: steps as HairDeckSteps,
      cfg,
      variations,
      chains,
    },
  };
}
