"use client";

import { userToolWorkflowOptions } from "@/lib/userTools/registry";
import { useUserTools } from "@/store/userToolsStore";

/**
 * Workflows page assignment <select>: imported tools as "user:<id>"
 * sources, in their own group. Renders nothing when there are none.
 */
export function UserToolAssignmentOptions() {
  const options = userToolWorkflowOptions(useUserTools());
  if (options.length === 0) return null;
  return (
    <optgroup label="My tools">
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </optgroup>
  );
}
