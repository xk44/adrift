import { beforeEach, describe, expect, it } from "vitest";
import {
  IDENTITY_ENGINES,
  PROFILE_LOOK_FIELDS,
  PROFILE_MAX_REFS,
  PROFILE_STORAGE_BUDGET,
  applyProfileSuffix,
  buildProfile,
  compileProfileLook,
  fromStoredRef,
  identityEngine,
  pickProfileSlot,
  profilePromptSuffix,
  sanitizeProfiles,
  toStoredRef,
  validateProfileDraft,
} from "@/lib/tools/characterProfiles";
import { useCharacterProfileStore } from "@/store/characterProfileStore";
import { buildHubCards, CHARACTER_PROFILES_KEY } from "@/lib/tools/hub";
import type { ToolImage } from "@/lib/tools/runTool";

const upload = (n = 1, bytes = 40): ToolImage => ({
  id: `upload:${n}`,
  source: "upload",
  previewUrl: `data:image/jpeg;base64,${"A".repeat(bytes)}`,
  dataUrl: `data:image/jpeg;base64,${"A".repeat(bytes)}`,
  label: `face${n}.jpg`,
  width: 768,
  height: 1024,
});

const gallery = (n = 1): ToolImage => ({
  id: `g${n}`,
  source: "gallery",
  previewUrl: `/api/comfy/view?filename=g${n}.png`,
  dataUrl: "data:image/png;base64,ZZZ",
  label: "portrait",
  width: 1024,
  height: 1024,
  runId: `run${n}`,
  jobIndex: 2,
});

