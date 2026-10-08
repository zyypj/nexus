import { type ConversationView, type Id, Permissions, type ServerView, hasPermission } from "@nexus/protocol";
import { conversationTitle, memberTop, serverMember } from "@nexus/shared";
import { calls, useCall } from "../call/callStore";
import type { MenuEntry } from "../components/ContextMenu";
import { openDialog, openProfile } from "../lib/dialogs";
import { client } from "../lib/nexus";
import { colorHex, useUi } from "../lib/ui";
import { openServer } from "./ServerRail";

/** Right-click menu builders. Each runs against the current state. */

const has = (server: ServerView, p: number) => hasPermission(server.permissions, p);

function fail(e: unknown) {
  alert((e as Error).message || "Não foi possível concluir a ação.");
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

/** Opens (or creates) the DM with a user and shows it under Início. */
export async function openDmWith(userId: Id) {
  try {
    const c = await client().api.openDm(userId);
    openServer(null);
    await client().openConversation(c.id);
  } catch (e) {
    fail(e);
  }
}

/** Acks several conversations at once (client.markRead is debounced per call). */
function markRead(ids: Id[]) {
  const c = client();
  const s = c.store.getState();
  const conversations = { ...s.conversations };
  let changed = false;
  for (const id of ids) {
    const conv = conversations[id];
    if (!conv?.last_message_id || conv.unread_count === 0) continue;
    conversations[id] = { ...conv, unread_count: 0, last_read_message_id: conv.last_message_id };
    void c.api.ack(id, conv.last_message_id).catch(() => undefined);
    changed = true;
  }
  if (changed) c.store.setState({ conversations });
}

function toggleRole(serverId: Id, userId: Id, roleId: Id) {
  const server = client().store.getState().servers[serverId];
  const member = server && serverMember(server, userId);
  if (!member) return;
  const role_ids = member.role_ids.includes(roleId)
    ? member.role_ids.filter((r) => r !== roleId)
    : [...member.role_ids, roleId];
  void client().api.updateServerMember(serverId, userId, { role_ids }).catch(fail);
}

/**
 * A person (message author, member list, voice channel, DM, friend):
 * profile, message, friendship, server nickname/roles/moderation, block.
 */
export function userMenu(userId: Id, at: { x: number; y: number }, serverId: Id | null = null): MenuEntry[] {
  const c = client();
  const s = c.store.getState();
  const api = c.api;
  const me = s.me?.id ?? "";
  const user = s.users[userId];
  if (!user) return [];
  const isMe = userId === me;
  const blocked = !!s.blocked[userId];
  const incoming = s.incoming.find((r) => r.from.id === userId);
  const outgoing = s.outgoing.find((r) => r.to.id === userId);
  const server = serverId ? s.servers[serverId] : undefined;
  const member = server ? serverMember(server, userId) : undefined;
  const name = member?.nickname || user.display_name;

  const entries: MenuEntry[] = [
    { label: "Ver perfil", icon: "user", run: () => openProfile({ userId, serverId, x: at.x, y: at.y }) },
    !isMe && { label: "Mandar mensagem", icon: "message", run: () => void openDmWith(userId) },
    { separator: true },
  ];

  if (!isMe && !blocked) {
    if (s.friends[userId])
      entries.push({
        label: "Remover amigo",
        icon: "userMinus",
        danger: true,
        run: () => confirm(`Remover ${user.display_name} dos amigos?`) && void api.removeFriend(userId).catch(fail),
      });
    else if (incoming)
      entries.push({ label: "Aceitar pedido de amizade", icon: "userPlus", run: () => void api.acceptFriendRequest(incoming.id).catch(fail) });
    else if (outgoing)
      entries.push({ label: "Cancelar pedido de amizade", icon: "x", run: () => void api.deleteFriendRequest(outgoing.id).catch(fail) });
    else
      entries.push({ label: "Adicionar amigo", icon: "userPlus", run: () => void api.sendFriendRequest(user.username).catch(fail) });
  }

  if (server && member) {
    const isOwner = server.owner_id === me;
    const myTop = memberTop(server, me);
    // Same hierarchy as the server: act only on members below your top role.
    const outranks = !isMe && server.owner_id !== userId && myTop > memberTop(server, userId);
    entries.push({ separator: true });
    if ((isMe && has(server, Permissions.CHANGE_NICKNAME)) || (outranks && has(server, Permissions.MANAGE_NICKNAMES)))
      entries.push({
        label: "Mudar apelido",
        icon: "edit",
        run: () => openDialog({ kind: "nickname", serverId: server.id, userId }),
      });
    if (has(server, Permissions.MANAGE_ROLES) && (isMe || outranks)) {
      const roles = server.roles
        .filter((r) => r.id !== server.id && (isOwner || r.position < myTop))
        .sort((a, b) => b.position - a.position);
      entries.push({
        label: "Cargos",
        icon: "tag",
        submenu: roles.length
          ? roles.map((r) => ({
              label: r.name,
              checked: member.role_ids.includes(r.id),
              color: r.color ? colorHex(r.color) : undefined,
              run: () => toggleRole(server.id, userId, r.id),
            }))
          : [{ label: "Nenhum cargo abaixo do seu", disabled: true }],
      });
    }
    if (outranks && has(server, Permissions.KICK_MEMBERS))
      entries.push({
        label: `Expulsar ${name}`,
        icon: "doorOut",
        danger: true,
        run: () => confirm(`Expulsar ${name} de ${server.name}?`) && void api.kickMember(server.id, userId).catch(fail),
      });
    if (outranks && has(server, Permissions.BAN_MEMBERS))
      entries.push({
        label: `Banir ${name}`,
        icon: "ban",
        danger: true,
        run: () =>
          confirm(`Banir ${name} de ${server.name}? A pessoa não volta nem com convite.`) &&
          void api.banMember(server.id, userId).catch(fail),
      });
  }

  if (!isMe) {
    entries.push(
      { separator: true },
      blocked
        ? { label: "Desbloquear", icon: "shield", run: () => void api.unblock(userId).catch(fail) }
        : {
            label: "Bloquear",
            icon: "ban",
            danger: true,
            run: () => confirm(`Bloquear ${user.display_name}?`) && void api.block(userId).catch(fail),
          },
    );
  }
  entries.push({ separator: true }, { label: "Copiar nome de usuário", icon: "copy", run: () => copy(user.username) });
  return entries;
}

/** Server icon in the rail. */
export function serverMenu(serverId: Id): MenuEntry[] {
  const s = client().store.getState();
  const server = s.servers[serverId];
  if (!server) return [];
  const me = s.me?.id;
  const channels = Object.values(s.conversations).filter((c) => c.server_id === serverId);
  const unread = channels.filter((c) => c.unread_count > 0).map((c) => c.id);
  const canChannels = has(server, Permissions.MANAGE_CHANNELS);
  return [
    unread.length > 0 && { label: "Marcar como lido", icon: "checkCircle", run: () => markRead(unread) },
    { separator: true },
    has(server, Permissions.CREATE_INVITE) && {
      label: "Convidar pessoas",
      icon: "link",
      run: () => openDialog({ kind: "invite", serverId }),
    },
    (has(server, Permissions.MANAGE_SERVER) ||
      has(server, Permissions.MANAGE_ROLES) ||
      has(server, Permissions.KICK_MEMBERS) ||
      has(server, Permissions.BAN_MEMBERS)) && {
      label: "Configurações do servidor",
      icon: "settings",
      run: () => openDialog({ kind: "settings", serverId }),
    },
    canChannels && {
      label: "Criar canal",
      icon: "plus",
      run: () => openDialog({ kind: "channel", serverId, categoryId: null, type: "text" }),
    },
    canChannels && { label: "Criar categoria", icon: "plus", run: () => openDialog({ kind: "category", serverId }) },
    has(server, Permissions.CHANGE_NICKNAME) &&
      !!me && { label: "Mudar meu apelido", icon: "edit", run: () => openDialog({ kind: "nickname", serverId, userId: me }) },
    { separator: true },
    server.owner_id !== me && {
      label: "Sair do servidor",
      icon: "doorOut",
      danger: true,
      run: () => openDialog({ kind: "leave", serverId }),
    },
  ];
}

/** A text or voice channel in the server sidebar. */
export function channelMenu(channel: ConversationView): MenuEntry[] {
  const s = client().store.getState();
  const server = channel.server_id ? s.servers[channel.server_id] : undefined;
  if (!server) return [];
  const serverId = server.id;
  const canManage = has(server, Permissions.MANAGE_CHANNELS);
  const here = useCall.getState().conversationId === channel.id;
  const voice = channel.kind === "voice";
  return [
    channel.unread_count > 0 && { label: "Marcar como lido", icon: "checkCircle", run: () => markRead([channel.id]) },
    voice &&
      !here &&
      hasPermission(channel.permissions, Permissions.CONNECT) && {
        label: "Entrar no canal",
        icon: "volume",
        run: () => {
          void client().openConversation(channel.id);
          void calls.start(channel.id);
        },
      },
    voice && here && { label: "Sair do canal", icon: "phoneOff", danger: true, run: () => void calls.leave() },
    { separator: true },
    has(server, Permissions.CREATE_INVITE) && {
      label: "Convidar pessoas",
      icon: "link",
      run: () => openDialog({ kind: "invite", serverId }),
    },
    canManage && {
      label: "Editar canal",
      icon: "settings",
      run: () => openDialog({ kind: "channelSettings", serverId, channelId: channel.id }),
    },
    { separator: true },
    { label: "Copiar nome do canal", icon: "copy", run: () => copy(channel.name ?? "") },
    canManage && { separator: true },
    canManage && {
      label: "Apagar canal",
      icon: "trash",
      danger: true,
      run: () =>
        confirm(`Apagar ${voice ? "" : "#"}${channel.name}? As mensagens e arquivos dele somem para sempre.`) &&
        void client().api.deleteChannel(serverId, channel.id).catch(fail),
    },
  ];
}

/** A category header in the server sidebar. */
export function categoryMenu(serverId: Id, categoryId: Id): MenuEntry[] {
  const s = client().store.getState();
  const server = s.servers[serverId];
  const category = server?.categories.find((c) => c.id === categoryId);
  if (!server || !category) return [];
  const canManage = has(server, Permissions.MANAGE_CHANNELS);
  const collapsed = !!useUi.getState().collapsed[categoryId];
  const unread = Object.values(s.conversations)
    .filter((c) => c.category_id === categoryId && c.unread_count > 0)
    .map((c) => c.id);
  return [
    unread.length > 0 && { label: "Marcar como lido", icon: "checkCircle", run: () => markRead(unread) },
    {
      label: collapsed ? "Expandir categoria" : "Recolher categoria",
      icon: collapsed ? "chevronRight" : "chevronDown",
      run: () => useUi.getState().set({ collapsed: { ...useUi.getState().collapsed, [categoryId]: !collapsed } }),
    },
    canManage && { separator: true },
    canManage && {
      label: "Criar canal de texto",
      icon: "hash",
      run: () => openDialog({ kind: "channel", serverId, categoryId, type: "text" }),
    },
    canManage && {
      label: "Criar canal de voz",
      icon: "volume",
      run: () => openDialog({ kind: "channel", serverId, categoryId, type: "voice" }),
    },
    canManage && {
      label: "Editar categoria",
      icon: "settings",
      run: () => openDialog({ kind: "channelSettings", serverId, channelId: categoryId }),
    },
    canManage && { separator: true },
    canManage && {
      label: "Apagar categoria",
      icon: "trash",
      danger: true,
      run: () =>
        confirm(`Apagar a categoria ${category.name}? Os canais dela ficam sem categoria.`) &&
        void client().api.deleteCategory(serverId, categoryId).catch(fail),
    },
  ];
}

/** A DM or group in the Início list. */
export function conversationMenu(conv: ConversationView, at: { x: number; y: number }): MenuEntry[] {
  const s = client().store.getState();
  const me = s.me?.id;
  const read: MenuEntry = conv.unread_count > 0 && {
    label: "Marcar como lido",
    icon: "checkCircle",
    run: () => markRead([conv.id]),
  };
  if (conv.kind === "dm") {
    const peer = conv.members.find((u) => u.id !== me)?.id;
    return [read, { separator: true }, ...(peer ? userMenu(peer, at) : [])];
  }
  return [
    read,
    { separator: true },
    { label: "Copiar nome do grupo", icon: "copy", run: () => copy(conversationTitle(s, conv)) },
    { separator: true },
    !!me && {
      label: "Sair do grupo",
      icon: "doorOut",
      danger: true,
      run: () =>
        confirm(`Sair de ${conversationTitle(s, conv)}?`) && void client().api.removeMember(conv.id, me).catch(fail),
    },
  ];
}
