/**
 * File name for audio handed from the lightbox to an audio-in tool: the
 * gallery URL's filename when it has an audio extension ComfyUI's LoadAudio
 * takes, else "audio.mp3" (Adrift saves audio as MP3).
 */
const AUDIO_EXT = /\.(wav|mp3|m4a|flac)$/i;

export function handoffAudioFileName(url: string): string {
  try {
    const u = new URL(url, "http://localhost");
    const candidates = [
      u.searchParams.get("filename") ?? "",
      decodeURIComponent(u.pathname.split("/").pop() ?? ""),
    ];
    for (const c of candidates) {
      const base = c.split(/[\\/]/).pop() ?? "";
      if (AUDIO_EXT.test(base)) return base;
    }
  } catch {
    /* not a URL: fall through */
  }
  return "audio.mp3";
}
