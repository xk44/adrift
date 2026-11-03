import type { NextConfig } from "next";

import { frameAncestorsFromEnv } from "./src/lib/overlay/frameAncestors";

// Origins allowed to embed Adrift in an iframe (the ComfyUI overlay bridge):
// loopback :8188 / :8000, the configured ComfyUI machine(s) (env or saved in
// Settings, read at startup) and CJ_FRAME_ANCESTORS="http://host:port ...".
const FRAME_ANCESTORS = frameAncestorsFromEnv().join(" ");

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // The dev-only "N" route/build badge covers the mobile Menu tab and the
  // desktop avatar. (Next 15.1 has no `devIndicators: false`; these two
  // flags are every indicator it draws.)
  devIndicators: {
    buildActivity: false,
    appIsrStatus: false,
  },

  // Production builds run in a separate dir so `npm run build` can't corrupt
  // a running dev server's .next chunk cache (symptom: white page, CSS URLs
  // returning HTML). Verification builds: NEXT_DIST_DIR=.next-build npm run build
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // Docker image builds set NEXT_OUTPUT=standalone (docker/Dockerfile.adrift)
  // for a self-contained server.js; dev/start/tests are unaffected.
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone" as const }
    : {}),

  // Security headers
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No X-Frame-Options: it cannot express an allowlist and would
          // override frame-ancestors in some browsers. CSP governs framing.
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${FRAME_ANCESTORS}`,
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },

  // Allow images from ComfyUI
  images: {
    remotePatterns: [
      {
        protocol: "http",
        hostname: "127.0.0.1",
        port: "8188",
        pathname: "/view/**",
      },
      {
        protocol: "http",
        hostname: "localhost",
        port: "8188",
        pathname: "/view/**",
      },
    ],
    // Disable image optimization for proxied images
    unoptimized: true,
  },

  // Environment variables exposed to the browser
  env: {
    NEXT_PUBLIC_COMFY_WS_BASE:
      process.env.NEXT_PUBLIC_COMFY_WS_BASE ?? "ws://127.0.0.1:8188",
    // Browser mirror of the server-only CJ_DEFAULT_PACK so the client memory
    // guard and the imagine route agree on the default pack (packs.ts).
    NEXT_PUBLIC_CJ_DEFAULT_PACK: process.env.CJ_DEFAULT_PACK?.trim() ?? "",
  },

  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },

  webpack: (config, { isServer }) => {
    // Handle node: protocol imports
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    return config;
  },
};

export default nextConfig;