describe("characterProfiles lib", () => {
  it("validates name and 1-4 references", () => {
    expect(validateProfileDraft({ name: " ", refs: [upload()] })).toMatch(
      /name/,
    );
    expect(validateProfileDraft({ name: "Mara", refs: [null] })).toMatch(
      /at least one/,
    );
    expect(
      validateProfileDraft({
        name: "Mara",
        refs: Array.from({ length: 5 }, (_, i) => upload(i)),
      }),
    ).toMatch(/at most 4/);
    expect(
      validateProfileDraft({
        name: "Mara",
        refs: [{ ...upload(), dataUrl: undefined }],
      }),
    ).toMatch(/loading/);
    expect(
      validateProfileDraft({ name: "Mara", refs: [upload(), gallery()] }),
    ).toBeNull();
  });

  it("stores uploads once and gallery picks without pixels", () => {
    const u = toStoredRef(upload());
    expect(u.previewUrl).toBe("");
    expect(u.dataUrl).toMatch(/^data:image\//);
    expect(fromStoredRef(u).previewUrl).toBe(u.dataUrl);

    const g = toStoredRef(gallery());
    expect(g.dataUrl).toBeUndefined();
    expect(g).toMatchObject({ runId: "run1", jobIndex: 2 });
    expect(fromStoredRef(g).previewUrl).toBe(gallery().previewUrl);
  });

  it("builds a normalized profile and keeps id/createdAt on edit", () => {
    const p = buildProfile(
      {
        name: "  Mara   Vale ",
        refs: [upload(), null, gallery()],
        look: { archetype: "sage", build: "any", outfit: "bogus" },
        suffix: "  copper   hair ",
        engine: "nope",
      },
      undefined,
      1000,
    );
    expect(p.name).toBe("Mara Vale");
    expect(p.refs).toHaveLength(2);
    expect(p.look).toEqual({ archetype: "sage" });
    expect(p.suffix).toBe("copper hair");
    expect(p.engine).toBe(IDENTITY_ENGINES[0].id);
    const edited = buildProfile(
      { id: p.id, name: "Mara", refs: p.refs, engine: "moss-charref" },
      p,
      2000,
    );
    expect(edited.id).toBe(p.id);
    expect(edited.createdAt).toBe(1000);
    expect(edited.updatedAt).toBe(2000);
    expect(edited.engine).toBe("moss-charref");
    expect(() => buildProfile({ name: "", refs: [] })).toThrow();
  });

  it("compiles the Actor Builder look and the prompt suffix", () => {
    expect(compileProfileLook({})).toBe("");
    const look = compileProfileLook({
      archetype: "sage",
      age: "30s",
      build: "freckled",
      outfit: "street",
    });
    expect(look).toBe(
      "a calm, watchful sage, in their thirties, with freckles and a bright complexion, wearing worn streetwear",
    );
    expect(profilePromptSuffix({ look: {}, suffix: "green eyes" })).toBe(
      "green eyes",
    );
    expect(
      profilePromptSuffix({ look: { age: "20s" }, suffix: "green eyes" }),
    ).toBe("in their twenties, green eyes");
    // Every look field offers an empty choice so a profile can skip it.
    for (const f of PROFILE_LOOK_FIELDS)
      expect(f.options.some((o) => !o.text)).toBe(true);
  });

  it("applies suffixes idempotently and swaps the previous one", () => {
    const a = { look: {}, suffix: "copper hair" };
    const b = { look: { age: "60s" }, suffix: "" };
    expect(applyProfileSuffix("", a)).toBe("copper hair");
    const once = applyProfileSuffix("at the beach", a);
    expect(once).toBe("at the beach, copper hair");
    expect(applyProfileSuffix(once, a, a)).toBe(once);
    expect(applyProfileSuffix(once, b, a)).toBe(
      "at the beach, in their sixties",
    );
    expect(applyProfileSuffix(once, null, a)).toBe("at the beach");
    // User edits after the suffix: leave their text alone.
    expect(applyProfileSuffix(`${once} at night`, null, a)).toBe(
      `${once} at night`,
    );
  });

  it("picks the identity-like slot", () => {
    expect(pickProfileSlot(["Image"])).toBe(0);
    expect(pickProfileSlot(["Photo", "Face"])).toBe(1);
    expect(pickProfileSlot(["Target", "Character"])).toBe(1);
    expect(pickProfileSlot(["Scene", "Person"])).toBe(1);
    expect(pickProfileSlot([])).toBe(0);
  });

  it("maps engines to existing hub tools", () => {
    expect(identityEngine(undefined).id).toBe("krea2-identity");
    expect(identityEngine("moss-charref").toolKey).toBe("catalog:moss-charref");
    expect(identityEngine("krea2-identity").toolKey).toBe(
      "catalog:krea2-general-edit",
    );
  });

  it("sanitizes persisted data", () => {
    const good = buildProfile({ name: "Kai", refs: [gallery()] }, undefined, 5);
    const out = sanitizeProfiles([
      good,
      good, // duplicate id
      { id: "x", name: "No refs", refs: [] },
      {
        id: "y",
        name: "Bad ref",
        refs: [
          { id: "r", source: "upload", label: "l", dataUrl: "javascript:x" },
        ],
      },
      null,
      "junk",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(good.id);
    expect(sanitizeProfiles(undefined)).toEqual([]);
  });
});

describe("characterProfileStore", () => {
  beforeEach(() => {
    useCharacterProfileStore.setState({ profiles: [], armedId: null });
  });

  it("saves, edits, arms and removes profiles", () => {
    const st = useCharacterProfileStore.getState();
    const bad = st.saveProfile({ name: "", refs: [upload()] });
    expect(bad.ok).toBe(false);

    const r = st.saveProfile({ name: "Mara", refs: [upload()] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(useCharacterProfileStore.getState().profiles).toHaveLength(1);

    const e = st.saveProfile({
      id: r.profile.id,
      name: "Mara 2",
      refs: [upload(), gallery()],
    });
    expect(e.ok).toBe(true);
    const list = useCharacterProfileStore.getState().profiles;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Mara 2");
    expect(list[0].refs).toHaveLength(2);

    st.armProfile(r.profile.id);
    expect(useCharacterProfileStore.getState().takeArmed()).toBe(r.profile.id);
    expect(useCharacterProfileStore.getState().takeArmed()).toBeNull();

    st.armProfile(r.profile.id);
    st.removeProfile(r.profile.id);
    expect(useCharacterProfileStore.getState().profiles).toEqual([]);
    expect(useCharacterProfileStore.getState().armedId).toBeNull();
  });

  it("refuses saves past the storage budget", () => {
    const huge = upload(
      1,
      Math.ceil(PROFILE_STORAGE_BUDGET / PROFILE_MAX_REFS) + 10,
    );
    const r = useCharacterProfileStore.getState().saveProfile({
      name: "Big",
      refs: [
        huge,
        upload(2, huge.dataUrl!.length),
        upload(3, huge.dataUrl!.length),
        upload(4, huge.dataUrl!.length),
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/storage/);
    expect(useCharacterProfileStore.getState().profiles).toEqual([]);
  });

  it("persists profiles but not the armed hand-off", () => {
    useCharacterProfileStore
      .getState()
      .saveProfile({ name: "Kai", refs: [gallery()] });
    useCharacterProfileStore.getState().armProfile("anything");
    const raw = localStorage.getItem("adrift.character-profiles");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.profiles).toHaveLength(1);
    expect(parsed.state.armedId).toBeUndefined();
    expect(parsed.state.profiles[0].refs[0].dataUrl).toBeUndefined();
  });
});

describe("hub card", () => {
  it("lists Character Profiles under Identity", () => {
    const cards = buildHubCards({
      toolCards: [],
      ctx: { catalog: [], packIds: new Set(), editLoras: null },
    });
    const card = cards.find((c) => c.key === CHARACTER_PROFILES_KEY);
    expect(card).toBeDefined();
    expect(card?.hubCategory).toBe("Identity");
    expect(card?.available).toBe(true);
  });
});
