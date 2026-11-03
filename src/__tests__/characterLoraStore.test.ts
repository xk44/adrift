import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/lib/storageKeys";

const KEY = STORAGE_KEYS.characterLoras;

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage());
});

const pick = (filename: string) => ({
  filename,
  label: filename,
  strength: 0.9,
  triggers: ["trig"],
  baseFamily: null,
});

describe("characterLoraStore", () => {
  it("uses its own storage key", () => {
    expect(KEY).toBe("adrift.character-loras");
  });

  it("persists the selection (not the open picker)", async () => {
    const { useCharacterLoraStore } = await import("@/store/characterLoraStore");
    const s = useCharacterLoraStore.getState();
    s.toggle(pick("a.safetensors"));
    s.setStrength("a.safetensors", 0.8);
    s.setPickerOpen(true);
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.state).toEqual({
      selected: [{ ...pick("a.safetensors"), strength: 0.8 }],
    });
  });

  it("rehydrates and sanitizes stored rows", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          selected: [{ filename: "b.safetensors", strength: 99 }, { bad: 1 }],
          pickerOpen: true,
        },
        version: 1,
      }),
    );
    const { useCharacterLoraStore } = await import("@/store/characterLoraStore");
    const st = useCharacterLoraStore.getState();
    expect(st.selected).toEqual([
      { filename: "b.safetensors", label: "b", strength: 1.5, triggers: [], baseFamily: null },
    ]);
    expect(st.pickerOpen).toBe(false);
  });

  it("caps at two, removes triggers, toggles Use anyway, enriches blanks only", async () => {
    const { useCharacterLoraStore } = await import("@/store/characterLoraStore");
    const s = useCharacterLoraStore.getState();
    s.toggle(pick("a"));
    s.toggle(pick("b"));
    s.toggle(pick("c"));
    expect(useCharacterLoraStore.getState().selected.map((x) => x.filename)).toEqual(["a", "b"]);
    s.removeTrigger("a", "trig");
    s.setApplyAnyway("a", true);
    s.enrich("a", { triggers: ["new"], baseFamily: "sdxl" });
    s.enrich("b", { triggers: ["ignored"] });
    let [a, b] = useCharacterLoraStore.getState().selected;
    expect(a).toMatchObject({ triggers: ["new"], baseFamily: "sdxl", applyAnyway: true });
    expect(b.triggers).toEqual(["trig"]);
    s.setApplyAnyway("a", false);
    [a] = useCharacterLoraStore.getState().selected;
    expect("applyAnyway" in a).toBe(false);
    s.remove("a");
    expect(useCharacterLoraStore.getState().selected.map((x) => x.filename)).toEqual(["b"]);
  });
});
