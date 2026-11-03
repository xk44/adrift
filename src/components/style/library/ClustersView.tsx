"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Grid2X2,
  Loader2,
  Search,
} from "lucide-react";
import { Skeleton, SkeletonImage } from "@/components/Skeleton";
import { STYLE_CODES_ENABLED } from "@/lib/features";
import {
  clusterNodeLabel,
  normalizeStyleSearch,
} from "@/lib/sref/vaultShapes";
import { ServiceOffline } from "./LibraryStatus";
import { StyleMixPanel } from "./StyleMixPanel";
import {
  CLUSTER_MEMBER_PAGE_SIZE,
  svFetch,
  thumbUrl,
  useLatestRequest,
  type PagedCache,
  type SVClusterMember,
  type SVClusterNode,
  type SVStyle,
} from "./shared";

/** Clusters whose name matches, kept with their parents. */
function filterTree(nodes: SVClusterNode[], text: string): SVClusterNode[] {
  const wanted = text.trim().toLowerCase();
  if (!wanted) return nodes;
  return nodes.flatMap((node) => {
    const children = filterTree(node.children ?? [], wanted);
    return clusterNodeLabel(node).toLowerCase().includes(wanted) || children.length > 0
      ? [{ ...node, children }]
      : [];
  });
}

function ClusterTreeItem({
  node,
  depth,
  selectedId,
  onSelect,
  expandAll,
}: {
  node: SVClusterNode;
  depth: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  expandAll: boolean;
}) {
  const [userOpen, setOpen] = useState(depth < 1);
  const open = expandAll || userOpen;
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedId === node.id;

  return (
    <div>
      <button
        onClick={() => {
          onSelect(node.id);
          if (hasChildren) setOpen((o) => !o);
        }}
        className={[
          "flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-[background-color,color] duration-150",
          isSelected
            ? "bg-splash/10 text-splash font-medium"
            : "text-light-600 hover:bg-light-50 dark:text-dark-400 dark:hover:bg-dark-800",
        ].join(" ")}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {hasChildren ? (
          open ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0" />
          )
        ) : (
          <span className="h-3 w-3 flex-shrink-0" />
        )}
        <span className="truncate">{clusterNodeLabel(node)}</span>
        {node.member_count != null && (
          <span className="ml-auto flex-shrink-0 text-[10px] text-light-400 dark:text-dark-500">
            {node.member_count}
          </span>
        )}
      </button>
      {open && hasChildren && (
        <div>
          {node.children.map((child) => (
            <ClusterTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              expandAll={expandAll}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ClustersView() {
  const [tree, setTree] = useState<SVClusterNode[]>([]);
  const [members, setMembers] = useState<SVClusterMember[]>([]);
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  const [loadingTree, setLoadingTree] = useState(true);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingMoreMembers, setLoadingMoreMembers] = useState(false);
  const [hasMoreMembers, setHasMoreMembers] = useState(false);
  const [offline, setOffline] = useState(false);
  const [clusterFilter, setClusterFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SVStyle[] | null>(null);
  const [searching, setSearching] = useState(false);
  const memberCache = useRef<Map<number, PagedCache<SVClusterMember>>>(new Map());
  const searchReq = useLatestRequest();
  // Latest cluster whose members should be on screen: a slow page for a
  // previously selected cluster must not overwrite the current one.
  const activeClusterRef = useRef<number | null>(null);

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    setOffline(false);
    try {
      const data = await svFetch<{ tree: SVClusterNode[] } | SVClusterNode[]>(
        "clusters/tree",
      );
      // API may return {tree: [...]} or directly an array
      const nodes = Array.isArray(data)
        ? data
        : ((data as { tree: SVClusterNode[] }).tree ?? []);
      setTree(nodes);
    } catch {
      setOffline(true);
    } finally {
      setLoadingTree(false);
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const fetchMemberPage = useCallback(
    async (clusterId: number, offset: number) => {
      const data = await svFetch<
        { members: SVClusterMember[] } | SVClusterMember[]
      >(
        `clusters/${clusterId}/members?limit=${CLUSTER_MEMBER_PAGE_SIZE}&offset=${offset}&include_ratings=true`,
      );
      return Array.isArray(data)
        ? data
        : ((data as { members: SVClusterMember[] }).members ?? []);
    },
    [],
  );

  const loadMembers = useCallback(
    async (clusterId: number) => {
      activeClusterRef.current = clusterId;
      const cached = memberCache.current.get(clusterId);
      if (cached) {
        setMembers(cached.items);
        setHasMoreMembers(cached.hasMore);
        // A previous cluster's fetch may still be in flight; its finally
        // no longer owns the spinner once another cluster is active.
        setLoadingMembers(false);
        return;
      }

      setLoadingMembers(true);
      setMembers([]);
      setHasMoreMembers(false);
      try {
        const items = await fetchMemberPage(clusterId, 0);
        const entry = {
          items,
          nextOffset: items.length,
          hasMore: items.length === CLUSTER_MEMBER_PAGE_SIZE,
        };
        memberCache.current.set(clusterId, entry);
        if (activeClusterRef.current !== clusterId) return;
        setMembers(entry.items);
        setHasMoreMembers(entry.hasMore);
      } catch {
        if (activeClusterRef.current !== clusterId) return;
        setMembers([]);
        setHasMoreMembers(false);
      } finally {
        if (activeClusterRef.current === clusterId) setLoadingMembers(false);
      }
    },
    [fetchMemberPage],
  );

  const loadMoreMembers = useCallback(async () => {
    if (selectedCluster == null) return;
    const cached = memberCache.current.get(selectedCluster);
    if (!cached?.hasMore || loadingMoreMembers) return;

    const clusterId = selectedCluster;
    setLoadingMoreMembers(true);
    try {
      const page = await fetchMemberPage(clusterId, cached.nextOffset);
      const seen = new Set(cached.items.map((item) => item.asset_id));
      const newItems = page.filter((item) => !seen.has(item.asset_id));
      const next = {
        items: [...cached.items, ...newItems],
        nextOffset: cached.nextOffset + page.length,
        hasMore:
          page.length === CLUSTER_MEMBER_PAGE_SIZE && newItems.length > 0,
      };
      memberCache.current.set(clusterId, next);
      if (activeClusterRef.current !== clusterId) return;
      setMembers(next.items);
      setHasMoreMembers(next.hasMore);
    } catch {
      // Keep what's shown; the button stays available for a retry.
    } finally {
      setLoadingMoreMembers(false);
    }
  }, [fetchMemberPage, loadingMoreMembers, selectedCluster]);

  const handleClusterSelect = useCallback(
    (id: number) => {
      setSelectedCluster(id);
      searchReq.next(); // drop any in-flight search for the cleared query
      searchReq.cancelDebounce();
      setSearchResults(null);
      setSearchQuery("");
      setSearching(false);
      loadMembers(id);
    },
    [loadMembers, searchReq],
  );

  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    const g = searchReq.next();
    searchReq.cancelDebounce();
    if (!q.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    searchReq.debounce(async () => {
      setSearching(true);
      try {
        const data = await svFetch<unknown>(
          `styles/search?query=${encodeURIComponent(q)}&limit=40`,
        );
        if (searchReq.isCurrent(g)) setSearchResults(normalizeStyleSearch(data));
      } catch {
        if (searchReq.isCurrent(g)) setSearchResults([]);
      } finally {
        if (searchReq.isCurrent(g)) setSearching(false);
      }
    }, 300);
  }, [searchReq]);

  if (loadingTree) {
    return (
      <div className="flex gap-4">
        <Skeleton className="h-96 w-48 flex-shrink-0" rounded="xl" />
        <div className="flex-1 grid grid-cols-4 gap-2">
          {[...Array(12)].map((_, i) => (
            <SkeletonImage key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (offline) return <ServiceOffline onRetry={loadTree} />;

  const shownTree = filterTree(tree, clusterFilter);

  return (
    <div className="flex flex-col gap-4 min-h-0">
      {/* Browser layout — stacked on mobile, side-by-side on md+ */}
      <div className="flex flex-col md:flex-row gap-4 min-h-0">
        {/* Cluster tree sidebar */}
        <div
          className="microScrollbar w-full md:w-52 md:flex-shrink-0 overflow-y-auto rounded-xl border border-light-100 bg-light-input p-2 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
          style={{ maxHeight: "40vh" }}
        >
          <p className="mb-1.5 px-2 text-[11px] font-medium text-light-400 dark:text-dark-500">
            Clusters
          </p>
          {tree.length > 0 && (
            <div className="relative mb-1.5">
              <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-light-400 dark:text-dark-500" />
              <input
                type="text"
                aria-label="Filter clusters by name"
                value={clusterFilter}
                onChange={(e) => setClusterFilter(e.target.value)}
                placeholder="Filter by name"
                className="w-full rounded-lg border border-light-100 bg-light-bg py-1 pl-7 pr-2 text-xs text-light-primary placeholder:text-light-400 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-900 dark:text-dark-primary dark:placeholder:text-dark-500"
              />
            </div>
          )}
          {tree.length === 0 ? (
            <p className="px-2 py-3 text-xs text-light-400 dark:text-dark-500">
              No clusters yet
            </p>
          ) : shownTree.length === 0 ? (
            <p className="px-2 py-3 text-xs text-light-400 dark:text-dark-500">
              No clusters matched
            </p>
          ) : (
            shownTree.map((node) => (
              <ClusterTreeItem
                key={node.id}
                node={node}
                depth={0}
                selectedId={selectedCluster}
                onSelect={handleClusterSelect}
                expandAll={clusterFilter.trim().length > 0}
              />
            ))
          )}
        </div>

        {/* Right panel */}
        <div className="min-w-0 flex-1">
          {/* Saved styles only exist with style codes; no public UI creates them. */}
          {STYLE_CODES_ENABLED && (
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-light-400 dark:text-dark-500" />
            <input
              type="text"
              aria-label="Search styles"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search styles…"
              className="w-full rounded-xl border border-light-100 bg-light-input py-2 pl-8 pr-3 text-sm text-light-primary placeholder:text-light-400 transition-[border-color] duration-150 focus:border-splash/40 focus:outline-none dark:border-dark-750 dark:bg-dark-input dark:text-dark-primary dark:placeholder:text-dark-500"
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-light-400" />
            )}
          </div>
          )}

          {searchResults !== null ? (
            <div>
              <p className="mb-2 text-[11px] font-medium text-light-400 dark:text-dark-500">
                Search results ({searchResults.length})
              </p>
              {searchResults.length === 0 ? (
                <p className="text-xs text-light-400 dark:text-dark-500">
                  No styles matched.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {searchResults.map((style) => (
                    <div
                      key={style.id}
                      className="rounded-xl border border-light-100 bg-light-input p-3 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
                    >
                      <p className="truncate text-xs font-medium text-light-primary dark:text-dark-primary">
                        {style.style_name ?? `Style ${style.id}`}
                      </p>
                      {STYLE_CODES_ENABLED && style.codes && style.codes.length > 0 && (
                        <p className="mt-0.5 font-mono text-[10px] text-light-400 dark:text-dark-500">
                          --sref {style.codes[0]}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : selectedCluster === null ? (
            <div className="flex flex-col items-center justify-center py-20">
              <Grid2X2 className="h-8 w-8 text-light-300 dark:text-dark-500" />
              <p className="mt-3 text-xs text-light-400 dark:text-dark-500">
                Select a cluster to view members
              </p>
            </div>
          ) : loadingMembers ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
              {[...Array(15)].map((_, i) => (
                <SkeletonImage key={i} />
              ))}
            </div>
          ) : members.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <p className="text-xs text-light-400 dark:text-dark-500">
                No members in this cluster
              </p>
            </div>
          ) : (
            <div>
              <p className="mb-2 text-[11px] font-medium text-light-400 dark:text-dark-500">
                {members.length} members
              </p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                {members.map((m) => (
                  <div
                    key={m.asset_id}
                    className="group relative aspect-square overflow-hidden rounded-xl bg-light-50 dark:bg-dark-750"
                    title={m.source_path}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumbUrl(m.asset_id)}
                      alt=""
                      className="h-full w-full object-cover transition-[transform] duration-150 group-hover:scale-[1.03]"
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />
                    {m.score != null && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/50 px-1 py-0.5 text-[10px] font-medium text-white">
                        {m.score.toFixed(1)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {hasMoreMembers && (
                <div className="mt-3 flex justify-center">
                  <button
                    onClick={loadMoreMembers}
                    disabled={loadingMoreMembers}
                    className="flex items-center gap-1.5 rounded-lg bg-light-50 px-3 py-1.5 text-xs font-medium text-light-600 transition-[background-color,transform] duration-150 hover:bg-light-100 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-dark-750 dark:text-dark-400 dark:hover:bg-dark-700"
                  >
                    {loadingMoreMembers && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    Load more
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {STYLE_CODES_ENABLED && <StyleMixPanel />}
    </div>
  );
}

