"use client";

/**
 * Skip links: the first Tab stops on every page, visible only on focus.
 * Focus is moved in JS (no URL fragment): a `#hash` navigation would fire
 * popstate, which the nav URL sync treats as back/forward.
 */
const LINKS = [
  { target: "desktop_input_bar", label: "Skip to prompt" },
  { target: "pageScroll", label: "Skip to content" },
] as const;

export function SkipLinks() {
  return (
    <>
      {LINKS.map(({ target, label }) => (
        <a
          key={target}
          href={`#${target}`}
          className="cj-skip-link"
          onClick={(e) => {
            // Never fall through to the hash navigation. Pages without a
            // visible prompt bar (admin pages, Tools on a phone) skip to
            // the content instead.
            e.preventDefault();
            let el = document.getElementById(target);
            if (!el || el.getClientRects().length === 0) {
              el = document.getElementById("pageScroll");
            }
            if (!el) return;
            if (!el.hasAttribute("tabindex") && !("value" in el)) {
              el.setAttribute("tabindex", "-1");
            }
            el.focus();
          }}
        >
          {label}
        </a>
      ))}
    </>
  );
}
