export interface GalleryFilterableImage {
  prompt: string;
  liked?: boolean;
  hidden?: boolean;
}

export interface GalleryFilterOptions {
  query?: string;
  likedOnly?: boolean;
  excludeHidden?: boolean;
}

export function normalizeGalleryFilterQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function matchesGalleryPromptQuery(
  image: Pick<GalleryFilterableImage, "prompt">,
  query: string,
): boolean {
  const normalizedQuery = normalizeGalleryFilterQuery(query);
  if (!normalizedQuery) return true;
  return image.prompt.toLowerCase().includes(normalizedQuery);
}

export function isLikedGalleryImage(
  image: Pick<GalleryFilterableImage, "liked">,
): boolean {
  return image.liked === true;
}

export function isVisibleGalleryImage(
  image: Pick<GalleryFilterableImage, "hidden">,
): boolean {
  return image.hidden !== true;
}

export function createGalleryImageFilter<T extends GalleryFilterableImage>({
  query = "",
  likedOnly = false,
  excludeHidden = false,
}: GalleryFilterOptions = {}): (image: T) => boolean {
  return (image) => {
    if (!matchesGalleryPromptQuery(image, query)) return false;
    if (likedOnly && !isLikedGalleryImage(image)) return false;
    if (excludeHidden && !isVisibleGalleryImage(image)) return false;
    return true;
  };
}

export function filterGalleryImages<T extends GalleryFilterableImage>(
  images: readonly T[],
  options: GalleryFilterOptions = {},
): T[] {
  return images.filter(createGalleryImageFilter<T>(options));
}
