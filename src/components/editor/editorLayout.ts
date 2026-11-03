/**
 * Edit-tab panel layout. Desktop: toolbar | canvas | export side by side.
 * Below `md` the fixed-width side panels would leave the canvas 0px wide on a
 * 390px phone, so there the canvas takes the full width and the toolbar and
 * export panels share one height-capped sheet under it, switched by tabs.
 */
export type EditorMobilePanel = "tools" | "export";

export function editorPanelClass(
  panel: EditorMobilePanel,
  hasImage: boolean,
  mobilePanel: EditorMobilePanel,
): string {
  // No image: the start screen gets the whole phone; desktop keeps the toolbar.
  if (!hasImage) return "hidden md:flex";
  const mobile = panel === mobilePanel ? "flex" : "hidden";
  return `${mobile} order-3 max-h-[42vh] min-h-0 md:order-none md:flex md:max-h-none`;
}
