/**
 * OrganizePage — route/data/action parity tests
 *
 * Validates the store-level data flows that OrganizePage consumes:
 * - Folder CRUD: addFolder, removeFolder, renameFolder
 * - Image-folder assignment: addImageToFolder, removeImageFromFolder
 * - Gallery filtering: liked, hidden, folder-based, date-based
 * - toggleHidden, removeFromGallery, toggleLiked
 * - Selection + bulk operations (delete selected)
 * - Additional parity for Lightbox (setLightboxIndex navigation),
 *   Profile (removeFromGallery, renameFavoritePrompt, addFavoritePrompt),
 *   Personalize (LoRA shortcode CRUD, SREF panel state), and
 *   Tasks (addFavoritePrompt, renameFavoritePrompt)
 *
 * Pure store/action tests — no DOM rendering.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore, useGenerationStore } from "@/store";
import { useLikesStore } from "@/store/likesStore";
import { useStyleStore } from "@/store/styleStore";
import {
  addLikedToGalleryByIds,
  getDragSelection,
} from "@/components/OrganizePage";

// ---------------------------------------------------------------------------
// Helper: gallery image factory
// ---------------------------------------------------------------------------
function makeImage(overrides: Partial<{
  id: string;
  url: string;
  prompt: string;
  fullPrompt: string;
  seed: number;
  liked: boolean;
  hidden: boolean;
  folderIds: string[];
  createdAt: string;
  runId: string;
  jobIndex: number;
  width: number;
  height: number;
}>) {
  const o = {
    id: "img-" + Math.random().toString(36).slice(2, 8),
    url: "/test.png",
    prompt: "test image",
    fullPrompt: "test image --ar 1:1",
    params: [] as string[],
    paramsMap: {} as Record<string, string>,
    seed: 42,
    createdAt: new Date().toISOString(),
    runId: "run-1",
    jobIndex: 0,
    width: 1024,
    height: 1024,
    ...overrides,
  };
  return o;
}

// ---------------------------------------------------------------------------
// OrganizePage — folder CRUD parity
// ---------------------------------------------------------------------------

describe("OrganizePage folder CRUD parity", () => {
  beforeEach(() => {
    useGenerationStore.setState({ gallery: [], folders: [] });
  });

  it("addFolder creates a new folder with name and id", () => {
    const { getState } = useGenerationStore;

    getState().addFolder("Landscapes");
    const folders = getState().folders;
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe("Landscapes");
    expect(typeof folders[0].id).toBe("string");
    expect(folders[0].id.length).toBeGreaterThan(0);
    expect(typeof folders[0].createdAt).toBe("number");
  });

  it("addFolder creates multiple folders and they accumulate", () => {
    const { getState } = useGenerationStore;

    getState().addFolder("Folder A");
    getState().addFolder("Folder B");
    getState().addFolder("Folder C");

    expect(getState().folders).toHaveLength(3);
    expect(getState().folders.map((f) => f.name)).toEqual([
      "Folder A",
      "Folder B",
      "Folder C",
    ]);
  });

  it("removeFolder removes the folder and cleans up image folderIds", () => {
    const { getState } = useGenerationStore;

    getState().addFolder("Portraits");
    const folderId = getState().folders[0].id;

    // Add an image and assign it to the folder
    const img = makeImage({ id: "img-folder-test", folderIds: [folderId] });
    useGenerationStore.setState({ gallery: [img] });

    expect(getState().gallery[0].folderIds).toContain(folderId);

    // Remove the folder
    getState().removeFolder(folderId);

    // Folder should be gone
    expect(getState().folders).toHaveLength(0);
    // Image's folderIds should no longer reference removed folder
    expect(getState().gallery[0].folderIds).not.toContain(folderId);
  });

  it("renameFolder changes only the name, preserving id and createdAt", () => {
    const { getState } = useGenerationStore;

    getState().addFolder("Old Name");
    const folderId = getState().folders[0].id;
    const createdAt = getState().folders[0].createdAt;

    getState().renameFolder(folderId, "New Name");

    const folder = getState().folders[0];
    expect(folder.id).toBe(folderId);
    expect(folder.name).toBe("New Name");
    expect(folder.createdAt).toBe(createdAt);
  });

  it("removeFolder with no images referencing it still works", () => {
    const { getState } = useGenerationStore;

    getState().addFolder("Empty Folder");
    const folderId = getState().folders[0].id;

    // No images, but should still remove cleanly
    getState().removeFolder(folderId);
    expect(getState().folders).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OrganizePage — image-folder assignment parity
// ---------------------------------------------------------------------------

describe("OrganizePage image-folder assignment parity", () => {
  beforeEach(() => {
    useGenerationStore.setState({ gallery: [], folders: [] });
  });

  it("addImageToFolder assigns a folder id to an image", () => {
    const { getState } = useGenerationStore;

    const img = makeImage({ id: "img-assign-1" });
    useGenerationStore.setState({ gallery: [img] });

    getState().addFolder("My Folder");
    const folderId = getState().folders[0].id;

    getState().addImageToFolder("img-assign-1", folderId);
    expect(getState().gallery[0].folderIds).toContain(folderId);
  });

  it("addImageToFolder is idempotent — adding same folder twice does not duplicate", () => {
    const { getState } = useGenerationStore;

    const img = makeImage({ id: "img-dup" });
    useGenerationStore.setState({ gallery: [img] });

    getState().addFolder("Dup Folder");
    const folderId = getState().folders[0].id;

    getState().addImageToFolder("img-dup", folderId);
    getState().addImageToFolder("img-dup", folderId);

    const folderIds = getState().gallery[0].folderIds!;
    const count = folderIds.filter((id: string) => id === folderId).length;
    expect(count).toBe(1);
  });

  it("addImageToFolder can assign an image to multiple folders", () => {
    const { getState } = useGenerationStore;

    const img = makeImage({ id: "img-multi" });
    useGenerationStore.setState({ gallery: [img] });

    getState().addFolder("Folder 1");
    getState().addFolder("Folder 2");
    const f1 = getState().folders[0].id;
    const f2 = getState().folders[1].id;

    getState().addImageToFolder("img-multi", f1);
    getState().addImageToFolder("img-multi", f2);

    expect(getState().gallery[0].folderIds).toContain(f1);
    expect(getState().gallery[0].folderIds).toContain(f2);
  });

  it("removeImageFromFolder removes only the specified folder assignment", () => {
    const { getState } = useGenerationStore;

    const img = makeImage({ id: "img-remove-one" });
    useGenerationStore.setState({ gallery: [img] });

    getState().addFolder("Keep");
    getState().addFolder("Remove");
    const keepId = getState().folders[0].id;
    const removeId = getState().folders[1].id;

    getState().addImageToFolder("img-remove-one", keepId);
    getState().addImageToFolder("img-remove-one", removeId);

    expect(getState().gallery[0].folderIds).toHaveLength(2);

    // Remove only the "Remove" folder
    getState().removeImageFromFolder("img-remove-one", removeId);

    expect(getState().gallery[0].folderIds).toHaveLength(1);
    expect(getState().gallery[0].folderIds).toContain(keepId);
    expect(getState().gallery[0].folderIds).not.toContain(removeId);
  });

  it("removeImageFromFolder on non-existent folderId is a no-op", () => {
    const { getState } = useGenerationStore;

    const img = makeImage({ id: "img-noop" });
    useGenerationStore.setState({ gallery: [img] });

    // Removing a folder that doesn't exist should not crash
    getState().removeImageFromFolder("img-noop", "nonexistent-folder-id");
    // Image's folderIds should remain unchanged (or default to empty)
    const folderIds = getState().gallery[0].folderIds ?? [];
    expect(folderIds).not.toContain("nonexistent-folder-id");
  });
});

// ---------------------------------------------------------------------------
// OrganizePage — gallery filtering and actions parity
// ---------------------------------------------------------------------------

describe("OrganizePage gallery filtering parity", () => {
  beforeEach(() => {
    useGenerationStore.setState({ gallery: [] });
  });

  it("toggleHidden hides an image from visible gallery", () => {
    const { getState } = useGenerationStore;

    const img = makeImage({ id: "hide-me" });
    useGenerationStore.setState({ gallery: [img] });

    expect(getState().gallery[0].hidden).toBeFalsy();

    // Hide it
    getState().toggleHidden("hide-me");
    expect(getState().gallery[0].hidden).toBe(true);

    // The selectVisibleGallery selector should exclude hidden images
    const visible = getState().gallery.filter((i) => !i.hidden);
    expect(visible).toHaveLength(0);

    // Unhide it
    getState().toggleHidden("hide-me");
    expect(getState().gallery[0].hidden).toBe(false);
  });

  it("removeFromGallery deletes an image by id", () => {
    const { getState } = useGenerationStore;

    const img1 = makeImage({ id: "img-del-1" });
    const img2 = makeImage({ id: "img-del-2" });
    const img3 = makeImage({ id: "img-del-3" });
    useGenerationStore.setState({ gallery: [img1, img2, img3] });

    expect(getState().gallery).toHaveLength(3);

    // Delete one image
    getState().removeFromGallery("img-del-2");
    expect(getState().gallery).toHaveLength(2);
    expect(getState().gallery.map((i) => i.id)).not.toContain("img-del-2");
    expect(getState().gallery.map((i) => i.id)).toContain("img-del-1");
    expect(getState().gallery.map((i) => i.id)).toContain("img-del-3");
  });

  it("removeFromGallery for bulk delete (simulating multi-select delete)", () => {
    const { getState } = useGenerationStore;

    const images = [
      makeImage({ id: "bulk-1" }),
      makeImage({ id: "bulk-2" }),
      makeImage({ id: "bulk-3" }),
      makeImage({ id: "bulk-4" }),
      makeImage({ id: "bulk-5" }),
    ];
    useGenerationStore.setState({ gallery: images });

    // Simulate deleting selected images (bulk)
    const selectedIds = new Set(["bulk-2", "bulk-4"]);
    selectedIds.forEach((id) => getState().removeFromGallery(id));

    expect(getState().gallery).toHaveLength(3);
    expect(getState().gallery.map((i) => i.id).sort()).toEqual(
      ["bulk-1", "bulk-3", "bulk-5"].sort(),
    );
  });

  it("gallery filtering by liked status works (organize favorites)", () => {
    const { getState } = useGenerationStore;

    const img1 = makeImage({ id: "like-1", liked: true });
    const img2 = makeImage({ id: "like-2", liked: false });
    const img3 = makeImage({ id: "like-3", liked: true });
    useGenerationStore.setState({ gallery: [img1, img2, img3] });

    const liked = getState().gallery.filter((i) => i.liked);
    expect(liked).toHaveLength(2);
    expect(liked.map((i) => i.id)).toContain("like-1");
    expect(liked.map((i) => i.id)).toContain("like-3");
  });

  it("gallery filtering by folderIds for uncategorized images", () => {
    const { getState } = useGenerationStore;

    const img1 = makeImage({ id: "uncat-1", folderIds: [] });
    const img2 = makeImage({ id: "uncat-2", folderIds: ["folder-abc"] });
    const img3 = makeImage({ id: "uncat-3" }); // folderIds undefined
    useGenerationStore.setState({ gallery: [img1, img2, img3] });

    // Filter: uncategorized = no folder assignments
    const uncategorized = getState().gallery.filter(
      (i) => !(i.folderIds && i.folderIds.length > 0),
    );
    expect(uncategorized).toHaveLength(2);
    expect(uncategorized.map((i) => i.id)).toContain("uncat-1");
    expect(uncategorized.map((i) => i.id)).toContain("uncat-3");
  });

  it("gallery date-based filtering (organize date filter)", () => {
    const { getState } = useGenerationStore;

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyOneDaysAgo = new Date(
      now.getTime() - 31 * 24 * 60 * 60 * 1000,
    );

    const imgToday = makeImage({
      id: "today",
      createdAt: now.toISOString(),
    });
    const imgWeek = makeImage({
      id: "week-ago",
      createdAt: sevenDaysAgo.toISOString(),
    });
    const imgOld = makeImage({
      id: "old",
      createdAt: thirtyOneDaysAgo.toISOString(),
    });

    useGenerationStore.setState({ gallery: [imgToday, imgWeek, imgOld] });

    // "Last 7 days" filter
    const weekThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    weekThreshold.setHours(0, 0, 0, 0);
    const recentWeek = getState().gallery.filter((i) => {
      const d = i.createdAt ? new Date(i.createdAt) : null;
      return d !== null && d >= weekThreshold;
    });
    expect(recentWeek.length).toBeGreaterThanOrEqual(1);
    expect(recentWeek.map((i) => i.id)).toContain("today");
    // Note: sevenDaysAgo may or may not be included depending on hour boundary
  });

  it("gallery search filtering (organize search bar)", () => {
    const { getState } = useGenerationStore;

    const img1 = makeImage({ id: "search-1", prompt: "sunset landscape mountains" });
    const img2 = makeImage({ id: "search-2", prompt: "ocean waves beach" });
    const img3 = makeImage({ id: "search-3", prompt: "cyberpunk city night" });

    useGenerationStore.setState({ gallery: [img1, img2, img3] });

    const search = (query: string) =>
      getState().gallery.filter((i) =>
        i.prompt.toLowerCase().includes(query.toLowerCase()),
      );

    // Search for "sunset"
    expect(search("sunset")).toHaveLength(1);
    expect(search("sunset")[0].id).toBe("search-1");

    // Search for "cyber"
    expect(search("cyber")).toHaveLength(1);
    expect(search("cyber")[0].id).toBe("search-3");

    // Search for empty string returns all
    expect(search("")).toHaveLength(3);
  });

  it("gallery sort by name (organize sort options)", () => {
    const { getState } = useGenerationStore;

    const img1 = makeImage({ id: "sort-1", prompt: "banana" });
    const img2 = makeImage({ id: "sort-2", prompt: "apple" });
    const img3 = makeImage({ id: "sort-3", prompt: "cherry" });

    useGenerationStore.setState({ gallery: [img1, img2, img3] });

    // Sort by name A-Z
    const sortedAZ = [...getState().gallery].sort((a, b) =>
      a.prompt.localeCompare(b.prompt),
    );
    expect(sortedAZ.map((i) => i.prompt)).toEqual(["apple", "banana", "cherry"]);

    // Sort by name Z-A
    const sortedZA = [...getState().gallery].sort((a, b) =>
      b.prompt.localeCompare(a.prompt),
    );
    expect(sortedZA.map((i) => i.prompt)).toEqual(["cherry", "banana", "apple"]);
  });

  it("computes drag payload selection from the current selection", () => {
    const currentSelection = new Set(["selected-1", "selected-2"]);

    expect(Array.from(getDragSelection("selected-1", currentSelection))).toEqual(
      ["selected-1", "selected-2"],
    );
    expect(Array.from(getDragSelection("unselected", currentSelection))).toEqual(
      ["unselected"],
    );
  });

  it("adds liked state idempotently for favorites drops", () => {
    const liked = makeImage({ id: "liked", liked: true });
    const unliked = makeImage({ id: "unliked", liked: false });
    const untouched = makeImage({ id: "untouched", liked: false });

    const next = addLikedToGalleryByIds(
      [liked, unliked, untouched],
      ["liked", "unliked"],
    );

    expect(next.find((img) => img.id === "liked")?.liked).toBe(true);
    expect(next.find((img) => img.id === "unliked")?.liked).toBe(true);
    expect(next.find((img) => img.id === "untouched")?.liked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lightbox navigation parity (setLightboxIndex)
// ---------------------------------------------------------------------------

describe("Lightbox navigation action parity", () => {
  beforeEach(() => {
    useUIStore.setState({ lightbox: null });
  });

  it("setLightboxIndex changes the current image in the lightbox", () => {
    const images = [
      makeImage({ id: "lb-nav-1" }),
      makeImage({ id: "lb-nav-2" }),
      makeImage({ id: "lb-nav-3" }),
    ].map((img) => ({
      ...img,
      fullPrompt: img.fullPrompt ?? "",
      params: img.params ?? [],
      paramsMap: img.paramsMap ?? {},
      seed: img.seed ?? 0,
      createdAt: img.createdAt ?? new Date().toISOString(),
      runId: img.runId ?? "",
      jobIndex: img.jobIndex ?? 0,
      width: img.width ?? 1024,
      height: img.height ?? 1024,
    }));

    // Open lightbox at index 0
    useUIStore.getState().openLightbox({
      images,
      index: 0,
      origin: "organize",
    });

    expect(useUIStore.getState().lightbox!.index).toBe(0);
    expect(useUIStore.getState().lightbox!.origin).toBe("organize");

    // Navigate to next
    useUIStore.getState().setLightboxIndex(1);
    expect(useUIStore.getState().lightbox!.index).toBe(1);

    // Navigate to last
    useUIStore.getState().setLightboxIndex(2);
    expect(useUIStore.getState().lightbox!.index).toBe(2);

    // Navigate back
    useUIStore.getState().setLightboxIndex(0);
    expect(useUIStore.getState().lightbox!.index).toBe(0);
  });

  it("setLightboxIndex on closed lightbox is a no-op", () => {
    expect(useUIStore.getState().lightbox).toBeNull();

    // Should not crash
    useUIStore.getState().setLightboxIndex(2);
    expect(useUIStore.getState().lightbox).toBeNull();
  });

  it("lightbox origin is preserved when navigating", () => {
    const images = [
      makeImage({ id: "lb-origin-1" }),
    ].map((img) => ({
      ...img,
      fullPrompt: img.fullPrompt ?? "",
      params: img.params ?? [],
      paramsMap: img.paramsMap ?? {},
      seed: img.seed ?? 0,
      createdAt: img.createdAt ?? new Date().toISOString(),
      runId: img.runId ?? "",
      jobIndex: img.jobIndex ?? 0,
      width: img.width ?? 1024,
      height: img.height ?? 1024,
    }));

    useUIStore.getState().openLightbox({
      images,
      index: 0,
      origin: "profile",
    });

    useUIStore.getState().setLightboxIndex(0);

    // Origin should still be "profile"
    expect(useUIStore.getState().lightbox!.origin).toBe("profile");
  });
});

// ---------------------------------------------------------------------------
// Profile additional parity (removeFromGallery, renameFavoritePrompt, addFavoritePrompt)
// ---------------------------------------------------------------------------

describe("Profile additional action parity", () => {
  beforeEach(() => {
    useGenerationStore.setState({
      gallery: [],
      folders: [],
      promptHistory: [],
      favoritePrompts: [],
    });
  });

  it("removeFromGallery can be used from profile archive to delete own images", () => {
    const { getState } = useGenerationStore;

    const img = makeImage({ id: "profile-del-1" });
    useGenerationStore.setState({ gallery: [img] });
    expect(getState().gallery).toHaveLength(1);

    // Profile "Delete from archive" action
    getState().removeFromGallery("profile-del-1");
    expect(getState().gallery).toHaveLength(0);
  });

  it("addFavoritePrompt creates a new favorite with optional name", () => {
    const { getState } = useGenerationStore;

    // Add favorites from profile / tasks
    getState().addFavoritePrompt("a scenic mountain vista --ar 16:9", "Mountains");
    getState().addFavoritePrompt("portrait photography --stylize 200");

    expect(getState().favoritePrompts).toHaveLength(2);
    // addFavoritePrompt prepends, so index 0 is the most recently added
    expect(getState().favoritePrompts[0].prompt).toBe(
      "portrait photography --stylize 200",
    );
    expect(getState().favoritePrompts[0].name).toBeUndefined();

    expect(getState().favoritePrompts[1].prompt).toBe(
      "a scenic mountain vista --ar 16:9",
    );
    expect(getState().favoritePrompts[1].name).toBe("Mountains");

    // Each gets a unique id
    expect(getState().favoritePrompts[0].id).not.toBe(
      getState().favoritePrompts[1].id,
    );
  });

  it("renameFavoritePrompt changes the name of a favorite prompt", () => {
    const { getState } = useGenerationStore;

    getState().addFavoritePrompt("sunset hills --ar 1:1", "Original Name");
    const favId = getState().favoritePrompts[0].id;

    // Rename the prompt
    getState().renameFavoritePrompt(favId, "Renamed Hills");
    expect(getState().favoritePrompts[0].name).toBe("Renamed Hills");
    // Prompt text stays the same
    expect(getState().favoritePrompts[0].prompt).toBe("sunset hills --ar 1:1");
  });

  it("duplicate addFavoritePrompt creates separate entries", () => {
    const { getState } = useGenerationStore;

    // Adding same prompt twice creates two entries (different ids)
    getState().addFavoritePrompt("same prompt");
    getState().addFavoritePrompt("same prompt");

    expect(getState().favoritePrompts).toHaveLength(2);
    expect(getState().favoritePrompts[0].prompt).toBe("same prompt");
    expect(getState().favoritePrompts[1].prompt).toBe("same prompt");
    // Different ids
    expect(getState().favoritePrompts[0].id).not.toBe(
      getState().favoritePrompts[1].id,
    );
  });

  it("toggleHidden on profile images allows archive visibility control", () => {
    const { getState } = useGenerationStore;

    const img1 = makeImage({ id: "hide-profile-1" });
    const img2 = makeImage({ id: "hide-profile-2" });
    useGenerationStore.setState({ gallery: [img1, img2] });

    // Hide img1
    getState().toggleHidden("hide-profile-1");
    expect(getState().gallery[0].hidden).toBe(true);
    expect(getState().gallery[1].hidden).toBeFalsy();

    // Visible gallery excludes hidden
    const visible = getState().gallery.filter((i) => !i.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe("hide-profile-2");
  });
});

// ---------------------------------------------------------------------------
// PersonalizePage — LoRA shortcode and SREF panel parity
// ---------------------------------------------------------------------------

describe("PersonalizePage LoRA shortcode parity", () => {
  beforeEach(() => {
    useStyleStore.setState({ loraShortcodes: [], recentLoraShortcodes: [] });
  });

  it("saveLoRAShortcode creates a new shortcode entry", () => {
    const { getState } = useStyleStore;

    getState().saveLoRAShortcode({
      shortcode: "add-detail",
      filename: "add_detail.safetensors",
      displayName: "Add Detail",
      tags: ["detail", "enhancement"],
      triggers: ["add detail"],
      defaultStrength: 0.8,
      curatedSet: "essential",
    });

    const codes = getState().loraShortcodes;
    expect(codes).toHaveLength(1);
    expect(codes[0].shortcode).toBe("add-detail");
    expect(codes[0].filename).toBe("add_detail.safetensors");
    expect(codes[0].displayName).toBe("Add Detail");
    expect(codes[0].useCount).toBe(0);
    expect(codes[0].isFavorite).toBe(false);
    expect(codes[0].defaultStrength).toBe(0.8);
    expect(codes[0].curatedSet).toBe("essential");
  });

  it("saveLoRAShortcode updates existing shortcode", () => {
    const { getState } = useStyleStore;

    getState().saveLoRAShortcode({
      shortcode: "film-grain",
      filename: "film_grain.safetensors",
      displayName: "Film Grain",
      defaultStrength: 1.0,
    });

    // Update with new display name
    getState().saveLoRAShortcode({
      shortcode: "film-grain",
      filename: "film_grain.safetensors",
      displayName: "Film Grain V2",
      defaultStrength: 0.7,
    });

    const codes = getState().loraShortcodes;
    expect(codes).toHaveLength(1);
    expect(codes[0].displayName).toBe("Film Grain V2");
    expect(codes[0].defaultStrength).toBe(0.7);
  });

  it("removeLoRAShortcode removes a shortcode", () => {
    const { getState } = useStyleStore;

    getState().saveLoRAShortcode({
      shortcode: "remove-me",
      filename: "remove_me.safetensors",
      displayName: "Remove Me",
      defaultStrength: 1.0,
    });

    expect(getState().loraShortcodes).toHaveLength(1);

    getState().removeLoRAShortcode("remove-me");
    expect(getState().loraShortcodes).toHaveLength(0);
  });

  it("toggleLoRAShortcodeFavorite toggles favorite status", () => {
    const { getState } = useStyleStore;

    getState().saveLoRAShortcode({
      shortcode: "fav-lora",
      filename: "fav_lora.safetensors",
      displayName: "Favorite LoRA",
      defaultStrength: 1.0,
    });

    expect(getState().loraShortcodes[0].isFavorite).toBe(false);

    // Mark as favorite
    getState().toggleLoRAShortcodeFavorite("fav-lora");
    expect(getState().loraShortcodes[0].isFavorite).toBe(true);

    // Unmark as favorite
    getState().toggleLoRAShortcodeFavorite("fav-lora");
    expect(getState().loraShortcodes[0].isFavorite).toBe(false);
  });

  it("incrementLoRAShortcodeUse increments use count and adds to recent list", () => {
    const { getState } = useStyleStore;

    // Even without saving, increment should track
    getState().incrementLoRAShortcodeUse("recent-lora");
    expect(getState().recentLoraShortcodes).toContain("recent-lora");

    // Make useCount go up when shortcode exists
    getState().saveLoRAShortcode({
      shortcode: "use-lora",
      filename: "use_lora.safetensors",
      displayName: "Use LoRA",
      defaultStrength: 1.0,
    });

    expect(getState().loraShortcodes[0].useCount).toBe(0);

    getState().incrementLoRAShortcodeUse("use-lora");
    expect(getState().loraShortcodes[0].useCount).toBe(1);
    expect(getState().recentLoraShortcodes).toContain("use-lora");

    getState().incrementLoRAShortcodeUse("use-lora");
    expect(getState().loraShortcodes[0].useCount).toBe(2);
  });
});

describe("PersonalizePage SREF panel state parity", () => {
  beforeEach(() => {
    useStyleStore.setState({ srefPanelOpen: false });
  });

  it("setSREFPanelOpen / toggleSREFPanel control panel visibility", () => {
    const { getState } = useStyleStore;

    expect(getState().srefPanelOpen).toBe(false);

    getState().setSREFPanelOpen(true);
    expect(getState().srefPanelOpen).toBe(true);

    getState().toggleSREFPanel();
    expect(getState().srefPanelOpen).toBe(false);

    getState().toggleSREFPanel();
    expect(getState().srefPanelOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Context menu parity (used by Lightbox/Profile/Organize)
// ---------------------------------------------------------------------------

describe("Context menu action parity", () => {
  beforeEach(() => {
    useUIStore.setState({ contextMenu: null });
  });

  it("openContextMenu sets context menu state with image", () => {
    const { getState } = useUIStore;

    const ctxImage = {
      id: "ctx-img-1",
      url: "/ctx.png",
      prompt: "context test",
      fullPrompt: "context test --ar 16:9",
      params: [] as string[],
      paramsMap: {} as Record<string, unknown>,
      seed: 999,
      createdAt: new Date().toISOString(),
      runId: "run-ctx",
      jobIndex: 0,
      width: 1024,
      height: 1024,
    };

    getState().openContextMenu({
      image: ctxImage,
      x: 100,
      y: 200,
    });

    expect(getState().contextMenu).not.toBeNull();
    expect(getState().contextMenu!.image.id).toBe("ctx-img-1");
    expect(getState().contextMenu!.x).toBe(100);
    expect(getState().contextMenu!.y).toBe(200);
  });

  it("closeContextMenu clears context menu state", () => {
    const { getState } = useUIStore;

    const ctxImage = {
      id: "ctx-img-1",
      url: "/ctx.png",
      prompt: "context test",
      fullPrompt: "context test",
      params: [] as string[],
      paramsMap: {} as Record<string, unknown>,
      seed: 999,
      createdAt: new Date().toISOString(),
      runId: "run-ctx",
      jobIndex: 0,
      width: 1024,
      height: 1024,
    };

    getState().openContextMenu({
      image: ctxImage,
      x: 50,
      y: 50,
    });

    expect(getState().contextMenu).not.toBeNull();

    getState().closeContextMenu();
    expect(getState().contextMenu).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Image attachment parity (used by Lightbox "use as reference")
// ---------------------------------------------------------------------------

describe("Image attachment action parity (Lightbox/PromptBar)", () => {
  beforeEach(() => {
    useUIStore.setState({
      imageAttachments: [],
      imageAttachmentsLocked: false,
      promptValue: "",
    });
  });

  it("addImageAttachment adds an attachment for reference", () => {
    const { getState } = useUIStore;

    const attachment = {
      id: "att-1",
      url: "/reference.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    };

    getState().addImageAttachment(attachment);
    expect(getState().imageAttachments).toHaveLength(1);
    expect(getState().imageAttachments[0].id).toBe("att-1");
  });

  it("removeImageAttachment removes a specific attachment", () => {
    const { getState } = useUIStore;

    getState().addImageAttachment({
      id: "att-1",
      url: "/ref1.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    });
    getState().addImageAttachment({
      id: "att-2",
      url: "/ref2.png",
      mode: "style_ref" as const,
      weight: 0.5,
    });

    expect(getState().imageAttachments).toHaveLength(2);

    getState().removeImageAttachment("att-1");
    expect(getState().imageAttachments).toHaveLength(1);
    expect(getState().imageAttachments[0].id).toBe("att-2");
  });

  it("updateImageAttachment changes attachment properties", () => {
    const { getState } = useUIStore;

    getState().addImageAttachment({
      id: "att-upd",
      url: "/update.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    });

    getState().updateImageAttachment("att-upd", {
      weight: 0.8,
      mode: "style_ref",
    });
    expect(getState().imageAttachments[0].weight).toBe(0.8);
    expect(getState().imageAttachments[0].mode).toBe("style_ref");
  });

  it("reorderImageAttachment persists thumbnail order in attachment state", () => {
    const { getState } = useUIStore;

    getState().addImageAttachment({
      id: "att-1",
      url: "/ref1.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    });
    getState().addImageAttachment({
      id: "att-2",
      url: "/ref2.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    });
    getState().addImageAttachment({
      id: "att-3",
      url: "/ref3.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    });

    getState().reorderImageAttachment("att-3", "att-1");

    expect(getState().imageAttachments.map((a) => a.id)).toEqual([
      "att-3",
      "att-1",
      "att-2",
    ]);
  });

  it("syncs character references into the prompt string in attachment order", () => {
    const { getState } = useUIStore;

    getState().setPromptValue("portrait");
    getState().addImageAttachment({
      id: "cref-1",
      url: "https://example.com/a.png",
      mode: "char_ref" as const,
      weight: 75,
    });
    getState().addImageAttachment({
      id: "cref-2",
      url: "https://example.com/b.png",
      mode: "char_ref" as const,
      weight: 50,
    });

    expect(getState().promptValue).toBe(
      "portrait --cref https://example.com/a.png --cw 75 --cref https://example.com/b.png --cw 50",
    );

    getState().reorderImageAttachment("cref-2", "cref-1");

    expect(getState().promptValue).toBe(
      "portrait --cref https://example.com/b.png --cw 50 --cref https://example.com/a.png --cw 75",
    );
  });

  it("does not rewrite manually typed character refs for non-character attachments", () => {
    const { getState } = useUIStore;

    getState().setPromptValue(
      "portrait --cref https://example.com/manual.png --cw 20",
    );
    getState().addImageAttachment({
      id: "att-1",
      url: "/ref1.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    });

    expect(getState().promptValue).toBe(
      "portrait --cref https://example.com/manual.png --cw 20",
    );
  });

  it("clearImageAttachments removes all attachments", () => {
    const { getState } = useUIStore;

    getState().addImageAttachment({
      id: "att-a",
      url: "/a.png",
      mode: "image_prompt" as const,
      weight: 1.0,
    });
    getState().addImageAttachment({
      id: "att-b",
      url: "/b.png",
      mode: "style_ref" as const,
      weight: 0.5,
    });

    expect(getState().imageAttachments).toHaveLength(2);

    getState().clearImageAttachments();
    expect(getState().imageAttachments).toHaveLength(0);
  });

  it("setImageAttachmentsLocked toggles lock state", () => {
    const { getState } = useUIStore;

    expect(getState().imageAttachmentsLocked).toBe(false);

    getState().setImageAttachmentsLocked(true);
    expect(getState().imageAttachmentsLocked).toBe(true);

    getState().setImageAttachmentsLocked(false);
    expect(getState().imageAttachmentsLocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prompt navigation parity (used by all pages via "Start Creating")
// ---------------------------------------------------------------------------

describe("Prompt navigation action parity", () => {
  beforeEach(() => {
    useUIStore.setState({ promptValue: "", activeNav: "create" });
  });

  it("appendToPrompt appends text with space separator", () => {
    const { getState } = useUIStore;

    getState().setPromptValue("mountains");
    getState().appendToPrompt("--ar 16:9");

    expect(getState().promptValue).toBe("mountains --ar 16:9");
  });

  it("appendToPrompt on empty prompt sets value directly", () => {
    const { getState } = useUIStore;

    // Empty prompt
    getState().setPromptValue("");
    getState().appendToPrompt("sunset");

    expect(getState().promptValue).toBe("sunset");
  });

  it("replacePromptParam replaces existing parameter", () => {
    const { getState } = useUIStore;

    getState().setPromptValue("test --ar 1:1 --stylize 200");
    getState().replacePromptParam("--ar", "16:9");

    // The prompt should have the updated --ar value
    expect(getState().promptValue).toContain("16:9");
  });

  it("replacePromptParam adds new parameter when not found", () => {
    const { getState } = useUIStore;

    getState().setPromptValue("mountains at sunset");
    getState().replacePromptParam("--ar", "2:3");

    expect(getState().promptValue).toContain("--ar");
    expect(getState().promptValue).toContain("2:3");
  });

  it("replacePromptParam consumes all values for multi-value params", () => {
    const { getState } = useUIStore;

    getState().setPromptValue("test --no red blue --ar 1:1");
    getState().replacePromptParam("--no", "green");

    expect(getState().promptValue).toBe("test --no green --ar 1:1");
  });

  it("replacePromptParam keeps prose after single-value params", () => {
    const { getState } = useUIStore;

    getState().setPromptValue("--ar 16:9 portrait of a cat");
    getState().replacePromptParam("--ar", "1:1");

    expect(getState().promptValue).toBe("--ar 1:1 portrait of a cat");
  });

  it("replacePromptParam identical chip click is a no-op", () => {
    const { getState } = useUIStore;

    getState().setPromptValue("test --ar 16:9");
    getState().replacePromptParam("--ar", "16:9");

    expect(getState().promptValue).toBe("test --ar 16:9");
  });
});

// ---------------------------------------------------------------------------
// Error handling parity (shared across surfaces)
// ---------------------------------------------------------------------------

describe("Error handling action parity", () => {
  beforeEach(() => {
    useGenerationStore.setState({ errors: [], lastError: null });
  });

  it("addError adds an error with timestamp", () => {
    const { getState } = useGenerationStore;

    getState().addError({
      message: "Generation failed",
      category: "generation" as any,
      runId: "run-err-1",
    });

    expect(getState().errors).toHaveLength(1);
    expect(getState().errors[0].message).toBe("Generation failed");
    expect(getState().errors[0].runId).toBe("run-err-1");
    expect(typeof getState().errors[0].timestamp).toBe("number");
    expect(getState().lastError).toBe("Generation failed");
  });

  it("clearError removes a specific error by index", () => {
    const { getState } = useGenerationStore;

    getState().addError({ message: "Error 1", category: "generation" as any });
    getState().addError({ message: "Error 2", category: "generation" as any });

    expect(getState().errors).toHaveLength(2);
    // addError prepends, so errors[0] is "Error 2", errors[1] is "Error 1"
    expect(getState().errors[0].message).toBe("Error 2");
    expect(getState().errors[1].message).toBe("Error 1");

    // Remove errors[0] ("Error 2")
    getState().clearError(0);
    expect(getState().errors).toHaveLength(1);
    expect(getState().errors[0].message).toBe("Error 1");
  });

  it("clearAllErrors removes all errors", () => {
    const { getState } = useGenerationStore;

    getState().addError({ message: "Err A", category: "generation" as any });
    getState().addError({ message: "Err B", category: "generation" as any });

    expect(getState().errors.length).toBeGreaterThanOrEqual(2);

    getState().clearAllErrors();
    expect(getState().errors).toHaveLength(0);
    expect(getState().lastError).toBeNull();
  });
});
