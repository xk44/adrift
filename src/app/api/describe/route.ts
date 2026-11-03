import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { apiCorsHeaders } from "@/lib/api";
import { guardRoute } from "@/lib/routeGuard";
import { env } from "@/lib/env";
import { plainCaption } from "@/lib/describeCaption";
import {
  extFromUrl,
  readImageBytes,
  resolveImageSource,
} from "@/lib/moodboards/resolve";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type ImagePayload = {
  bytes: Buffer;
  filename: string;
  contentType: string;
};

function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}

function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function normalizeCaption(caption: string): string {
  return caption
    .replace(/\s+/g, " ")
    .replace(/^ohwx,\s*/i, "")
    .trim()
    .replace(/[.!?]+$/, "");
}

function promptSuggestions(caption: string): string[] {
  const subject = normalizeCaption(caption) || "the image subject";
  return [
    `${subject}, detailed composition, natural lighting, expressive visual storytelling --v 6`,
    `cinematic editorial style, ${subject}, refined color palette, sharp focus, atmospheric depth --v 6`,
    `fine art photograph of ${subject}, high detail, balanced framing, gallery-quality finish --v 6`,
    `${subject}, moody and immersive, soft contrast, textured ambience, dreamlike realism --v 6`,
  ];
}

/**
 * Moodboard/upload paths resolve through the shared containment rules in
 * lib/moodboards/resolve; http(s) sources go through safeFetch (no private,
 * loopback or metadata addresses).
 */
async function readSourceImage(value: string): Promise<ImagePayload | null> {
  const source = await resolveImageSource(value);
  if (!source) return null;
  if (source.kind === "local") {
    const stat = await fs.stat(source.path).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
  }
  const bytes = await readImageBytes(source);
  if (!bytes || bytes.length > MAX_IMAGE_BYTES) return null;
  const filename =
    source.kind === "local"
      ? path.basename(source.path)
      : `image${extFromUrl(source.url)}`;
  return { bytes, filename, contentType: mimeFromFilename(filename) };
}

async function readRequestImage(
  request: NextRequest,
): Promise<ImagePayload | null> {
  const form = await request.formData();
  const file = form.get("image") ?? form.get("file");
  if (file instanceof File) {
    if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) {
      return null;
    }
    return {
      bytes: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "uploaded-image.png",
      contentType: file.type || mimeFromFilename(file.name),
    };
  }

  const source = form.get("source") ?? form.get("imageUrl") ?? form.get("path");
  if (typeof source !== "string" || !source.trim()) return null;
  return readSourceImage(source.trim());
}

async function captionImage(payload: ImagePayload): Promise<string> {
  const url = new URL("/caption/image", env.STYLEVAULT_API_URL);
  const requestBody = payload.bytes.buffer.slice(
    payload.bytes.byteOffset,
    payload.bytes.byteOffset + payload.bytes.byteLength,
  ) as ArrayBuffer;
  url.searchParams.set("filename", payload.filename);
  url.searchParams.set(
    "prompt",
    "Write one image-generation prompt for this image as plain prose, 1-3 sentences, under 70 words: " +
      "subject, setting, medium, lighting, mood and style. No headings, labels, lists or markdown.",
  );

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": payload.contentType },
    body: requestBody,
    signal: AbortSignal.timeout(60000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.detail || body?.error || "StyleVault caption failed");
  }
  if (typeof body?.caption !== "string" || !body.caption.trim()) {
    throw new Error("StyleVault returned an empty caption");
  }
  return body.caption.trim();
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: apiCorsHeaders(null, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = guardRoute(request, { max: 20 });
  if (!auth.ok) return auth.response;

  try {
    const image = await readRequestImage(request);
    if (!image) {
      return jsonResponse(
        {
          ok: false,
          error: "Upload an image file or provide a valid internal image path.",
        },
        400,
      );
    }

    const caption = plainCaption(await captionImage(image));
    return jsonResponse({
      ok: true,
      caption,
      suggestions: promptSuggestions(caption),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Describe] Error:", message);
    return jsonResponse(
      {
        ok: false,
        error: `StyleVault captioning is unavailable. Start StyleVault at ${env.STYLEVAULT_API_URL} and try again.`,
      },
      503,
    );
  }
}
