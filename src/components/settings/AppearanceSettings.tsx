"use client";

import { Check } from "lucide-react";
import { useUIStore } from "@/store";
import {
  ACCENTS,
  THEME_PRESETS,
  activePaletteId,
  getAccent,
  getPreset,
  type ThemePreset,
} from "@/lib/theme/themes";
import { PillToggle } from "./PillToggle";
import { SettingLabel } from "./SettingLabel";

type ModeChoice = "dark" | "light" | "system";

/** One-line summary for the collapsed Appearance card. */
export function useAppearanceSummary(): string {
  const theme = useUIStore((s) => s.theme);
  const darkPalette = useUIStore((s) => s.darkPalette);
  const lightPalette = useUIStore((s) => s.lightPalette);
  const accent = useUIStore((s) => s.accent);
  const preset = getPreset(
    activePaletteId({ theme, darkPalette, lightPalette }),
  );
  return `${preset?.name ?? "Adrift Dark"} · ${getAccent(accent)?.name ?? "Adrift"}`;
}

/** Mini preview of a preset: its page, a panel, two text lines, the accent. */
function PaletteCard({
  preset,
  active,
  accentHex,
  onSelect,
}: {
  preset: ThemePreset;
  active: boolean;
  accentHex: string;
  onSelect: () => void;
}) {
  const s = preset.semantic;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-testid={`palette-${preset.id}`}
      className={`group flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors ${
        active
          ? "border-splash ring-1 ring-splash"
          : "border-[var(--border-primary)] hover:border-[var(--border-secondary)]"
      }`}
    >
      <span
        aria-hidden
        className="flex h-12 w-full flex-col justify-center gap-1 rounded-md px-2"
        style={{
          background: s["--bg-primary"],
          border: `1px solid ${s["--border-primary"]}`,
        }}
      >
        <span
          className="flex items-center gap-1.5 rounded px-1.5 py-1"
          style={{ background: s["--bg-secondary"] }}
        >
          <span
            className="h-1.5 w-8 rounded-full"
            style={{ background: s["--text-primary"] }}
          />
          <span
            className="h-1.5 w-5 rounded-full"
            style={{ background: s["--text-tertiary"] }}
          />
          <span
            className="ml-auto h-2.5 w-2.5 rounded-full"
            style={{ background: accentHex }}
          />
        </span>
      </span>
      <span className="flex items-center gap-1 px-0.5 text-xs font-medium text-[var(--text-primary)]">
        <span className="min-w-0 flex-1 truncate">{preset.name}</span>
        {active ? <Check className="h-3.5 w-3.5 text-splash" /> : null}
      </span>
    </button>
  );
}

/** Settings → Appearance: mode, theme preset cards, accent swatches. */
export function AppearanceSettings() {
  const theme = useUIStore((s) => s.theme);
  const followSystem = useUIStore((s) => s.followSystem);
  const darkPalette = useUIStore((s) => s.darkPalette);
  const lightPalette = useUIStore((s) => s.lightPalette);
  const accent = useUIStore((s) => s.accent);
  const setTheme = useUIStore((s) => s.setTheme);
  const setFollowSystem = useUIStore((s) => s.setFollowSystem);
  const setPalette = useUIStore((s) => s.setPalette);
  const setAccent = useUIStore((s) => s.setAccent);

  const active = activePaletteId({ theme, darkPalette, lightPalette });
  const accentHex = getAccent(accent)?.hex ?? ACCENTS[0].hex;
  const mode: ModeChoice = followSystem ? "system" : theme;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-y-1.5">
        <SettingLabel label="Mode" />
        <PillToggle<ModeChoice>
          options={[
            { label: "Dark", value: "dark" },
            { label: "Light", value: "light" },
            { label: "System", value: "system" },
          ]}
          value={mode}
          onChange={(v) =>
            v === "system" ? setFollowSystem(true) : setTheme(v)
          }
        />
      </div>
      {followSystem ? (
        <p className="-mt-1 text-xs text-[var(--text-muted)]">
          Uses your dark and light picks below as your system switches.
        </p>
      ) : null}

      <div>
        <SettingLabel label="Theme" />
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          {THEME_PRESETS.map((preset) => (
            <PaletteCard
              key={preset.id}
              preset={preset}
              active={preset.id === active}
              accentHex={accentHex}
              onSelect={() => setPalette(preset.id)}
            />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">
          Dark mode uses {getPreset(darkPalette)?.name}; light mode uses{" "}
          {getPreset(lightPalette)?.name}.
        </p>
      </div>

      <div>
        <SettingLabel label="Accent" />
        <div
          className="mt-1.5 flex flex-wrap gap-2"
          role="group"
          aria-label="Accent color"
        >
          {ACCENTS.map((a) => {
            const selected = a.id === accent;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setAccent(a.id)}
                aria-pressed={selected}
                aria-label={a.name}
                title={a.name}
                data-testid={`accent-${a.id}`}
                className={`flex h-7 w-7 items-center justify-center rounded-full transition-transform active:scale-[0.92] ${
                  selected
                    ? "ring-2 ring-[var(--text-primary)] ring-offset-2 ring-offset-[var(--bg-secondary)]"
                    : ""
                }`}
                style={{ background: a.hex }}
              >
                {selected ? <Check className="h-3.5 w-3.5 text-white" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
