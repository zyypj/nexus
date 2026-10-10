import type { Id } from "@nexus/protocol";
import { type DragEvent, useEffect, useState } from "react";

/**
 * Drag and drop inside the app (HTML5 DnD): server icons, categories and
 * channels are reordered, people are dragged between voice channels. The
 * dragged item is kept here because `dataTransfer` cannot be read on dragover.
 */
export type DragItem =
  | { type: "server"; id: Id }
  | { type: "category"; id: Id; serverId: Id }
  | { type: "channel"; id: Id; serverId: Id }
  | { type: "member"; userId: Id; serverId: Id; channelId: Id };

/** Above/below the target (reordering) or onto it. */
export type DropPlace = "before" | "after" | "into";

let current: DragItem | null = null;

/** Props that make an element draggable as `item` (nothing when null). */
export function dragProps(item: DragItem | null | false) {
  if (!item) return {};
  return {
    draggable: true,
    onDragStart(e: DragEvent) {
      // A draggable inside another (channel in a category): the inner one wins.
      e.stopPropagation();
      current = item;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-nexus", item.type);
    },
    onDragEnd() {
      current = null;
    },
  };
}

/**
 * Drop target. `accept` says what the dragged item would do here ("reorder" =
 * before/after by the pointer's half of the element, "into", or null to let
 * an outer target have it). Returns the current place, for the indicator
 * class, and the props to spread on the element.
 */
export function useDrop(
  accept: (item: DragItem) => "reorder" | "into" | null,
  onDrop: (item: DragItem, place: DropPlace) => void,
) {
  const [place, setPlace] = useState<DropPlace | null>(null);
  // A drag that ends elsewhere (dropped outside, Esc) does not always leave.
  useEffect(() => {
    if (!place) return;
    const clear = () => setPlace(null);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, [place]);

  const resolve = (e: DragEvent): DropPlace | null => {
    const mode = current && accept(current);
    if (!mode) return null;
    if (mode === "into") return "into";
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  return {
    place,
    props: {
      onDragOver(e: DragEvent) {
        const p = resolve(e);
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setPlace(p);
      },
      onDragLeave(e: DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPlace(null);
      },
      onDrop(e: DragEvent) {
        const p = resolve(e);
        const item = current;
        setPlace(null);
        if (!p || !item) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(item, p);
      },
    },
  };
}

/** Indicator class for a drop target (see "drag & drop" in servers.css). */
export const dropClass = (place: DropPlace | null) => (place ? ` drop-${place}` : "");
