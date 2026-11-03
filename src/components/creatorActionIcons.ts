import {
  Box,
  Brush,
  Clapperboard,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Palette,
  PenTool,
  Play,
  RefreshCw,
  ScanFace,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";

/**
 * lucide icons by the names lib/ui/creatorActions.ts uses, shared by the
 * lightbox, gallery tiles and the Tools panel.
 */
export const CREATOR_ICONS: Readonly<Record<string, LucideIcon>> = {
  Box,
  Brush,
  Clapperboard,
  FileText,
  Film,
  Image: ImageIcon,
  Layers,
  Palette,
  PenTool,
  Play,
  RefreshCw,
  ScanFace,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Wand2,
  ZoomIn,
};

export function creatorIcon(name: string): LucideIcon {
  return CREATOR_ICONS[name] ?? Wand2;
}
