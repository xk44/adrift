/**
 * Arrow-key movement in a radio group (WAI-ARIA radio pattern): the next
 * enabled option in `dir`, wrapping around; Home/End jump to the first/last
 * enabled one. Returns null when nothing is enabled or the key is not a
 * navigation key.
 */
export function radioKeyTarget(
  disabled: readonly boolean[],
  from: number,
  key: string,
): number | null {
  const n = disabled.length;
  if (n === 0 || disabled.every(Boolean)) return null;
  const firstFrom = (start: number, step: 1 | -1): number => {
    for (let i = 0; i < n; i++) {
      const at = (((start + step * i) % n) + n) % n;
      if (!disabled[at]) return at;
    }
    return start;
  };
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return firstFrom(from + 1, 1);
    case "ArrowLeft":
    case "ArrowUp":
      return firstFrom(from - 1, -1);
    case "Home":
      return firstFrom(0, 1);
    case "End":
      return firstFrom(n - 1, -1);
    default:
      return null;
  }
}
