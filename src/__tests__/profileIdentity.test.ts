import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_FALLBACK, profileIdentity } from "@/lib/ui/profileIdentity";

describe("account row identity (C14)", () => {
  it("uses the display name, then the username", () => {
    expect(
      profileIdentity(JSON.stringify({ displayName: "Mika", username: "m" })),
    ).toEqual({ name: "Mika", initial: "M" });
    expect(
      profileIdentity(JSON.stringify({ displayName: "User", username: "rio" })),
    ).toEqual({ name: "rio", initial: "R" });
  });

  it("treats missing, broken and placeholder profiles as unset", () => {
    expect(profileIdentity(null)).toEqual(PROFILE_FALLBACK);
    expect(profileIdentity("{nope")).toEqual(PROFILE_FALLBACK);
    expect(profileIdentity("42")).toEqual(PROFILE_FALLBACK);
    expect(
      profileIdentity(
        JSON.stringify({ displayName: "User", username: "user" }),
      ),
    ).toEqual(PROFILE_FALLBACK);
    expect(profileIdentity(JSON.stringify({ displayName: "  " }))).toEqual(
      PROFILE_FALLBACK,
    );
    expect(PROFILE_FALLBACK.initial).toBeNull();
  });

  it("Sidebar and the mobile menu show the avatar only, no name or U / User", () => {
    for (const f of ["Sidebar.tsx", "MobileBottomNav.tsx"]) {
      const src = readFileSync(
        path.join(process.cwd(), "src/components", f),
        "utf8",
      );
      expect(src).toContain("useProfileIdentity()");
      expect(src).toContain("identity.initial");
      expect(src).not.toContain("identity.name");
      expect(src).not.toMatch(/>\s*Profile\s*</);
      expect(src).not.toMatch(/>\s*User\s*</);
      expect(src).not.toMatch(/>\s*U\s*</);
    }
  });
});
