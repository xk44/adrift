"use client";

import { useEffect, useState } from "react";
import {
  fetchFilmstrip,
  fetchWaveform,
  type FilmstripDto,
  type WaveformDto,
} from "@/lib/videoEdit/client";
import { FILMSTRIP_MAX_TILES } from "@/lib/videoEdit/requests";

/** Strip tile height (px) requested from the server (2x the row height). */
export const STRIP_TILE_HEIGHT = 96;

/** Tiles for a source: about two per second, 8..60. */
export function stripTileCount(duration: number): number {
  return Math.max(8, Math.min(FILMSTRIP_MAX_TILES, Math.round(duration * 2)));
}

const cache = new Map<string, Promise<FilmstripDto | null>>();

/** Filmstrip sprite for a source (null while loading or when it failed). */
export function useFilmstrip(
  url: string,
  duration: number,
): FilmstripDto | null {
  const [strip, setStrip] = useState<FilmstripDto | null>(null);
  useEffect(() => {
    let live = true;
    const count = stripTileCount(duration);
    // The server picks the tile count from the source, so one strip per url.
    const key = url;
    let p = cache.get(key);
    if (!p) {
      p = fetchFilmstrip(url, count, STRIP_TILE_HEIGHT).catch(() => {
        cache.delete(key);
        return null;
      });
      cache.set(key, p);
    }
    void p.then((s) => {
      if (live) setStrip(s);
    });
    return () => {
      live = false;
    };
  }, [url, duration]);
  return strip;
}

/** Waveform image height (px) requested from the server. */
export const WAVE_HEIGHT = 64;

const waves = new Map<string, Promise<WaveformDto | null>>();

/** Waveform for a source (null while loading, without audio or on error). */
export function useWaveform(
  url: string,
  hasAudio: boolean,
  audioFile = false,
): WaveformDto | null {
  const [wave, setWave] = useState<WaveformDto | null>(null);
  useEffect(() => {
    if (!hasAudio) {
      setWave(null);
      return;
    }
    let live = true;
    const key = audioFile ? `audio:${url}` : url;
    let p = waves.get(key);
    if (!p) {
      p = fetchWaveform(url, WAVE_HEIGHT, undefined, audioFile).catch(() => {
        waves.delete(key);
        return null;
      });
      waves.set(key, p);
    }
    void p.then((w) => {
      if (live) setWave(w);
    });
    return () => {
      live = false;
    };
  }, [url, hasAudio, audioFile]);
  return wave;
}
