import { describe, expect, it, vi } from "vitest";

// Run effects inline and read store state directly (no DOM library here).
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useEffect: (fn: () => void) => fn(),
}));
vi.mock("@/store/userToolsStore", async (orig) => {
  const mod = await orig<typeof import("@/store/userToolsStore")>();
  const store = mod.useUserToolsStore;
  const hook = ((sel: (s: ReturnType<typeof store.getState>) => unknown) =>
    sel(store.getState())) as unknown as typeof store;
  Object.assign(hook, store);
  return { ...mod, useUserToolsStore: hook };
});

import {
  useReturnToListOnImport,
  userToolDeepLinkKey,
} from "@/components/tools/userTools/useUserToolsPageHooks";
import { useUserToolsStore } from "@/store/userToolsStore";

describe("Tools page user-tool hooks", () => {
  it("opens ?tool=user:<id> deep links, ignores anything else", () => {
    expect(userToolDeepLinkKey("user:abc-123")).toBe("user:abc-123");
    expect(userToolDeepLinkKey("user:")).toBeNull();
    expect(userToolDeepLinkKey("user:../x")).toBeNull();
    expect(userToolDeepLinkKey("upscale")).toBeNull();
    expect(userToolDeepLinkKey(null)).toBeNull();
  });

  it("returns to the tool list when Explore asks for an import", () => {
    const back = vi.fn();
    useUserToolsStore.setState({ pendingImportUrl: null });
    useReturnToListOnImport("upscale", back);
    expect(back).not.toHaveBeenCalled();
    useUserToolsStore.setState({
      pendingImportUrl: "https://civitai.com/models/1",
    });
    useReturnToListOnImport(null, back);
    expect(back).not.toHaveBeenCalled();
    useReturnToListOnImport("user:abc", back);
    expect(back).toHaveBeenCalledTimes(1);
  });
});
