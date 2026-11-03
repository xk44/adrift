"use client";

import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS, readLocalStorage } from "@/lib/storageKeys";
import type { GalleryImage } from "@/types";
import { sessionNameFromPrompt, type StyleSession } from "./styleCreatorLogic";

const SESSIONS_STORAGE_KEY = STORAGE_KEYS.styleSessions;

export function loadSessions(): StyleSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readLocalStorage(SESSIONS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: StyleSession[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // storage full — silently skip
  }
}

/**
 * Deterministic style code from selected images.
 * Hashes the sorted image URLs + seeds into a short hex string (--sref format).
 */
export function generateStyleCodeFromImages(
  images: Pick<GalleryImage, "url" | "seed">[],
): string {
  const input = images
    .map((img) => `${img.url}:${img.seed}`)
    .sort()
    .join("|");

  // Simple FNV-1a-inspired hash for determinism
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Second pass for more entropy
  let h2 = 0x6c62272e;
  for (let i = input.length - 1; i >= 0; i--) {
    h2 ^= input.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193);
  }

  const hex1 = (h >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return (hex1 + hex2).slice(0, 12);
}

/** New draft session object (pure, so the shape is testable). */
export function newStyleSession(
  existingCount: number,
  now: Date,
  prompt?: string,
  imageIds: readonly string[] = [],
): StyleSession {
  const iso = now.toISOString();
  const fallbackName = `Style ${existingCount + 1}`;
  return {
    id: `session-${now.getTime()}`,
    name: prompt ? sessionNameFromPrompt(prompt, fallbackName) : fallbackName,
    createdAt: iso,
    updatedAt: iso,
    selectedImageIds: [...new Set(imageIds)],
    status: "draft",
    ...(prompt ? { prompt } : {}),
  };
}

/**
 * Creator sessions kept in localStorage, used by the Styles page creator
 * panel.
 */
export function useStyleSessions() {
  const [sessions, setSessions] = useState<StyleSession[]>([]);

  useEffect(() => {
    setSessions(loadSessions());
  }, []);

  const updateSession = useCallback(
    (id: string, update: Partial<StyleSession>) => {
      setSessions((prev) => {
        const updated = prev.map((s) =>
          s.id === id
            ? { ...s, ...update, updatedAt: new Date().toISOString() }
            : s,
        );
        saveSessions(updated);
        return updated;
      });
    },
    [],
  );

  /** Creates and persists a session; returns its id. */
  const createSession = useCallback(
    (prompt?: string, imageIds?: readonly string[]) => {
      const session = newStyleSession(
        sessions.length,
        new Date(),
        prompt,
        imageIds,
      );
      const updated = [session, ...sessions];
      setSessions(updated);
      saveSessions(updated);
      return session.id;
    },
    [sessions],
  );

  const deleteSession = useCallback(
    (id: string) => {
      const updated = sessions.filter((s) => s.id !== id);
      setSessions(updated);
      saveSessions(updated);
    },
    [sessions],
  );

  return { sessions, createSession, updateSession, deleteSession };
}
