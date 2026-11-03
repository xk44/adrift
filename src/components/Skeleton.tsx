"use client";

interface SkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "xl" | "full";
}

export function Skeleton({ className = "", rounded = "lg" }: SkeletonProps) {
  return (
    <div
      data-skeleton="true"
      className={`animate-pulse bg-light-50 dark:bg-dark-750 rounded-${rounded} ${className}`}
    />
  );
}

export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={`h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`}
          rounded="md"
        />
      ))}
    </div>
  );
}

export function SkeletonGrid({
  count = 8,
  className = "",
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={`grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 ${className}`}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl overflow-hidden space-y-2">
          <Skeleton className="aspect-square w-full" rounded="xl" />
          <Skeleton className="h-3 w-3/4" rounded="md" />
          <Skeleton className="h-3 w-1/2" rounded="md" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-light-100 dark:border-dark-750 bg-light-input dark:bg-dark-input p-4">
      <Skeleton className="mb-3 h-4 w-3/4" />
      <Skeleton className="mb-2 h-3 w-full" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export function SkeletonImage({ className = "" }: { className?: string }) {
  return (
    <Skeleton className={`aspect-square w-full ${className}`} rounded="xl" />
  );
}

export default Skeleton;
