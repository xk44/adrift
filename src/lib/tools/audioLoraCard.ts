/**
 * Hub card for Train audio LoRA (Stable Audio 3, CJSA3TrainAudioLoRA node).
 * Kept out of hub.ts so the registry edit there stays one line.
 */
import type { HubCard } from "./hub";

export const TRAIN_AUDIO_LORA_KEY = "special:train_audio_lora";

export function trainAudioLoraCards(): HubCard[] {
  return [
    {
      key: TRAIN_AUDIO_LORA_KEY,
      kind: "special",
      id: "train_audio_lora",
      title: "Train Audio LoRA",
      subtitle:
        "5-50 sound clips become a LoRA that steers Stable Audio 3 toward your sound",
      icon: "AudioLines",
      hubCategory: "Audio",
      // The runner checks for the trainer node itself and explains what is missing.
      available: true,
      unavailableReason: null,
      licenseNote: null,
      checking: false,
      model: "Stable Audio 3 LoRA · trained on your GPU",
      nc: false,
      aliases: [
        "train audio lora",
        "audio lora",
        "sound lora",
        "music lora",
        "sfx lora",
        "train sound",
        "stable audio lora",
        "sa3 lora",
      ],
    },
  ];
}
