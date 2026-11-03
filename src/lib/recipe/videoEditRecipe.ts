/**
 * Recipe for a video editor export, written into the MP4 as its metadata
 * comment. Sources are referenced by the content hash in their upload name
 * (no paths); clips without one are listed without a hash.
 */

import { buildRecipe, HASHED_NAME_RE, recipeJson, type AdriftRecipe } from "./recipe";

export interface VideoEditPiece {
  path: string;
  in: number;
  out: number;
  audio: boolean;
  xfadeIn?: number;
}

/** A2 lane piece: source range and where it starts in the export. */
export interface VideoEditLanePiece {
  path: string;
  in: number;
  out: number;
  at: number;
}

const ms = (n: number) => Math.round(n * 1000) / 1000;

function inputFor(path: string, role: string) {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const hash = HASHED_NAME_RE.exec(base)?.[1];
  const ext = base.includes(".") ? base.split(".").pop()?.toLowerCase() : undefined;
  return {
    role,
    ...(hash ? { sha256: hash } : {}),
    ...(ext && /^[a-z0-9]{1,8}$/.test(ext) ? { ext } : {}),
  };
}

export function buildVideoEditRecipe(
  pieces: VideoEditPiece[],
  fmt: { width: number; height: number; fps: number },
  adriftVersion: string,
  lane: VideoEditLanePiece[] = [],
): AdriftRecipe {
  const recipe = buildRecipe({
    params: {
      width: fmt.width,
      height: fmt.height,
      fps: fmt.fps,
      pieces: pieces.map((p) => ({
        in: ms(p.in),
        out: ms(p.out),
        audio: p.audio,
        ...(p.xfadeIn ? { xfadeIn: ms(p.xfadeIn) } : {}),
      })),
      ...(lane.length
        ? { audio: lane.map((l) => ({ in: ms(l.in), out: ms(l.out), at: ms(l.at) })) }
        : {}),
    },
    adriftVersion,
    tool: { kind: "video_editor", id: "video_editor", label: "Video editor" },
  });
  recipe.inputs = [
    ...pieces.map((p) => inputFor(p.path, "video")),
    ...lane.map((l) => inputFor(l.path, "audio")),
  ];
  return recipe;
}

/** ffmpeg `-metadata comment=` value. */
export function videoEditRecipeComment(recipe: AdriftRecipe): string {
  return recipeJson(recipe);
}
