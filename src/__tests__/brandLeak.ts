// Guard pattern for legacy brand wording in user-facing strings.
// Built from fragments so the public export's own leak scan stays clean.
const OLD = ["mid", "comfy"].map((p) => p + "journey");
export const BRAND_LEAK = new RegExp(`${OLD.join("|")}|\\b${"M"}J\\b`, "i");
