/**
 * Tests for local inventory — file/image/video/audio inventory plumbing,
 * category mapping, option resolution, validation, and enrichment
 * for workflow control pickers.
 */

import { describe, expect, it } from "vitest";
import {
  SUBTYPE_TO_FILE_INVENTORY_KEY,
  SUBTYPE_TO_MODEL_INVENTORY_KEY,
  FILE_INVENTORY_LABELS,
  getImageOptionsForControl,
  getFileOptionsForControl,
  validateImageChoice,
  validateFileChoice,
  filterBySubtypeExtensions,
  getFileInventoryLabel,
  type LocalInventory,
  type FileInventoryKey,
  type ControlSubtype,
  type ControlSchema,
} from "@/lib/oj/workflowControlSchema";
import {
  extractFileInventory,
  extractInputList,
  extractFirstInputList,
  INPUT_FILE_EXTRACTORS,
  buildLocalInventory,
  EMPTY_LOCAL_INVENTORY,
  type ObjectInfoResponse,
} from "@/lib/oj/localInventory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeControl(
  kind: "image" | "file",
  inputKey: string,
  overrides: Partial<ControlSchema> = {},
): ControlSchema {
  return {
    key: `1.${inputKey}`,
    nodeId: "1",
    inputKey,
    classType: overrides.classType ?? "SomeNode",
    kind,
    label: overrides.label ?? inputKey,
    group: overrides.group ?? "Default",
    defaultValue: overrides.defaultValue ?? "",
    visible: overrides.visible ?? true,
    order: overrides.order ?? 100,
    ...overrides,
  };
}

function makeImageControl(inputKey: string, overrides: Partial<ControlSchema> = {}): ControlSchema {
  return makeControl("image", inputKey, overrides);
}

function makeFileControl(inputKey: string, overrides: Partial<ControlSchema> = {}): ControlSchema {
  return makeControl("file", inputKey, overrides);
}

// ---------------------------------------------------------------------------
// SUBTYPE_TO_FILE_INVENTORY_KEY
// ---------------------------------------------------------------------------

describe("SUBTYPE_TO_FILE_INVENTORY_KEY", () => {
  it("maps image-like subtypes to input_images", () => {
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY.image).toBe("input_images");
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY.mask).toBe("input_images");
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY.reference).toBe("input_images");
  });

  it("maps video subtype to input_videos", () => {
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY.video).toBe("input_videos");
  });

  it("maps audio subtype to input_audios", () => {
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY.audio).toBe("input_audios");
  });

  it("does not map animation or model-file to file inventory keys", () => {
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY.animation).toBeUndefined();
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY["model-file"]).toBeUndefined();
    expect(SUBTYPE_TO_FILE_INVENTORY_KEY.generic).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SUBTYPE_TO_MODEL_INVENTORY_KEY
// ---------------------------------------------------------------------------

describe("SUBTYPE_TO_MODEL_INVENTORY_KEY", () => {
  it("maps animation to animatediff_models", () => {
    expect(SUBTYPE_TO_MODEL_INVENTORY_KEY.animation).toBe("animatediff_models");
  });
});

// ---------------------------------------------------------------------------
// FILE_INVENTORY_LABELS
// ---------------------------------------------------------------------------

