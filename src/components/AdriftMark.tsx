/** Adrift logo: a sailboat with a slack sail, idling on still water. Inherits `currentColor`. */
export function AdriftMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="56 70 400 400"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M70 384 Q256 418 442 384" strokeWidth="14" opacity=".5" />
        <path d="M140 420 Q256 440 372 420" strokeWidth="12" opacity=".25" />
      </g>
      <g fill="currentColor" transform="rotate(7 256 350)">
        <path d="M128 322 L384 322 Q368 376 318 378 L194 378 Q146 376 128 322 Z" />
        <rect x="241" y="96" width="16" height="230" rx="8" />
        <path d="M265 114 C300 170 258 214 302 258 C326 282 304 300 330 310 L265 310 Z" />
      </g>
    </svg>
  );
}
