import type { Metadata, Viewport } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { ToastContainer } from "@/components/Toast";
import { AuthGate } from "@/components/AuthGate";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { SkipLinks } from "@/components/SkipLinks";
import {
  ADRIFT_DARK,
  DEFAULT_ACCENT,
  buildThemeBootScript,
  buildThemeCss,
} from "@/lib/theme/themes";
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "@/lib/storageKeys";
import "./globals.css";

const THEME_CSS = buildThemeCss();
const THEME_BOOT = buildThemeBootScript(
  [STORAGE_KEYS.ui, LEGACY_STORAGE_KEYS[STORAGE_KEYS.ui]].filter(
    (k): k is string => Boolean(k),
  ),
);

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Adrift",
  description: "Self-hosted image, video and 3D studio for ComfyUI",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/adrift-mark.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Adrift",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: ADRIFT_DARK.semantic["--bg-primary"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme="dark"
      data-palette={ADRIFT_DARK.id}
      data-accent={DEFAULT_ACCENT}
      className={`${dmSans.variable} ${jetbrainsMono.variable}`}
      // The boot script rewrites the theme attributes before hydration.
      suppressHydrationWarning
    >
      <head>
        <style id="adrift-theme" dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="font-sans antialiased">
        <SkipLinks />
        {process.env.NODE_ENV === "development" &&
          process.env.NEXT_PUBLIC_REACT_SCAN === "1" && (
            <Script
              src="https://unpkg.com/react-scan/dist/auto.global.js"
              crossOrigin="anonymous"
              strategy="beforeInteractive"
            />
          )}
        {children}
        <AuthGate />
        <ToastContainer />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