describe("FILE_INVENTORY_LABELS", () => {
  it("has labels for all file inventory keys", () => {
    const keys: FileInventoryKey[] = ["input_images", "input_videos", "input_audios"];
    for (const key of keys) {
      expect(FILE_INVENTORY_LABELS[key]).toBeDefined();
      expect(FILE_INVENTORY_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  it("produces human-readable labels", () => {
    expect(FILE_INVENTORY_LABELS.input_images).toBe("Input Images");
    expect(FILE_INVENTORY_LABELS.input_videos).toBe("Input Videos");
    expect(FILE_INVENTORY_LABELS.input_audios).toBe("Input Audio");
  });
});

// ---------------------------------------------------------------------------
// getFileInventoryLabel
// ---------------------------------------------------------------------------

describe("getFileInventoryLabel", () => {
  it("returns known labels", () => {
    expect(getFileInventoryLabel("input_images")).toBe("Input Images");
    expect(getFileInventoryLabel("input_videos")).toBe("Input Videos");
    expect(getFileInventoryLabel("input_audios")).toBe("Input Audio");
  });
});

// ---------------------------------------------------------------------------
// getImageOptionsForControl
// ---------------------------------------------------------------------------

describe("getImageOptionsForControl", () => {
  const inventory: LocalInventory = {
    input_images: ["photo.png", "mask.png", "ref_image.jpg", "landscape.webp"],
    input_videos: ["vid1.mp4", "vid2.webm"],
    checkpoints: [],
    loras: [],
    vaes: [],
  };

  it("returns image options for a generic image control", () => {
    const ctrl = makeImageControl("image", { classType: "LoadImage" });
    const options = getImageOptionsForControl(ctrl, inventory);
    expect(options).toEqual(["photo.png", "mask.png", "ref_image.jpg", "landscape.webp"]);
  });

  it("returns image options for a mask control (same bucket)", () => {
    const ctrl = makeImageControl("mask", { classType: "LoadImageMask" });
    const options = getImageOptionsForControl(ctrl, inventory);
    // mask subtype maps to input_images
    expect(options).toEqual(["photo.png", "mask.png", "ref_image.jpg", "landscape.webp"]);
  });

  it("returns empty array for non-image controls", () => {
    const fileCtrl = makeFileControl("video_path", { classType: "VHS_LoadVideo" });
    expect(getImageOptionsForControl(fileCtrl, inventory)).toEqual([]);
  });

  it("returns empty array when no input_images in inventory", () => {
    const emptyInv: LocalInventory = { checkpoints: [], loras: [] };
    const ctrl = makeImageControl("image", { classType: "LoadImage" });
    expect(getImageOptionsForControl(ctrl, emptyInv)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFileOptionsForControl
// ---------------------------------------------------------------------------

describe("getFileOptionsForControl", () => {
  const inventory: LocalInventory = {
    input_images: ["photo.png"],
    input_videos: ["vid1.mp4", "vid2.webm"],
    input_audios: ["track.mp3", "sound.wav"],
    animatediff_models: ["mm_v2.safetensors"],
    checkpoints: [],
    loras: [],
  };

  it("returns video options for video_path control", () => {
    const ctrl = makeFileControl("video_path", { classType: "VHS_LoadVideo" });
    const options = getFileOptionsForControl(ctrl, inventory);
    expect(options).toEqual(["vid1.mp4", "vid2.webm"]);
  });

  it("returns audio options for audio_path control", () => {
    const ctrl = makeFileControl("audio_path", { classType: "VHS_LoadAudio" });
    const options = getFileOptionsForControl(ctrl, inventory);
    expect(options).toEqual(["track.mp3", "sound.wav"]);
  });

  it("returns animatediff models for animation model_path control", () => {
    const ctrl = makeFileControl("model_path", { classType: "AnimateDiffLoaderWithContext" });
    const options = getFileOptionsForControl(ctrl, inventory);
    expect(options).toEqual(["mm_v2.safetensors"]);
  });

  it("returns empty for non-file controls", () => {
    const imgCtrl = makeImageControl("image", { classType: "LoadImage" });
    expect(getFileOptionsForControl(imgCtrl, inventory)).toEqual([]);
  });

  it("returns empty when no relevant inventory exists", () => {
    const emptyInv: LocalInventory = { checkpoints: [] };
    const ctrl = makeFileControl("video_path", { classType: "VHS_LoadVideo" });
    expect(getFileOptionsForControl(ctrl, emptyInv)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateImageChoice
// ---------------------------------------------------------------------------

describe("validateImageChoice", () => {
  const inventory: LocalInventory = {
    input_images: ["photo.png", "mask.png", "ref_image.jpg"],
    checkpoints: [],
    loras: [],
  };

  it("validates a known image as valid", () => {
    const ctrl = makeImageControl("image", {
      classType: "LoadImage",
      defaultValue: "photo.png",
    });
    const result = validateImageChoice(ctrl, inventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(true);
    expect(result.options).toEqual(["photo.png", "mask.png", "ref_image.jpg"]);
    expect(result.categoryLabel).toBe("Input Images");
  });

  it("validates an unknown image as invalid when inventory exists", () => {
    const ctrl = makeImageControl("image", {
      classType: "LoadImage",
      defaultValue: "missing.png",
    });
    const result = validateImageChoice(ctrl, inventory);
    expect(result.isValid).toBe(false);
    expect(result.hasInventory).toBe(true);
  });

  it("assumes valid when no inventory exists", () => {
    const emptyInv: LocalInventory = { checkpoints: [] };
    const ctrl = makeImageControl("image", {
      classType: "LoadImage",
      defaultValue: "anything.png",
    });
    const result = validateImageChoice(ctrl, emptyInv);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(false);
  });

  it("returns early with defaults for non-image controls", () => {
    const fileCtrl = makeFileControl("video_path", { classType: "VHS_LoadVideo" });
    const result = validateImageChoice(fileCtrl, inventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(false);
    expect(result.options).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateFileChoice
// ---------------------------------------------------------------------------

describe("validateFileChoice", () => {
  const inventory: LocalInventory = {
    input_videos: ["vid1.mp4", "vid2.webm"],
    input_audios: ["track.mp3"],
    animatediff_models: ["mm_v2.safetensors", "mm_v3.safetensors"],
    checkpoints: [],
    loras: [],
  };

  it("validates video file against input_videos", () => {
    const ctrl = makeFileControl("video_path", {
      classType: "VHS_LoadVideo",
      defaultValue: "vid1.mp4",
    });
    const result = validateFileChoice(ctrl, inventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(true);
    expect(result.categoryLabel).toBe("Input Videos");
  });

  it("validates animation files against animatediff models", () => {
    const ctrl = makeFileControl("model_path", {
      classType: "AnimateDiffLoaderWithContext",
      defaultValue: "mm_v2.safetensors",
    });
    const result = validateFileChoice(ctrl, inventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(true);
    expect(result.categoryLabel).toBe("AnimateDiff Models");
  });

  it("detects invalid video file", () => {
    const ctrl = makeFileControl("video_path", {
      classType: "VHS_LoadVideo",
      defaultValue: "nonexistent.mp4",
    });
    const result = validateFileChoice(ctrl, inventory);
    expect(result.isValid).toBe(false);
    expect(result.hasInventory).toBe(true);
  });

  it("returns defaults for non-file controls", () => {
    const imgCtrl = makeImageControl("image", { classType: "LoadImage" });
    const result = validateFileChoice(imgCtrl, inventory);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(false);
  });

  it("assumes valid when no inventory exists", () => {
    const emptyInv: LocalInventory = { checkpoints: [] };
    const ctrl = makeFileControl("video_path", {
      classType: "VHS_LoadVideo",
      defaultValue: "anything.mp4",
    });
    const result = validateFileChoice(ctrl, emptyInv);
    expect(result.isValid).toBe(true);
    expect(result.hasInventory).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterBySubtypeExtensions
// ---------------------------------------------------------------------------

describe("filterBySubtypeExtensions", () => {
  it("filters image files by image extensions", () => {
    const files = ["photo.png", "doc.pdf", "mask.jpg", "archive.zip", "ref.webp"];
    expect(filterBySubtypeExtensions(files, "image")).toEqual(
      ["photo.png", "mask.jpg", "ref.webp"],
    );
  });

  it("filters video files by video extensions", () => {
    const files = ["movie.mp4", "song.mp3", "clip.webm", "doc.txt", "trailer.mkv"];
    expect(filterBySubtypeExtensions(files, "video")).toEqual(
      ["movie.mp4", "clip.webm", "trailer.mkv"],
    );
  });

  it("filters audio files by audio extensions", () => {
    const files = ["track.mp3", "song.wav", "photo.png", "ambient.flac"];
    expect(filterBySubtypeExtensions(files, "audio")).toEqual(
      ["track.mp3", "song.wav", "ambient.flac"],
    );
  });

  it("returns all files for generic subtype (no filter)", () => {
    const files = ["anything.xyz", "something.abc"];
    expect(filterBySubtypeExtensions(files, "generic")).toEqual(files);
  });

  it("includes files without extensions for filtered subtypes", () => {
    const files = ["noext", "photo.png", "README"];
    expect(filterBySubtypeExtensions(files, "image")).toEqual(
      ["noext", "photo.png", "README"],
    );
  });

  it("returns empty array as-is", () => {
    expect(filterBySubtypeExtensions([], "image")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// localInventory — extractFileInventory
// ---------------------------------------------------------------------------

describe("extractFileInventory", () => {
  it("extracts image list from LoadImage node", () => {
    const data: ObjectInfoResponse = {
      LoadImage: {
        input: {
          required: {
            image: [["photo.png", "mask.png", "ref.jpg"], {}],
          },
        },
      },
    };
    const result = extractFileInventory(data);
    expect(result.input_images).toEqual(["photo.png", "mask.png", "ref.jpg"]);
  });

  it("extracts video list from VHS_LoadVideo node", () => {
    const data: ObjectInfoResponse = {
      VHS_LoadVideo: {
        input: {
          required: {
            video: [["vid1.mp4", "vid2.webm"], {}],
          },
        },
      },
    };
    const result = extractFileInventory(data);
    expect(result.input_videos).toEqual(["vid1.mp4", "vid2.webm"]);
  });

  it("extracts audio list from VHS_LoadAudio node", () => {
    const data: ObjectInfoResponse = {
      VHS_LoadAudio: {
        input: {
          required: {
            audio: [["track.mp3", "sound.wav"], {}],
          },
        },
      },
    };
    const result = extractFileInventory(data);
    expect(result.input_audios).toEqual(["track.mp3", "sound.wav"]);
  });

  it("extracts all categories simultaneously", () => {
    const data: ObjectInfoResponse = {
      LoadImage: {
        input: { required: { image: [["img.png"], {}] } },
      },
      VHS_LoadVideo: {
        input: { required: { video: [["vid.mp4"], {}] } },
      },
      VHS_LoadAudio: {
        input: { required: { audio: [["snd.mp3"], {}] } },
      },
    };
    const result = extractFileInventory(data);
    expect(result.input_images).toEqual(["img.png"]);
    expect(result.input_videos).toEqual(["vid.mp4"]);
    expect(result.input_audios).toEqual(["snd.mp3"]);
  });

  it("returns empty inventory when no relevant nodes exist", () => {
    const data: ObjectInfoResponse = {
      KSampler: {
        input: { required: { seed: [0, {}] } },
      },
    };
    const result = extractFileInventory(data);
    expect(result.input_images).toBeUndefined();
    expect(result.input_videos).toBeUndefined();
    expect(result.input_audios).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// localInventory — extractInputList
// ---------------------------------------------------------------------------

describe("extractInputList", () => {
  const data: ObjectInfoResponse = {
    LoadImage: {
      input: {
        required: {
          image: [["photo.png", "mask.png"], {}],
        },
      },
    },
  };

  it("extracts a list from a known node input", () => {
    expect(extractInputList(data, "LoadImage", "image")).toEqual(
      ["photo.png", "mask.png"],
    );
  });

  it("returns empty array for missing node type", () => {
    expect(extractInputList(data, "MissingNode", "image")).toEqual([]);
  });

  it("returns empty array for missing input name", () => {
    expect(extractInputList(data, "LoadImage", "nonexistent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// localInventory — extractFirstInputList
// ---------------------------------------------------------------------------

describe("extractFirstInputList", () => {
  const data: ObjectInfoResponse = {
    LoadImage: {
      input: { required: { image: [["a.png", "b.png"], {}] } },
    },
    LoadImageMask: {
      input: { required: { image: [["c.png"], {}] } },
    },
  };

  it("returns first available list", () => {
    expect(
      extractFirstInputList(data, [
        ["LoadImage", "image"],
        ["LoadImageMask", "image"],
      ]),
    ).toEqual(["a.png", "b.png"]);
  });

  it("falls back to next candidate if first is empty", () => {
    const emptyData: ObjectInfoResponse = {
      LoadImage: { input: { required: { image: [[], {}] } } },
      LoadImageMask: { input: { required: { image: [["c.png"], {}] } } },
    };
    expect(
      extractFirstInputList(emptyData, [
        ["LoadImage", "image"],
        ["LoadImageMask", "image"],
      ]),
    ).toEqual(["c.png"]);
  });

  it("returns empty array when all candidates fail", () => {
    expect(
      extractFirstInputList(data, [
        ["MissingNode", "image"],
        ["AlsoMissing", "image"],
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildLocalInventory
// ---------------------------------------------------------------------------

describe("buildLocalInventory", () => {
  it("merges model and file inventory", () => {
    const models = {
      checkpoints: ["sdxl_base.safetensors"],
      loras: ["style.safetensors"],
      vaes: [],
    };
    const files = {
      input_images: ["photo.png", "mask.png"],
      input_videos: ["vid.mp4"],
    };

    const inv = buildLocalInventory(models, files);
    expect(inv.checkpoints).toEqual(["sdxl_base.safetensors"]);
    expect(inv.loras).toEqual(["style.safetensors"]);
    expect(inv.input_images).toEqual(["photo.png", "mask.png"]);
    expect(inv.input_videos).toEqual(["vid.mp4"]);
  });

  it("works with empty file inventory", () => {
    const models = { checkpoints: ["a.safetensors"], loras: [], vaes: [] };
    const inv = buildLocalInventory(models);
    expect(inv.checkpoints).toEqual(["a.safetensors"]);
    expect(inv.input_images).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EMPTY_LOCAL_INVENTORY
// ---------------------------------------------------------------------------

describe("EMPTY_LOCAL_INVENTORY", () => {
  it("has all keys with empty arrays", () => {
    expect(EMPTY_LOCAL_INVENTORY.checkpoints).toEqual([]);
    expect(EMPTY_LOCAL_INVENTORY.loras).toEqual([]);
    expect(EMPTY_LOCAL_INVENTORY.input_images).toEqual([]);
    expect(EMPTY_LOCAL_INVENTORY.input_videos).toEqual([]);
    expect(EMPTY_LOCAL_INVENTORY.input_audios).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// INPUT_FILE_EXTRACTORS
// ---------------------------------------------------------------------------

describe("INPUT_FILE_EXTRACTORS", () => {
  it("has extractors for all file inventory keys", () => {
    const keys: FileInventoryKey[] = ["input_images", "input_videos", "input_audios"];
    for (const key of keys) {
      expect(INPUT_FILE_EXTRACTORS[key]).toBeDefined();
      expect(INPUT_FILE_EXTRACTORS[key].length).toBeGreaterThan(0);
    }
  });

  it("uses LoadImage and LoadImageMask for images", () => {
    const extractors = INPUT_FILE_EXTRACTORS.input_images;
    expect(extractors).toContainEqual(["LoadImage", "image"]);
    expect(extractors).toContainEqual(["LoadImageMask", "image"]);
  });

  it("uses VHS_LoadVideo for videos", () => {
    const extractors = INPUT_FILE_EXTRACTORS.input_videos;
    expect(extractors.some(([node]) => node === "VHS_LoadVideo")).toBe(true);
  });

  it("uses VHS_LoadAudio for audio", () => {
    const extractors = INPUT_FILE_EXTRACTORS.input_audios;
    expect(extractors.some(([node]) => node === "VHS_LoadAudio")).toBe(true);
  });
});