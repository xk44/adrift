"use client";

/**
 * "Export for Blender" (zip download) and, on the computer running Adrift,
 * "Open in Blender" (disabled with the reason when Blender isn't found;
 * the tooltip names the Blender it will start). One control for every 3D
 * output: meshes, splats, body/hair GLBs, MoGe geometry (with its source
 * camera) and Layer Split parts (depth-ordered image planes). Renders
 * nothing when the job has nothing Blender can take. A job with a GLB also
 * gets "Export FBX", and any mesh or splat gets "Export for Three.js".
 */

import { useEffect, useState } from "react";
import { Box, Code2, ExternalLink, Loader2, Package } from "lucide-react";
import { showToast } from "@/components/Toast";
import {
  BLENDER_NOT_FOUND,
  BLENDER_OPEN_PATH,
  blenderOpenBody,
  blenderOpenButton,
  blenderSourceFor,
  blenderSourceHref,
  fbxHref,
  fbxRefFor,
  threejsBundleHref,
  type BlenderOpenInfo,
  type BlenderSource,
} from "@/lib/mesh/blenderLinks";

let openAvailable: Promise<BlenderOpenInfo | null> | null = null;

/** Asked once per page load: is "Open in Blender" possible here? */
function checkOpenAvailable(): Promise<BlenderOpenInfo | null> {
  openAvailable ??= fetch(BLENDER_OPEN_PATH)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: BlenderOpenInfo | null) => j ?? null)
    .catch(() => null);
  return openAvailable;
}

/** Test hook: forget the cached availability check. */
export function resetBlenderOpenCheck(): void {
  openAvailable = null;
}

export function BlenderExportActions({
  urls,
  source,
  className,
  variant = "label",
}: {
  /** The job's 3D view URLs; used when `source` is not given. */
  urls?: readonly (string | undefined)[] | undefined;
  /** What to export (from blenderSourceFor); wins over `urls`. */
  source?: BlenderSource | null;
  /** Classes for each action, matching the surrounding buttons. */
  className: string;
  /** "icon": icon-only buttons for a toolbar. */
  variant?: "label" | "icon";
}) {
  const src =
    source !== undefined ? source : blenderSourceFor({ meshUrls: urls });
  const href = src ? blenderSourceHref(src) : null;
  const [openInfo, setOpenInfo] = useState<BlenderOpenInfo | null>(null);
  const [opening, setOpening] = useState(false);
  const [exportingFbx, setExportingFbx] = useState(false);

  useEffect(() => {
    if (!href) return;
    let live = true;
    void checkOpenAvailable().then((info) => {
      if (live) setOpenInfo(info);
    });
    return () => {
      live = false;
    };
  }, [href]);

  if (!src || !href) return null;
  const icon = variant === "icon";
  const what =
    src.kind === "layers" ? "the layers as image planes" : "the model";

  const openBtn = blenderOpenButton(openInfo);
  const fbxRef = src.kind === "mesh" ? fbxRefFor(src.refs) : null;
  const threeHref = src.kind === "mesh" ? threejsBundleHref(src.refs) : null;

  // fetch, not a plain link: a conversion that fails has to say why.
  const exportFbx = async () => {
    if (!fbxRef) return;
    setExportingFbx(true);
    try {
      const res = await fetch(fbxHref(fbxRef));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fbxRef.filename.replace(/\.glb$/i, ".fbx");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      showToast(
        `Couldn't export FBX: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setExportingFbx(false);
    }
  };

  const open = async () => {
    if (openBtn.show && openBtn.disabled) {
      // Check again: the path may have been set in Settings since page load.
      resetBlenderOpenCheck();
      const info = await checkOpenAvailable();
      setOpenInfo(info);
      if (!info?.available) {
        showToast(BLENDER_NOT_FOUND, "error");
        return;
      }
    }
    setOpening(true);
    try {
      const res = await fetch(BLENDER_OPEN_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(blenderOpenBody(src)),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        folder?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      showToast(
        `Opening in Blender. Files saved to ${body?.folder ?? "the output folder"}.`,
        "success",
      );
    } catch (err) {
      showToast(
        `Couldn't open in Blender: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <>
      <a
        href={href}
        download
        className={className}
        title={`Export for Blender: a zip with ${what}, an import script and a readme`}
        aria-label={icon ? "Export for Blender" : undefined}
      >
        <Package className="w-4 h-4" />
        {!icon && " Export for Blender"}
      </a>
      {threeHref && (
        <a
          href={threeHref}
          download
          className={className}
          title="Export for Three.js: a zip with the model, a page that shows it and code to load it. Splats use the Spark renderer."
          aria-label={icon ? "Export for Three.js" : undefined}
          data-testid="threejs-export"
        >
          <Code2 className="w-4 h-4" />
          {!icon && " Export for Three.js"}
        </a>
      )}
      {fbxRef && (
        <button
          type="button"
          onClick={() => void exportFbx()}
          disabled={exportingFbx}
          className={className}
          title={`Download ${fbxRef.filename} as FBX, for apps like TouchDesigner, Maya or Unreal. Needs Blender on the computer running Adrift.`}
          aria-label={icon ? "Export FBX" : undefined}
          data-testid="fbx-export"
        >
          {exportingFbx ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Box className="w-4 h-4" />
          )}
          {!icon && " Export FBX"}
        </button>
      )}
      {openBtn.show && (
        <button
          type="button"
          onClick={() => void open()}
          disabled={opening}
          aria-disabled={openBtn.disabled || undefined}
          className={
            openBtn.disabled
              ? `${className} opacity-50 cursor-not-allowed`
              : className
          }
          title={openBtn.title}
          aria-label={icon ? "Open in Blender" : undefined}
          data-testid="blender-open"
        >
          {opening ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ExternalLink className="w-4 h-4" />
          )}
          {!icon &&
            ` Open in Blender${openInfo?.available && openInfo.version ? ` ${openInfo.version}` : ""}`}
        </button>
      )}
    </>
  );
}
