import { STORAGE_KEYS, legacyAwareJSONStorage } from "@/lib/storageKeys";
import { createWithEqualityFn } from "zustand/traditional";
import { persist } from "zustand/middleware";

export interface LikedImage {
  civitaiId: number;
  url: string;
  thumbnailUrl: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  models: Array<{ name: string; type: string }>;
  /** Creator handle, when known (older likes lack it). */
  username?: string;
  likedAt: string;
}

interface LikesState {
  likes: LikedImage[];
}

interface LikesActions {
  toggleLike: (image: LikedImage) => void;
  isLiked: (civitaiId: number) => boolean;
  removeLike: (civitaiId: number) => void;
  getLikedImages: () => LikedImage[];
}

export const useLikesStore = createWithEqualityFn<LikesState & LikesActions>()(
  persist(
    (set, get) => ({
      likes: [],

      toggleLike: (image) =>
        set((state) => {
          const exists = state.likes.some(
            (l) => l.civitaiId === image.civitaiId,
          );
          if (exists) {
            return {
              likes: state.likes.filter((l) => l.civitaiId !== image.civitaiId),
            };
          }
          // Cap at 500 likes to prevent unbounded localStorage growth
          const newLikes = [
            { ...image, likedAt: new Date().toISOString() },
            ...state.likes,
          ];
          if (newLikes.length > 500) {
            newLikes.length = 500;
          }
          return { likes: newLikes };
        }),

      isLiked: (civitaiId) =>
        get().likes.some((l) => l.civitaiId === civitaiId),

      removeLike: (civitaiId) =>
        set((state) => ({
          likes: state.likes.filter((l) => l.civitaiId !== civitaiId),
        })),

      getLikedImages: () =>
        [...get().likes].sort(
          (a, b) =>
            new Date(b.likedAt).getTime() - new Date(a.likedAt).getTime(),
        ),
    }),
    { name: STORAGE_KEYS.likes, storage: legacyAwareJSONStorage() },
  ),
);
