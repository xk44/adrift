/**
 * Hub card for Train Identity (per-user identity LoRA through the StyleVault
 * trainer). Kept out of hub.ts so the registry edit there stays one line.
 */
import type { HubCard } from "./hub";

export const TRAIN_IDENTITY_KEY = "special:train_identity";

export function trainIdentityCards(): HubCard[] {
  return [
    {
      key: TRAIN_IDENTITY_KEY,
      kind: "special",
      id: "train_identity",
      title: "Train Identity",
      subtitle:
        "10-30 photos of one person become a personal LoRA you can call from any prompt",
      icon: "Users",
      hubCategory: "Identity",
      // The runner checks the trainer itself and explains what is missing.
      available: true,
      unavailableReason: null,
      licenseNote: null,
      checking: false,
      model: "Krea 2 LoRA · musubi-tuner on your GPU",
      nc: false,
      aliases: [
        "soul id",
        "train identity",
        "identity lora",
        "face lora",
        "character lora",
        "train lora",
        "personal model",
        "consistent character",
      ],
    },
  ];
}
