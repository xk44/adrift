/**
 * Prepend trigger words for selected LoRAs to a prompt,
 * skipping words already present in the prompt.
 */
export function injectTriggerWords(
  prompt: string,
  loras: Array<{ name: string; strength: number }>,
  getTriggers: (filename: string) => string[],
): string {
  const triggers: string[] = [];
  for (const lora of loras) {
    const words = getTriggers(lora.name);
    for (const word of words) {
      if (
        !prompt.toLowerCase().includes(word.toLowerCase()) &&
        !triggers.includes(word)
      ) {
        triggers.push(word);
      }
    }
  }
  if (triggers.length === 0) return prompt;
  return `${triggers.join(", ")}, ${prompt}`;
}
