/** Loads the repo's public/workflows/<rel> graphs for setup resolution. */
import fs from "fs";
import path from "path";
import { stripNonNodes } from "@/lib/tools/editTools";
import type { Workflow } from "@/types";

const WORKFLOWS_DIR = () => path.join(process.cwd(), "public", "workflows");

export function loadSetupWorkflow(rel: string): Workflow | null {
  const p = path.join(WORKFLOWS_DIR(), rel);
  if (!p.startsWith(WORKFLOWS_DIR() + path.sep)) return null;
  try {
    return stripNonNodes(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}
