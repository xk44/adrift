import type { DownloadedModel } from "@/store/downloadStore";

type RegistryParam = {
  flags?: string[];
  kind?: string;
  description?: string;
  min?: number;
  max?: number;
  default?: string | number | boolean;
  /** Reserved params: still parsed, never suggested. */
  hidden?: boolean;
};

type Registry = {
  params?: Record<string, RegistryParam>;
};

export type LoraAutocompleteEntry = {
  shortcode: string;
  filename: string;
  displayName?: string;
  triggers?: string[];
  useCount?: number;
  isFavorite?: boolean;
};

export type PromptSuggestion =
  | {
      id: string;
      type: "wildcard";
      label: string;
      insertText: string;
      description: string;
    }
  | {
      id: string;
      type: "param";
      label: string;
      insertText: string;
      description: string;
      valueHint: string;
    }
  | {
      id: string;
      type: "trigger";
      label: string;
      insertText: string;
      description: string;
      loraName: string;
    }
  | {
      id: string;
      type: "lora";
      label: string;
      insertText: string;
      description: string;
      loraName: string;
      triggerWords: string[];
    };

export type AutocompleteContext =
  | {
      type: "param";
      query: string;
      from: number;
      to: number;
    }
  | {
      type: "trigger";
      query: string;
      from: number;
      to: number;
    }
  | {
      type: "lora";
      query: string;
      from: number;
      to: number;
    }
  | {
      type: "wildcard";
      query: string;
      from: number;
      to: number;
    };

