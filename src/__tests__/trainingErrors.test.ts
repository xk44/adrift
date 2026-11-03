import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATASET_ROOTS_HINT,
  trainingStartErrorMessage,
} from "@/lib/sref/trainingErrors";

describe("trainingStartErrorMessage", () => {
  it("turns the proxy's dataset-roots 400 into a plain .env.local hint", () => {
    const err = new Error(
      "images_dir must be a folder under CJ_VAULT_DATASET_ROOTS (set it in .env.local), or train from a cluster instead.",
    );
    expect(trainingStartErrorMessage(err)).toBe(DATASET_ROOTS_HINT);
    expect(DATASET_ROOTS_HINT).toMatch(/CJ_VAULT_DATASET_ROOTS in \.env\.local/);
  });

  it("passes other errors through without the Error: prefix", () => {
    expect(trainingStartErrorMessage(new Error("HTTP 502"))).toBe("HTTP 502");
    expect(trainingStartErrorMessage("Error: boom")).toBe("boom");
  });

  it("TrainView uses it for training start failures", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/style/library/TrainView.tsx"),
      "utf8",
    );
    expect(src).toContain("msg: trainingStartErrorMessage(e)");
  });
});
