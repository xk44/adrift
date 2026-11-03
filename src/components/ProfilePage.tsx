"use client";

import {
  STORAGE_KEYS,
  readLocalStorage,
  removeStorageItem,
  type StorageKey,
} from "@/lib/storageKeys";
import { useState, useCallback, useEffect, useRef } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import { useNavParams, navigateTo } from "@/hooks";
import {
  User,
  Camera,
  Edit3,
  ArrowLeft,
  Heart,
  Archive,
  Users,
  Share2,
  Check,
  ArrowRight,
  Pin,
  PinOff,
  Upload,
} from "lucide-react";
import {
  PROFILE_ARCHIVE_LIMIT,
  PROFILE_SPOTLIGHT_LIMIT,
  profileEmptyState,
  profileGridOverflow,
  profileSpotlight,
  type ProfileEmptyState,
  type ProfileTab,
} from "@/lib/profileView";

// Profile localStorage (shared with AccountSettingsPage)

const PROFILE_KEY = STORAGE_KEYS.profile;

interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
}

const DEFAULT_PROFILE: ProfileData = {
  username: "user",
  displayName: "User",
  bio: "",
};

function loadProfile(): ProfileData {
  if (typeof window === "undefined") return DEFAULT_PROFILE;
  try {
    const raw = readLocalStorage(PROFILE_KEY);
    return raw ? { ...DEFAULT_PROFILE, ...JSON.parse(raw) } : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

// Banner & avatar localStorage

const BANNER_IMAGE_KEY = STORAGE_KEYS.bannerImage;
const AVATAR_IMAGE_KEY = STORAGE_KEYS.avatarImage;

function loadImageUrl(key: StorageKey): string | null {
  if (typeof window === "undefined") return null;
  return readLocalStorage(key);
}

function saveImageUrl(key: StorageKey, dataUrl: string | null) {
  try {
    if (dataUrl) {
      localStorage.setItem(key, dataUrl);
    } else {
      removeStorageItem(localStorage, key);
    }
  } catch {
    /* quota / private browsing */
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Pinned images localStorage

const PINNED_KEY = STORAGE_KEYS.pinnedImages;

function loadPinned(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = readLocalStorage(PINNED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function savePinned(set: Set<string>) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / private browsing */
  }
}

// Following localStorage

const FOLLOWING_KEY = STORAGE_KEYS.following;

type FollowEntry = { handle: string; following: boolean };

const DEFAULT_FOLLOWS: FollowEntry[] = [
  { handle: "@user", following: true },
  { handle: "@community", following: true },
  { handle: "@featured", following: false },
];

function loadFollows(): FollowEntry[] {
  if (typeof window === "undefined") return DEFAULT_FOLLOWS;
  try {
    const raw = readLocalStorage(FOLLOWING_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_FOLLOWS;
  } catch {
    return DEFAULT_FOLLOWS;
  }
}

function saveFollows(follows: FollowEntry[]) {
  try {
    localStorage.setItem(FOLLOWING_KEY, JSON.stringify(follows));
  } catch {
    /* quota / private browsing */
  }
}

// Empty state

function EmptyState({
  icon: Icon,
  state,
  onAction,
}: {
  icon: typeof Heart;
  state: ProfileEmptyState;
  onAction: (target: "archive" | "create") => void;
}) {
  return (
    <div
      className="col-span-full flex flex-col items-center justify-center gap-3 px-4 py-16 text-center sm:py-24"
      data-testid="profile-empty-state"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-light-50 dark:bg-dark-750 sm:h-20 sm:w-20">
        <Icon className="h-8 w-8 text-light-300 dark:text-dark-500 sm:h-10 sm:w-10" />
      </div>
      <p className="text-sm font-medium text-balance text-light-primary dark:text-dark-primary">
        {state.title}
      </p>
      <p className="max-w-xs text-xs text-pretty text-light-400 dark:text-dark-500">
        {state.body}
      </p>
      {state.action && (
        <button
          type="button"
          onClick={() => onAction(state.action!.target)}
          className="mt-1 rounded-xl bg-splash/10 px-4 py-2 text-xs font-medium text-splash transition-[background-color,transform] duration-150 hover:bg-splash/20 active:scale-[0.96]"
        >
          {state.action.label}
        </button>
      )}
    </div>
  );
}

function OverflowHint({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="mt-2 flex items-center justify-center gap-2 text-xs text-light-500 dark:text-dark-400">
      <span>{text}</span>
      <button
        type="button"
        onClick={() => navigateTo("organize")}
        className="flex items-center gap-1 font-medium text-splash hover:underline"
      >
        Open Organize <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}

// Component

export function ProfilePage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const openLightbox = useUIStore((s) => s.openLightbox);
  const { username } = useNavParams();
  const gallery = useGenerationStore((s) => s.gallery);

  const [activeTab, setActiveTab] = useState<ProfileTab>("spotlight");
  const [copiedProfile, setCopiedProfile] = useState(false);

  const [profile, setProfile] = useState<ProfileData>(loadProfile);
  // Pinned images (spotlight) — persisted
  const [pinned, setPinned] = useState<Set<string>>(loadPinned);
  // Following — persisted
  const [follows, setFollows] = useState<FollowEntry[]>(loadFollows);

  // Banner & avatar image uploads
  const [bannerImage, setBannerImage] = useState<string | null>(() =>
    loadImageUrl(BANNER_IMAGE_KEY),
  );
  const [avatarImage, setAvatarImage] = useState<string | null>(() =>
    loadImageUrl(AVATAR_IMAGE_KEY),
  );
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleBannerUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const dataUrl = await readFileAsDataUrl(file);
      setBannerImage(dataUrl);
      saveImageUrl(BANNER_IMAGE_KEY, dataUrl);
    },
    [],
  );

  const handleAvatarUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const dataUrl = await readFileAsDataUrl(file);
      setAvatarImage(dataUrl);
      saveImageUrl(AVATAR_IMAGE_KEY, dataUrl);
    },
    [],
  );

  // Re-read profile when account-settings may have updated it
  useEffect(() => {
    if (activeNav === "profile") {
      setProfile(loadProfile());
      setPinned(loadPinned());
      setFollows(loadFollows());
      setBannerImage(loadImageUrl(BANNER_IMAGE_KEY));
      setAvatarImage(loadImageUrl(AVATAR_IMAGE_KEY));
    }
  }, [activeNav]);

  const isViewingOther = Boolean(username);
  const displayName = isViewingOther
    ? (username ?? "User")
    : profile.displayName;
  const handle = isViewingOther ? `@${username}` : `@${profile.username}`;

  // Spotlight = pinned images (if any), else liked images as fallback
  const { images: spotlightImages, source: spotlightSource } =
    profileSpotlight(gallery, pinned);
  const followingCount = follows.filter((f) => f.following).length;
  const emptyFor = (tab: ProfileTab) =>
    profileEmptyState(tab, {
      isViewingOther,
      handle,
      archiveCount: gallery.length,
    });
  const handleEmptyAction = (target: "archive" | "create") =>
    target === "archive" ? setActiveTab("archive") : navigateTo("create");

  const handleOpenImage = useCallback(
    (images: typeof gallery, index: number) => {
      openLightbox({
        images: images.map((img) => ({
          id: img.id,
          url: img.url,
          prompt: img.prompt,
          fullPrompt: img.fullPrompt ?? "",
          params: img.params ?? [],
          paramsMap: img.paramsMap ?? {},
          seed: img.seed ?? 0,
          createdAt: img.createdAt ?? new Date().toISOString(),
          runId: img.runId ?? "",
          jobIndex: img.jobIndex ?? 0,
          width: img.width ?? 1024,
          height: img.height ?? 1024,
          liked: img.liked ?? false,
        })),
        index,
        origin: "profile",
      });
    },
    [openLightbox],
  );

  const handleCopyProfile = useCallback(() => {
    navigator.clipboard?.writeText(handle);
    setCopiedProfile(true);
    setTimeout(() => setCopiedProfile(false), 1500);
  }, [handle]);

  const handleTogglePin = useCallback((imageId: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(imageId)) {
        next.delete(imageId);
      } else {
        next.add(imageId);
      }
      savePinned(next);
      return next;
    });
  }, []);

  const handleToggleFollow = useCallback((h: string) => {
    setFollows((prev) => {
      const next = prev.map((f) =>
        f.handle === h ? { ...f, following: !f.following } : f,
      );
      saveFollows(next);
      return next;
    });
  }, []);

  // After every hook, so the hook order never changes between renders.
  if (activeNav !== "profile") return null;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className={`group/banner relative h-32 flex-shrink-0 overflow-hidden bg-light-100 dark:bg-dark-850 sm:h-[200px] ${
          isViewingOther ? "" : "cursor-pointer"
        }`}
        onClick={() => !isViewingOther && bannerInputRef.current?.click()}
        {...(isViewingOther
          ? {}
          : {
              role: "button",
              tabIndex: 0,
              "aria-label": bannerImage ? "Change banner" : "Upload banner",
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  bannerInputRef.current?.click();
                }
              },
            })}
      >
        {bannerImage && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={bannerImage}
            alt="Profile banner"
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {!isViewingOther && (
          <>
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void handleBannerUpload(e)}
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/banner:bg-black/30 transition-[background-color] duration-200">
              <span className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 text-xs text-white backdrop-blur-sm opacity-0 group-hover/banner:opacity-100 group-focus-visible/banner:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-200">
                <Upload className="h-3 w-3" />
                {bannerImage ? "Change Banner" : "Upload Banner"}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="relative px-4 pb-4 flex-shrink-0 sm:px-6">
        {isViewingOther && (
          <button
            onClick={() => navigateTo("profile")}
            className="mb-2 flex items-center gap-1 text-xs text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary transition-colors duration-150"
          >
            <ArrowLeft className="h-3 w-3" /> Back to my profile
          </button>
        )}

        <div className="-mt-10 flex flex-wrap items-end gap-x-4 gap-y-3 sm:-mt-12 sm:flex-nowrap">
          <div
            className={`group/avatar relative flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-full border-4 border-light-bg bg-light-50 text-3xl font-medium dark:border-dark-bg dark:bg-dark-750 overflow-hidden sm:h-24 sm:w-24 ${
              isViewingOther ? "" : "cursor-pointer"
            }`}
            onClick={() => !isViewingOther && avatarInputRef.current?.click()}
            {...(isViewingOther
              ? {}
              : {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": avatarImage ? "Change avatar" : "Upload avatar",
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      avatarInputRef.current?.click();
                    }
                  },
                })}
          >
            {avatarImage ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={avatarImage}
                alt="Avatar"
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <User className="h-10 w-10 text-light-600 dark:text-dark-300" />
            )}
            {!isViewingOther && (
              <>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => void handleAvatarUpload(e)}
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/avatar:bg-black/40 transition-[background-color] duration-200 rounded-full">
                  <Camera className="h-5 w-5 text-white opacity-0 group-hover/avatar:opacity-100 transition-opacity duration-200" />
                </div>
              </>
            )}
          </div>

          <div className="pb-1 min-w-0 flex-1 basis-40">
            <h1 className="text-lg font-semibold text-balance text-light-primary dark:text-dark-primary truncate">
              {displayName}
            </h1>
            <p className="text-xs text-light-500 dark:text-dark-400 font-mono truncate">
              {handle}
            </p>
            {!isViewingOther && profile.bio && (
              <p className="mt-0.5 text-xs text-light-500 dark:text-dark-400 italic line-clamp-2 max-w-md">
                {profile.bio}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-light-500 dark:text-dark-400 tabular-nums">
              <span>
                <strong className="text-light-primary dark:text-dark-primary font-semibold">
                  {spotlightImages.length}
                </strong>{" "}
                spotlight
              </span>
              <span>
                <strong className="text-light-primary dark:text-dark-primary font-semibold">
                  {gallery.length}
                </strong>{" "}
                archived
              </span>
              <span>
                <strong className="text-light-primary dark:text-dark-primary font-semibold">
                  {followingCount}
                </strong>{" "}
                following
              </span>
            </div>
          </div>

          <div className="flex w-full items-center gap-2 pb-1 flex-shrink-0 sm:w-auto">
            {!isViewingOther && (
              <button
                type="button"
                onClick={() => navigateTo("account-settings")}
                className="flex items-center gap-1.5 rounded-full border border-light-100 bg-light-input px-3 py-1.5 text-xs font-medium text-light-600 transition-[color,background-color,border-color,transform] duration-150 hover:bg-light-50 active:scale-[0.96] dark:border-dark-750 dark:bg-dark-input dark:text-dark-300 dark:hover:bg-dark-750"
              >
                <Edit3 className="h-3 w-3" /> Edit
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyProfile}
              className="flex items-center gap-1.5 rounded-full border border-light-100 bg-light-input px-3 py-1.5 text-xs font-medium text-light-600 transition-[color,background-color,border-color,transform] duration-150 hover:bg-light-50 active:scale-[0.96] dark:border-dark-750 dark:bg-dark-input dark:text-dark-300 dark:hover:bg-dark-750"
              title="Share profile"
            >
              {copiedProfile ? (
                <Check className="h-3 w-3" />
              ) : (
                <Share2 className="h-3 w-3" />
              )}
              {copiedProfile ? "Copied!" : "Share"}
            </button>
          </div>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Profile sections"
        className="flex-shrink-0 flex gap-1 overflow-x-auto px-4 border-b border-light-100 dark:border-dark-700 sm:px-6"
      >
        {(
          [
            { key: "spotlight" as const, label: "Spotlight", icon: Heart },
            { key: "archive" as const, label: "Archive", icon: Archive },
            { key: "following" as const, label: "Following", icon: Users },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            onClick={() => setActiveTab(key)}
            className={`-mb-px flex flex-shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-[color,border-color] duration-150 ${
              activeTab === key
                ? "border-splash text-splash"
                : "border-transparent text-light-500 hover:text-light-primary dark:text-dark-400 dark:hover:text-dark-primary"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {(() => {
              const n =
                key === "spotlight"
                  ? spotlightImages.length
                  : key === "archive"
                    ? gallery.length
                    : followingCount;
              return n > 0 ? (
                <span className="rounded-full bg-light-100 dark:bg-dark-700 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-light-500 dark:text-dark-400">
                  {n}
                </span>
              ) : null;
            })()}
          </button>
        ))}
      </div>

      <div className="microScrollbar flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Spotlight tab */}
        {activeTab === "spotlight" &&
          (spotlightImages.length > 0 ? (
            <>
              {spotlightSource === "liked" && !isViewingOther && (
                <p className="mb-3 text-xs text-light-500 dark:text-dark-400">
                  Showing your liked images. Pin images to choose your
                  spotlight.
                </p>
              )}
              <div className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-3">
                {spotlightImages.slice(0, PROFILE_SPOTLIGHT_LIMIT).map((img, i) => (
                  <div
                    key={img.id}
                    className="group relative break-inside-avoid mb-3"
                  >
                    <button
                      onClick={() => handleOpenImage(spotlightImages, i)}
                      className="w-full rounded-xl overflow-hidden bg-light-100 dark:bg-dark-750 ring-0 hover:ring-2 hover:ring-splash/50 transition-[box-shadow] duration-150 block"
                      style={{
                        aspectRatio:
                          img.width && img.height
                            ? `${img.width} / ${img.height}`
                            : undefined,
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={img.prompt?.slice(0, 60) || "Spotlight image"}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                    {/* Hover overlay with prompt */}
                    <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-black/60 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                      <p className="absolute bottom-2 left-2.5 right-2.5 text-[11px] text-white/90 line-clamp-2 leading-tight">
                        {img.prompt}
                      </p>
                    </div>
                    {!isViewingOther && (
                      <button
                        onClick={() => handleTogglePin(img.id)}
                        className="absolute top-1.5 right-1.5 flex items-center justify-center h-6 w-6 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-150 hover:bg-black/70"
                        title={
                          pinned.has(img.id)
                            ? "Unpin from spotlight"
                            : "Pin to spotlight"
                        }
                        aria-label={
                          pinned.has(img.id)
                            ? "Unpin from spotlight"
                            : "Pin to spotlight"
                        }
                      >
                        {pinned.has(img.id) ? (
                          <PinOff className="h-3 w-3" />
                        ) : (
                          <Pin className="h-3 w-3" />
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <OverflowHint
                text={profileGridOverflow(
                  spotlightImages.length,
                  PROFILE_SPOTLIGHT_LIMIT,
                )}
              />
            </>
          ) : (
            <EmptyState
              icon={Heart}
              state={emptyFor("spotlight")}
              onAction={handleEmptyAction}
            />
          ))}

        {/* Archive tab */}
        {activeTab === "archive" &&
          (gallery.length > 0 ? (
            <>
              <div className="columns-2 md:columns-3 lg:columns-4 xl:columns-5 gap-3">
                {gallery.slice(0, PROFILE_ARCHIVE_LIMIT).map((img, i) => (
                  <div
                    key={img.id}
                    className="group relative break-inside-avoid mb-3"
                  >
                    <button
                      onClick={() => handleOpenImage(gallery, i)}
                      className="w-full rounded-xl overflow-hidden bg-light-100 dark:bg-dark-750 ring-0 hover:ring-2 hover:ring-splash/50 transition-[box-shadow] duration-150 block"
                      style={{
                        aspectRatio:
                          img.width && img.height
                            ? `${img.width} / ${img.height}`
                            : undefined,
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={img.prompt?.slice(0, 60) || "Gallery image"}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                    {/* Hover overlay with prompt */}
                    <div className="absolute inset-0 rounded-xl bg-gradient-to-t from-black/60 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                      <p className="absolute bottom-2 left-2.5 right-2.5 text-[11px] text-white/90 line-clamp-2 leading-tight">
                        {img.prompt}
                      </p>
                    </div>
                    {/* Pin/unpin overlay — own profile only */}
                    {!isViewingOther && (
                      <button
                        onClick={() => handleTogglePin(img.id)}
                        className={`absolute top-1.5 right-1.5 flex items-center justify-center h-6 w-6 rounded-full transition-opacity duration-150 hover:bg-black/70 ${
                          pinned.has(img.id)
                            ? "bg-splash/80 text-white opacity-100"
                            : "bg-black/50 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                        }`}
                        title={
                          pinned.has(img.id)
                            ? "Pinned to spotlight — click to unpin"
                            : "Pin to spotlight"
                        }
                        aria-label={
                          pinned.has(img.id)
                            ? "Unpin from spotlight"
                            : "Pin to spotlight"
                        }
                      >
                        {pinned.has(img.id) ? (
                          <PinOff className="h-3 w-3" />
                        ) : (
                          <Pin className="h-3 w-3" />
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <OverflowHint
                text={profileGridOverflow(gallery.length, PROFILE_ARCHIVE_LIMIT)}
              />
            </>
          ) : (
            <EmptyState
              icon={Archive}
              state={emptyFor("archive")}
              onAction={handleEmptyAction}
            />
          ))}

        {/* Following tab */}
        {activeTab === "following" && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {followingCount === 0 && (
              <EmptyState
                icon={Users}
                state={emptyFor("following")}
                onAction={handleEmptyAction}
              />
            )}
            {follows.map((entry) => (
              <div
                key={entry.handle}
                className="rounded-2xl border border-light-100 bg-light-input p-4 transition-[border-color,background-color] duration-150 hover:border-splash/30 dark:border-dark-750 dark:bg-dark-input"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-light-50 text-sm font-medium text-light-primary dark:bg-dark-750 dark:text-dark-primary">
                    {entry.handle[1]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-light-primary dark:text-dark-primary">
                      {entry.handle}
                    </p>
                    <p className="text-xs text-light-400 dark:text-dark-500">
                      {entry.following ? "Following" : "Not following"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    type="button"
                    aria-pressed={entry.following}
                    onClick={() => handleToggleFollow(entry.handle)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.96] ${
                      entry.following
                        ? "bg-light-100 dark:bg-dark-700 text-light-primary dark:text-dark-primary hover:bg-light-200 dark:hover:bg-dark-600"
                        : "bg-splash text-white hover:opacity-90"
                    }`}
                  >
                    {entry.following ? "Following" : "Follow"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigateTo("profile", {
                        username: entry.handle.slice(1),
                      })
                    }
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border border-light-200 dark:border-dark-600 text-xs font-medium text-light-500 dark:text-dark-400 hover:bg-light-50 dark:hover:bg-dark-750 transition-[color,background-color] duration-150"
                  >
                    View <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ProfilePage;
