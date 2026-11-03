import type { ReactNode } from "react";

/**
 * A model license, linked to its text (new tab) when a verified link is
 * known; plain text otherwise. `children` replaces the visible label (a
 * badge, say); the title still names the license.
 */
export function LicenseLink({
  name,
  url,
  className = "text-splash underline-offset-2 hover:underline",
  children,
}: {
  name: string;
  url: string | null | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const label = children ?? name;
  if (!url || !url.startsWith("https://"))
    return <span title={name}>{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Read the ${name} license (opens in a new tab)`}
      data-testid="license-link"
      className={`rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-splash ${className}`}
    >
      {label}
      <span className="sr-only"> (license, opens in a new tab)</span>
    </a>
  );
}
