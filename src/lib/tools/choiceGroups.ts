/**
 * Grouping + search for large option catalogs (camera moves, motion
 * presets, looks, voices) shown as a searchable chip grid instead of a
 * long <select>. Pure so the rules are unit-tested.
 */

import { groupOptions, type ActionChoice } from "./toolsPage";

export interface ChoiceGroup<T extends ActionChoice = ActionChoice> {
  group: string;
  options: T[];
}

/** First item inside the label's parentheses: "Emma (English, woman)" → "English". */
export function parenGroup(label: string): string | null {
  const m = /\(([^,()]+)[,)]/.exec(label);
  return m ? m[1].trim() : null;
}

/**
 * Explicit `group` runs when the catalog has them; otherwise group by the
 * label's parenthetical when nearly every option has one (voice lists);
 * otherwise a single unnamed group.
 */
export function choiceGroups<T extends ActionChoice>(
  options: T[],
): ChoiceGroup<T>[] {
  if (options.some((o) => o.group)) return groupOptions(options);
  const tagged = options.map((o) => ({ o, g: parenGroup(o.label) }));
  const withTag = tagged.filter((t) => t.g).length;
  if (options.length >= 8 && withTag / options.length >= 0.8) {
    const order: string[] = [];
    const by = new Map<string, T[]>();
    for (const { o, g } of tagged) {
      const k = g ?? "Other";
      if (!by.has(k)) {
        by.set(k, []);
        order.push(k);
      }
      by.get(k)!.push(o);
    }
    if (order.length > 1)
      return order.map((group) => ({ group, options: by.get(group)! }));
  }
  return [{ group: "", options }];
}

/** AND-of-words match over label + group; empty groups dropped. */
export function filterChoiceGroups<T extends ActionChoice>(
  groups: ChoiceGroup<T>[],
  query: string,
): ChoiceGroup<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  return groups
    .map((g) => ({
      group: g.group,
      options: g.options.filter((o) => {
        const hay =
          `${o.label} ${g.group} ${o.id.replace(/[_-]/g, " ")}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((g) => g.options.length > 0);
}

/**
 * Chip text inside a group: drop the part the group heading already says.
 * "Emma (English, woman)" in "English" → "Emma · woman".
 */
export function chipLabel(label: string, group: string): string {
  if (!group) return label;
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(label);
  if (!m) return label;
  const parts = m[2].split(",").map((p) => p.trim());
  if (parts[0] !== group) return label;
  const rest = parts.slice(1).filter(Boolean);
  return rest.length ? `${m[1]} · ${rest.join(", ")}` : m[1];
}

/** Search box only earns its space on long lists. */
export const CHOICE_SEARCH_MIN = 12;
