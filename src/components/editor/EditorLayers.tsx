"use client";

import { useEditorStore, type EditorLayer } from "@/store/editorStore";
import {
  Plus,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Trash2,
  Copy,
  GripVertical,
} from "lucide-react";

export function EditorLayers() {
  const layers = useEditorStore((s) => s.layers);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const addLayer = useEditorStore((s) => s.addLayer);
  const removeLayer = useEditorStore((s) => s.removeLayer);
  const updateLayer = useEditorStore((s) => s.updateLayer);
  const duplicateLayer = useEditorStore((s) => s.duplicateLayer);

  const handleAddLayer = () => {
    addLayer({
      name: `Layer ${layers.length + 1}`,
      type: "mask",
    });
  };

  return (
    <div className="w-48 bg-[var(--bg-primary)] border-t border-r border-[var(--border-primary)] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-primary)]">
        <span className="text-sm font-medium text-[var(--text-primary)]">
          Layers
        </span>
        <button
          onClick={handleAddLayer}
          className="btn-ghost flex items-center gap-1 rounded-md px-2 py-1"
          title="Add layer"
        >
          <Plus className="w-4 h-4" />
          <span className="text-xs">Add</span>
        </button>
      </div>

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {layers.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-xs text-[var(--text-muted)]">
              Add your first layer
            </p>
          </div>
        ) : (
          layers.map((layer, index) => (
            <LayerItem
              key={layer.id}
              layer={layer}
              isActive={layer.id === activeLayerId}
              onSelect={() => setActiveLayer(layer.id)}
              onToggleVisibility={() =>
                updateLayer(layer.id, { visible: !layer.visible })
              }
              onToggleLock={() =>
                updateLayer(layer.id, { locked: !layer.locked })
              }
              onDuplicate={() => duplicateLayer(layer.id)}
              onDelete={() => removeLayer(layer.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface LayerItemProps {
  layer: EditorLayer;
  isActive: boolean;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onToggleLock: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function LayerItem({
  layer,
  isActive,
  onSelect,
  onToggleVisibility,
  onToggleLock,
  onDuplicate,
  onDelete,
}: LayerItemProps) {
  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      aria-label={`Select layer ${layer.name}`}
      onKeyDown={(e) => {
        // Only the row itself — Enter/Space on the inner layer buttons
        // bubbles here too and must not also select.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
        isActive
          ? "bg-[var(--bg-active)] ring-1 ring-[var(--accent-primary)]"
          : "hover:bg-[var(--bg-hover)]"
      }`}
    >
      <GripVertical className="w-3 h-3 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 cursor-grab" />

      <div className="w-10 h-10 rounded overflow-hidden bg-[var(--bg-tertiary)] flex-shrink-0">
        {layer.imageUrl ? (
          <img
            src={layer.imageUrl}
            alt={layer.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[8px] text-[var(--text-muted)]">
              {layer.type === "mask" ? "MASK" : "EMPTY"}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p
          className={`text-xs truncate ${
            layer.visible
              ? "text-[var(--text-primary)]"
              : "text-[var(--text-tertiary)]"
          }`}
        >
          {layer.name}
        </p>
      </div>

      {/* Actions (visible on hover) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleVisibility();
          }}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)]"
          title={layer.visible ? "Hide" : "Show"}
        >
          {layer.visible ? (
            <Eye className="w-3 h-3 text-[var(--text-secondary)]" />
          ) : (
            <EyeOff className="w-3 h-3 text-[var(--text-muted)]" />
          )}
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleLock();
          }}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)]"
          title={layer.locked ? "Unlock" : "Lock"}
        >
          {layer.locked ? (
            <Lock className="w-3 h-3 text-[var(--text-secondary)]" />
          ) : (
            <Unlock className="w-3 h-3 text-[var(--text-muted)]" />
          )}
        </button>
      </div>
    </div>
  );
}

export default EditorLayers;
