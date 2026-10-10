import type { ConversationView, Id } from "@nexus/protocol";
import { calls, useCall } from "../call/callStore";
import { type DropSide, moveChannel, orderBy, reorder } from "../lib/layout";
import { client } from "../lib/nexus";
import { useUi } from "../lib/ui";

/**
 * Organizing by drag and drop (or the "Mover para" menus): the change shows
 * at once and is undone if the server refuses it.
 */

export function fail(e: unknown) {
  alert((e as Error).message || "Não foi possível concluir a ação.");
}

/** Puts a category before/after another one. */
export function moveCategory(serverId: Id, categoryId: Id, anchorId: Id, side: DropSide) {
  const c = client();
  const server = c.store.getState().servers[serverId];
  if (!server) return;
  const before = server.categories;
  const ids = [...before].sort((a, b) => a.position - b.position).map((x) => x.id);
  const next = reorder(ids, categoryId, anchorId, side);
  if (next === ids) return;
  const position = new Map(next.map((id, i) => [id, i]));
  const apply = (categories: typeof before) =>
    c.store.setState((s) => {
      const sv = s.servers[serverId];
      return sv ? { servers: { ...s.servers, [serverId]: { ...sv, categories } } } : {};
    });
  apply(before.map((x) => ({ ...x, position: position.get(x.id) ?? x.position })));
  c.api.setServerLayout(serverId, { categories: next.map((id, i) => ({ id, position: i })) }).catch((e) => {
    apply(before);
    fail(e);
  });
}

/** Moves a channel into a category (null = none), next to `anchor` or at its end. */
export function placeChannel(serverId: Id, channelId: Id, categoryId: Id | null, anchor?: { id: Id; side: DropSide }) {
  const c = client();
  const all = c.store.getState().conversations;
  const channels = Object.values(all).filter((x) => x.server_id === serverId);
  const placements = moveChannel(channels, channelId, categoryId, anchor);
  // Nothing to do when every channel already is where it would go.
  if (placements.every((p) => (all[p.id]?.category_id ?? null) === p.category_id && all[p.id]?.position === p.position)) return;
  const apply = (entries: { id: Id; category_id: Id | null; position?: number }[]) =>
    c.store.setState((s) => {
      const conversations: Record<Id, ConversationView> = { ...s.conversations };
      for (const p of entries) {
        const conv = conversations[p.id];
        if (conv) conversations[p.id] = { ...conv, category_id: p.category_id, position: p.position };
      }
      return { conversations };
    });
  const before = placements.map((p) => ({ id: p.id, category_id: all[p.id]?.category_id ?? null, position: all[p.id]?.position }));
  apply(placements);
  c.api.setServerLayout(serverId, { channels: placements }).catch((e) => {
    apply(before);
    fail(e);
  });
}

/** Puts a server icon before/after another one (the order is kept on this device). */
export function moveServer(serverId: Id, anchorId: Id, side: DropSide) {
  const ui = useUi.getState();
  const ids = orderBy(Object.values(client().store.getState().servers), ui.serverOrder).map((s) => s.id);
  ui.set({ serverOrder: reorder(ids, serverId, anchorId, side) });
}

/**
 * Takes someone who is in a voice channel to another one. Yourself: just
 * join it. Someone else (Move Members): the server tells their app to switch.
 */
export function moveVoiceMember(serverId: Id, userId: Id, channelId: Id) {
  const c = client();
  if (userId !== c.store.getState().me?.id) {
    void c.api.moveVoiceMember(serverId, userId, channelId).catch(fail);
    return;
  }
  // Keep looking at the call when it was the open conversation.
  if (c.state.activeConversationId === useCall.getState().conversationId) void c.openConversation(channelId);
  void calls.start(channelId).catch(fail);
}
