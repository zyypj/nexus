import type { Id } from "@nexus/protocol";

/** Where something was dropped relative to the item under the pointer. */
export type DropSide = "before" | "after";

/** `ids` with `id` moved next to `anchor` (unchanged when either is unknown). */
export function reorder<T>(ids: T[], id: T, anchor: T, side: DropSide): T[] {
  if (id === anchor || !ids.includes(id)) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(anchor);
  if (at < 0) return ids;
  rest.splice(side === "before" ? at : at + 1, 0, id);
  return rest;
}

/** Items in the user's own order; ones not placed yet stay at the end, as they came. */
export function orderBy<T extends { id: Id }>(items: T[], order: Id[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, key: rank.get(item.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.item);
}

interface LayoutChannel {
  id: Id;
  kind: string;
  category_id?: Id | null;
  position?: number;
}

export interface ChannelPlacement {
  id: Id;
  category_id: Id | null;
  position: number;
}

/**
 * Layout entries (for `PUT /servers/{id}/layout`) after moving a channel into
 * `categoryId`: next to `anchor` when given, else at the end. The sidebar
 * lists text channels before voice ones, so a channel only takes a place
 * among those of its own kind; dropped on the other kind it goes to the
 * nearest end of its own.
 */
export function moveChannel(
  channels: LayoutChannel[],
  id: Id,
  categoryId: Id | null,
  anchor?: { id: Id; side: DropSide },
): ChannelPlacement[] {
  const moved = channels.find((c) => c.id === id);
  if (!moved) return [];
  const peers = channels
    .filter((c) => c.id !== id && c.kind === moved.kind && (c.category_id ?? null) === categoryId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => c.id);
  const target = anchor && channels.find((c) => c.id === anchor.id);
  let at = peers.length;
  if (target && target.kind === moved.kind) {
    const i = peers.indexOf(target.id);
    if (i >= 0) at = anchor.side === "before" ? i : i + 1;
  } else if (target && moved.kind === "voice") at = 0;
  peers.splice(at, 0, id);
  return peers.map((channel, position) => ({ id: channel, category_id: categoryId, position }));
}
