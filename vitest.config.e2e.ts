import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * E2E test config — requires ComfyUI + Z-Image-Turbo fixtures.
 *
 * Required fixtures:
 *   - ComfyUI running at http://127.0.0.1:8188
 *   - Z-Image-Turbo models in ComfyUI models dir:
 *       unet/z_image_turbo_bf16.safetensors
 *       clip/qwen_3_4b.safetensors
 *       vae/ae.safetensors
 *       loras/zimageturbo/pixel_art_style_z_image_turbo.safetensors
 *   - UI-format workflow at:
 *       <COMFY_ROOT>/user/default/workflows/zimageturbo-test.json
 *
 * Enable live suites by setting:
 *   COMFY_LIVE_TESTS=1 npm run test:e2e
 *
 * Without the env flag, live describe blocks are skipped automatically
 * (see describe.skipIf(SKIP_LIVE) guards in the test files).
 */

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react() as any],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/**/*.e2e.test.{js,ts}",
      "src/**/__tests__/e2e/**/*.{test,spec}.{js,ts}",
      "src/__tests__/e2e-comfyui.test.ts",
    ],
    exclude: ["node_modules", "dist", ".next"],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