export function getAutocompleteContext(
  value: string,
  caret: number,
): AutocompleteContext | null {
  const beforeCaret = value.slice(0, caret);
  const tokenMatch = beforeCaret.match(/(?:^|\s)(\S*)$/);
  const token = tokenMatch?.[1] ?? "";
  const tokenStart = caret - token.length;

  // `__` starts a wildcard reference (data/wildcards); still open (no closing __).
  const wildcardMatch = beforeCaret.match(/(?:^|[\s,([{])(__[a-z0-9_\-/]*)$/i);
  if (wildcardMatch) {
    const partial = wildcardMatch[1];
    const closed = partial.length > 4 && partial.endsWith("__");
    if (!closed) {
      return {
        type: "wildcard",
        query: partial.slice(2).toLowerCase(),
        from: caret - partial.length,
        to: caret,
      };
    }
  }

  if (token === "--lora") {
    return { type: "lora", query: "", from: tokenStart, to: caret };
  }

  const loraValueMatch = beforeCaret.match(/(?:^|\s)--lora\s+([^\s]*)$/);
  if (loraValueMatch) {
    const query = loraValueMatch[1] ?? "";
    return {
      type: "lora",
      query: query.toLowerCase(),
      from: caret - query.length,
      to: caret,
    };
  }

  if (token.startsWith("--")) {
    return {
      type: "param",
      query: token.toLowerCase(),
      from: tokenStart,
      to: caret,
    };
  }

  const wordMatch = beforeCaret.match(/(?:^|[\s,([{])([^\s,()[\]{}]*)$/);
  const word = wordMatch?.[1] ?? "";
  if (!word || word.startsWith("-")) return null;

  return {
    type: "trigger",
    query: word.toLowerCase(),
    from: caret - word.length,
    to: caret,
  };
}

export function getParamSuggestions(
  registry: Registry,
  query: string,
): PromptSuggestion[] {
  const params = registry.params ?? {};
  const normalizedQuery = query.toLowerCase();

  // A bare "--" browses every parameter: one row each (its shortest flag)
  // so aliases like --ar/--aspect don't crowd the short list.
  const browsing = normalizedQuery === "--";

  return Object.entries(params).flatMap(([paramName, param]) => {
    if (param.hidden) return [];
    const flags = param.flags ?? [];
    const matching = flags.filter((flag) =>
      flag.toLowerCase().startsWith(normalizedQuery),
    );
    const shown =
      browsing && matching.length > 1
        ? [matching.reduce((a, b) => (b.length < a.length ? b : a))]
        : matching;
    return shown.map((flag) => ({
        id: `param:${flag}`,
        type: "param" as const,
        label: flag,
        insertText: `${flag} `,
        description: param.description ?? paramName,
        valueHint: getParamValueHint(param),
      }));
  });
}

export function getTriggerWordSuggestions(
  downloads: DownloadedModel[],
  query: string,
  loraShortcodes: LoraAutocompleteEntry[] = [],
): PromptSuggestion[] {
  const normalizedQuery = query.toLowerCase();
  const seen = new Set<string>();
  const suggestions: PromptSuggestion[] = [];

  for (const download of downloads) {
    if (download.type.toLowerCase() !== "lora") continue;

    for (const word of download.trainedWords ?? []) {
      const label = word.trim();
      if (!label || !label.toLowerCase().startsWith(normalizedQuery)) continue;

      const id = `trigger:${download.civitaiVersionId}:${label.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const loraName = download.modelName || download.filename;
      suggestions.push({
        id,
        type: "trigger",
        label,
        insertText: `${label} `,
        description: download.versionName
          ? `${loraName} / ${download.versionName}`
          : loraName,
        loraName,
      });
    }
  }

  for (const lora of loraShortcodes) {
    for (const word of lora.triggers ?? []) {
      const label = word.trim();
      if (!label || !label.toLowerCase().startsWith(normalizedQuery)) continue;

      const id = `trigger:lora:${lora.shortcode}:${label.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const loraName = lora.displayName || lora.shortcode;
      suggestions.push({
        id,
        type: "trigger",
        label,
        insertText: `${label} `,
        description: lora.filename
          ? `${loraName} / ${lora.filename}`
          : loraName,
        loraName,
      });
    }
  }

  return suggestions;
}

export function getWildcardSuggestions(
  wildcards: { name: string; count?: number }[],
  query: string,
): PromptSuggestion[] {
  const q = query.toLowerCase();
  return wildcards
    .filter((w) => w.name.startsWith(q) || (q.length > 1 && w.name.includes(q)))
    .map((w) => ({
      id: `wildcard:${w.name}`,
      type: "wildcard" as const,
      label: `__${w.name}__`,
      insertText: `__${w.name}__ `,
      description:
        typeof w.count === "number" ? `${w.count} options` : "wildcard",
    }));
}

export function getLoraNameSuggestions(
  loraShortcodes: LoraAutocompleteEntry[],
  query: string,
  includeFlag = false,
): PromptSuggestion[] {
  const normalizedQuery = query.toLowerCase();
  const seen = new Set<string>();
  const suggestions: PromptSuggestion[] = [];

  for (const lora of loraShortcodes) {
    const label = lora.shortcode.trim();
    if (!label || !label.toLowerCase().startsWith(normalizedQuery)) continue;
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());

    const triggerWords = (lora.triggers ?? [])
      .map((word) => word.trim())
      .filter(Boolean);
    const display = lora.displayName || label;

    suggestions.push({
      id: `lora:${label.toLowerCase()}`,
      type: "lora",
      label,
      insertText: includeFlag ? `--lora ${label} ` : `${label} `,
      description: triggerWords.length
        ? `${display} / ${triggerWords.join(", ")}`
        : display,
      loraName: label,
      triggerWords,
    });
  }

  return suggestions;
}

export function buildSuggestions({
  context,
  registry,
  downloads,
  loraShortcodes = [],
  wildcards = [],
}: {
  context: AutocompleteContext;
  registry: Registry;
  downloads: DownloadedModel[];
  loraShortcodes?: LoraAutocompleteEntry[];
  wildcards?: { name: string; count?: number }[];
}): PromptSuggestion[] {
  if (context.type === "wildcard") {
    return getWildcardSuggestions(wildcards, context.query);
  }

  if (context.type === "param") {
    return getParamSuggestions(registry, context.query);
  }

  if (context.type === "lora") {
    return getLoraNameSuggestions(
      loraShortcodes,
      context.query,
      context.from !== context.to && context.query === "",
    );
  }

  return getTriggerWordSuggestions(downloads, context.query, loraShortcodes);
}

export function getParamValueHint(param: RegistryParam): string {
  if (param.kind === "flag") return "toggle";
  if (param.kind === "aspect") return "ratio";
  if (param.kind === "string") return "text";

  if (param.kind === "int" || param.kind === "float") {
    if (typeof param.min === "number" && typeof param.max === "number") {
      return `${param.min}-${param.max}`;
    }
    return param.kind === "int" ? "integer" : "number";
  }

  return param.kind ?? "value";
}
