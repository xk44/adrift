import { notFound } from "next/navigation";
import { LightboxFixture } from "./LightboxFixture";

export const dynamic = "force-dynamic";

/**
 * Dev-only lightbox fixture: opens the real Lightbox on synthetic items so
 * its layout can be checked without touching the gallery. 404 outside
 * `next dev`.
 */
export default function DevLightboxPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <LightboxFixture />;
}
