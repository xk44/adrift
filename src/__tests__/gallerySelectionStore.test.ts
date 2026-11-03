import { beforeEach, describe, expect, it } from "vitest";
import { useGallerySelectionStore } from "@/store/gallerySelectionStore";

const store = () => useGallerySelectionStore.getState();
const selected = () => [...store().selected].sort();

describe("gallery selection store", () => {
  beforeEach(() => {
    store().exit();
    store().setOrderedIds(["a", "b", "c", "d"]);
  });

  it("click toggles and moves the anchor; shift extends from it", () => {
    store().enter();
    store().toggle("b");
    store().extendTo("d");
    expect(selected()).toEqual(["b", "c", "d"]);
    expect(store().anchorId).toBe("b");
  });

  it("long-press enters select mode with the tile picked", () => {
    store().enterWith("c");
    expect(store().selectMode).toBe(true);
    expect(selected()).toEqual(["c"]);
    // A second long-press on the same tile keeps it selected.
    store().enterWith("c");
    expect(selected()).toEqual(["c"]);
  });

  it("select all covers every loaded id; exit clears", () => {
    store().enter();
    store().selectAll();
    expect(selected()).toEqual(["a", "b", "c", "d"]);
    store().toggleMode();
    expect(store().selectMode).toBe(false);
    expect(selected()).toEqual([]);
  });

  it("prunes selection and anchor when the feed changes", () => {
    store().enter();
    store().toggle("a");
    store().toggle("c");
    store().setOrderedIds(["b", "c"]);
    expect(selected()).toEqual(["c"]);
    expect(store().anchorId).toBe("c");
    store().toggle("c");
    store().setOrderedIds(["b"]);
    expect(store().anchorId).toBeNull();
  });

  it("group toggle fills then clears a run", () => {
    store().enter();
    store().toggle("a");
    store().toggleGroup(["a", "b"]);
    expect(selected()).toEqual(["a", "b"]);
    store().toggleGroup(["a", "b"]);
    expect(selected()).toEqual([]);
  });
});
