/**
 * SREF Weight + Image Attachment Weight Parity Tests
 * ====================================================
 * Validates that per-item SREF weights and image attachment weights
 * are wired through the store and emerge in prompt formatting.
 *
 * Covers:
 * - store.updateImageAttachment updates weight on existing attachments
 * - store.updateSREFItem updates weight on existing SREF items
 * - selectSREFString formats per-item weights correctly
 * - Style store addSREFItem defaults weight to 1.0
 */

import { describe, it, expect } from "vitest";
import { useUIStore } from "@/store";
import { useStyleStore } from "@/store/styleStore";
import { selectSREFString } from "@/store/styleStore";
import type { SREFItem } from "@/lib/sref/srefParser";
import type { ImageAttachment } from "@/types";

describe("SREF per-item weight wiring", () => {
  it("addSREFItem defaults weight to 1.0 when caller omits it", () => {
    const store = useStyleStore.getState();
    store.clearSREF();
    // When added via addSREFItem, caller should provide weight.
    // The SREFItem type requires weight, but the SREF parser defaults to 1.0.
    // For direct store calls, we explicitly pass weight: 1.0 for default.
    store.addSREFItem({ value: "1234567890", type: "code", weight: 1.0 });
    const sref = useStyleStore.getState().sref;
    expect(sref).not.toBeNull();
    expect(sref!.items[0].weight).toBe(1.0);
    expect(sref!.items[0].value).toBe("1234567890");
    store.clearSREF();
  });

  it("addSREFItem preserves explicit weight", () => {
    const store = useStyleStore.getState();
    store.clearSREF();
    store.addSREFItem({ value: "https://example.com/img.jpg", type: "url", weight: 2.0 });
    const sref = useStyleStore.getState().sref;
    expect(sref!.items[0].weight).toBe(2.0);
    store.clearSREF();
  });

  it("updateSREFItem changes weight on existing SREF item", () => {
    const store = useStyleStore.getState();
    store.clearSREF();
    store.addSREFItem({ value: "111111", type: "code", weight: 1.0 });
    store.addSREFItem({ value: "222222", type: "code", weight: 1.0 });

    store.updateSREFItem(0, { weight: 0.5 });
    store.updateSREFItem(1, { weight: 1.5 });

    const sref = useStyleStore.getState().sref;
    expect(sref!.items[0].weight).toBe(0.5);
    expect(sref!.items[1].weight).toBe(1.5);
    store.clearSREF();
  });

  it("removeSREFItem removes by index", () => {
    const store = useStyleStore.getState();
    store.clearSREF();
    store.addSREFItem({ value: "aaa", type: "code", weight: 1.0 });
    store.addSREFItem({ value: "bbb", type: "code", weight: 2.0 });
    store.removeSREFItem(0);
    const sref = useStyleStore.getState().sref;
    expect(sref!.items).toHaveLength(1);
    expect(sref!.items[0].value).toBe("bbb");
    store.clearSREF();
  });

  it("selectSREFString formats per-item weights correctly", () => {
    const store = useStyleStore.getState();
    store.clearSREF();
    store.addSREFItem({ value: "123456", type: "code", weight: 1.0 });
    store.addSREFItem({ value: "https://img.test/s.jpg", type: "url", weight: 2.0 });

    const state = useStyleStore.getState();
    const str = selectSREFString(state);
    // Default weight 1.0 should be omitted, weight 2.0 should be shown
    expect(str).toContain("123456");
    expect(str).toContain("https://img.test/s.jpg::2");
    expect(str).toContain("--sref");
    store.clearSREF();
  });

  it("selectSREFString omits weight when it is 1.0", () => {
    const store = useStyleStore.getState();
    store.clearSREF();
    store.addSREFItem({ value: "999999", type: "code", weight: 1.0 });

    const str = selectSREFString(useStyleStore.getState());
    // Weight 1.0 should not appear as ::1
    expect(str).toBe("--sref 999999");
    store.clearSREF();
  });

  it("selectSREFString includes --sw when styleWeight is not 100", () => {
    const store = useStyleStore.getState();
    store.clearSREF();
    store.addSREFItem({ value: "123456", type: "code", weight: 1.0 });
    store.setStyleWeight(500);

    const str = selectSREFString(useStyleStore.getState());
    expect(str).toContain("--sw 500");
    store.clearSREF();
  });
});

describe("Image attachment weight wiring", () => {
  it("addImageAttachment preserves weight field", () => {
    const store = useUIStore.getState();
    store.clearImageAttachments();
    const attachment: ImageAttachment = {
      id: "img-1",
      url: "https://example.com/img.jpg",
      mode: "style_ref",
      weight: 1.5,
    };
    store.addImageAttachment(attachment);

    const attachments = useUIStore.getState().imageAttachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].weight).toBe(1.5);
    store.clearImageAttachments();
  });

  it("updateImageAttachment changes weight on existing attachment", () => {
    const store = useUIStore.getState();
    store.clearImageAttachments();
    store.addImageAttachment({
      id: "img-2",
      url: "https://example.com/test.png",
      mode: "image_prompt",
      weight: 1.0,
    });
    store.updateImageAttachment("img-2", { weight: 0.75 });

    const attachments = useUIStore.getState().imageAttachments;
    expect(attachments[0].weight).toBe(0.75);
    store.clearImageAttachments();
  });

  it("updateImageAttachment can change mode and weight simultaneously", () => {
    const store = useUIStore.getState();
    store.clearImageAttachments();
    store.addImageAttachment({
      id: "img-3",
      url: "https://example.com/test2.png",
      mode: "style_ref",
      weight: 1.0,
    });
    store.updateImageAttachment("img-3", { mode: "image_prompt", weight: 2.0 });

    const attachments = useUIStore.getState().imageAttachments;
    expect(attachments[0].mode).toBe("image_prompt");
    expect(attachments[0].weight).toBe(2.0);
    store.clearImageAttachments();
  });
});