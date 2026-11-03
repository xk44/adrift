"use client";

import { useEffect, useRef } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import {
  hrefWithImage,
  imageIdFromHref,
  lightboxUrlUpdate,
} from "@/lib/ui/lightboxUrl";

/**
 * Param format: `?image=<imageId>`
 *
 * - Opening lightbox pushes `?image=...` via history.pushState
 * - Closing lightbox (Escape, X, swipe, any closeLightbox) removes the param
 *   via history.pushState, so a reload doesn't reopen it
 * - Navigating prev/next replaces the param via history.replaceState
 * - On mount, if param exists, finds image in gallery and opens lightbox
 *   (a param that matches no image is stripped)
 * - Listens to popstate for browser back/forward
 *
 * MUST be mounted somewhere that outlives the lightbox (see LightboxUrlSync):
 * the Lightbox component itself unmounts on close, so a hook living inside it
 * never sees the close.
 *
 * Reads window.location (inside effects) instead of next/navigation's search
 * params hook, so an always-mounted caller doesn't force a Suspense boundary
 * on the page.
 */
export function useLightboxUrl() {
  const lightbox = useUIStore((s) => s.lightbox);
  const openLightbox = useUIStore((s) => s.openLightbox);
  const closeLightbox = useUIStore((s) => s.closeLightbox);
  const gallery = useGenerationStore((s) => s.gallery);

  // Track whether we're the ones causing the state change to avoid loops
  const suppressUrlSync = useRef(false);
  const suppressStoreSync = useRef(false);

  const currentImageId = lightbox?.images[lightbox.index]?.id ?? null;

  // --- Deep link: on mount, if URL has image param, open lightbox ---
  // Gallery may not be hydrated from persist yet on first render, so we
  // keep retrying until the gallery is populated or we successfully open.
  const initialParamHandled = useRef(false);
  useEffect(() => {
    if (initialParamHandled.current) return;

    const imageId = imageIdFromHref(window.location.href);
    if (!imageId) {
      initialParamHandled.current = true;
      return;
    }
    if (gallery.length === 0) return; // wait for hydration

    const idx = gallery.findIndex((img) => img.id === imageId);
    initialParamHandled.current = true;
    if (idx < 0) {
      // Stale/unknown id — drop it rather than leave a dead param behind.
      window.history.replaceState(
        window.history.state,
        "",
        hrefWithImage(window.location.href, null),
      );
      return;
    }

    suppressUrlSync.current = true;
    openLightbox({ images: gallery, index: idx, origin: "create" });
    // Let the effect cycle complete before re-enabling sync
    requestAnimationFrame(() => {
      suppressUrlSync.current = false;
    });
  }, [gallery, openLightbox]);

  // --- Sync lightbox state -> URL ---
  const prevImageId = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevImageId.current;
    prevImageId.current = currentImageId;
    // Deep-link / popstate driven changes already match the URL.
    if (suppressUrlSync.current) return;

    const update = lightboxUrlUpdate(
      window.location.href,
      prev,
      currentImageId,
    );
    if (!update) return;

    suppressStoreSync.current = true;
    if (update.mode === "push") {
      window.history.pushState(null, "", update.href);
    } else {
      window.history.replaceState(window.history.state, "", update.href);
    }
    requestAnimationFrame(() => {
      suppressStoreSync.current = false;
    });
  }, [currentImageId]);

  // --- Browser back/forward: sync URL -> lightbox state ---
  useEffect(() => {
    const handlePopState = () => {
      if (suppressStoreSync.current) return;

      const imageId = imageIdFromHref(window.location.href);
      suppressUrlSync.current = true;

      if (imageId) {
        // Forward navigation or back to a previous image
        const galleryNow = useGenerationStore.getState().gallery;
        const idx = galleryNow.findIndex((img) => img.id === imageId);
        if (idx >= 0) {
          openLightbox({ images: galleryNow, index: idx, origin: "create" });
        }
      } else {
        // Back navigation: close lightbox
        closeLightbox();
      }

      requestAnimationFrame(() => {
        suppressUrlSync.current = false;
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [openLightbox, closeLightbox]);
}

/** Always-mounted host for useLightboxUrl (renders nothing). */
export function LightboxUrlSync(): null {
  useLightboxUrl();
  return null;
}

/** Shareable deep link for an image (current page + `?image=<id>`). */
export function lightboxShareUrl(imageId: string | null): string | null {
  if (!imageId || typeof window === "undefined") return null;
  return hrefWithImage(window.location.href, imageId);
}
