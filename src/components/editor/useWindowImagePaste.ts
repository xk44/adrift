"use client";

import { useEffect, useRef } from "react";
import { firstImageFile } from "./editorStartScreen";

/**
 * While mounted, route any clipboard paste that carries an image file to
 * `onImage`. Text pastes fall through untouched so inputs keep working.
 */
export function useWindowImagePaste(onImage: (file: File) => void) {
  const handlerRef = useRef(onImage);
  handlerRef.current = onImage;

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const file = firstImageFile(event.clipboardData?.files);
      if (!file) return;
      event.preventDefault();
      handlerRef.current(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
}
