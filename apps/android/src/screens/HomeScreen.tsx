import type { ConversationView, Presence, ServerView } from '@nexus/protocol';
import {
  callForConversation,
  conversationTitle,
  dmPeer,
  serverHasUnread,
  sortedConversations,
  totalUnread,
} from '@nexus/shared';
import React, { memo, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import type { Nav } from '../App';
import { calls, useCall } from '../call/callManager';
import { setHomeUi, useHomeUi } from '../lib/homeUi';
import { useNexus } from '../lib/nexus';
import { installUpdate, useUpdate } from '../lib/updater';
import { Avatar, Badge, Gradient, Icon, IconButton, ServerIcon } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';
import { CreateGroup } from './FriendsScreen';
import { AddServer, ServerPanel } from './ServerScreen';

const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Ausente',
  dnd: 'Não perturbe',
  invisible: 'Invisível',
};

/**
 * Same layout as the desktop: server rail on the left, a floating panel with
 * the DMs (Início) or the open server's channels, and the call / user bars.
 */
export function HomeScreen({ nav }: { nav: Nav }) {
  const selected = useHomeUi((s) => s.serverId);
  const exists = useNexus((s) => (selected ? !!s.servers[selected] : true));
  const ready = useNexus((s) => s.connection === 'ready');
  // Left or deleted server: back to Início.
  useEffect(() => {
    if (ready && !exists) setHomeUi({ serverId: null });
  }, [ready, exists]);
  const serverId = exists ? selected : null;

  return (
    <View style={[common.screen, styles.layout]}>
      <ServerRail selected={serverId} nav={nav} />
      <View style={styles.main}>
        <View style={[common.panel, { flex: 1 }]}>
          <ConnectionBanner />
          <UpdateBanner />
          {serverId ? <ServerPanel key={serverId} serverId={serverId} nav={nav} /> : <DirectPanel nav={nav} />}
        </View>
        <CallBar nav={nav} />
        <UserBar nav={nav} />
      </View>
    </View>
  );
}

// ---------- server rail ----------

function ServerRail({ selected, nav }: { selected: string | null; nav: Nav }) {
  const servers = useNexus(useShallow((s) => Object.values(s.servers)));
  const dmUnread = useNexus(totalUnread);
  const pending = useNexus((s) => s.incoming.length);
  const [adding, setAdding] = useState(false);
  return (
    <View style={styles.rail}>
      <ScrollView contentContainerStyle={styles.railContent} showsVerticalScrollIndicator={false}>
        <RailItem active={selected === null} badge={dmUnread + pending} label="Início" onPress={() => setHomeUi({ serverId: null })}>
          <View style={[styles.home, selected === null && { borderRadius: 16 }]}>
            {selected === null && <Gradient radius={16} />}
            <Image source={require('../assets/logo.png')} style={{ width: 30, height: 26 }} resizeMode="contain" />
          </View>
        </RailItem>
        <View style={styles.railSep} />
        {servers.map((sv) => (
          <ServerRailItem key={sv.id} server={sv} active={sv.id === selected} />
        ))}
        <RailItem label="Adicionar um servidor" onPress={() => setAdding(true)}>
          <View style={styles.add}>
            <Icon name="plus" color={colors.success} />
          </View>
        </RailItem>
      </ScrollView>
      {adding && (
        <AddServer
          onClose={() => setAdding(false)}
          onOpen={(id) => {
            setHomeUi({ serverId: id });
            nav.home();
          }}
        />
      )}
    </View>
  );
}

const ServerRailItem = memo(function ServerRailItem({ server, active }: { server: ServerView; active: boolean }) {
  const unread = useNexus((s) => serverHasUnread(s, server.id));
  return (
    <RailItem active={active} unread={unread} label={server.name} onPress={() => setHomeUi({ serverId: server.id })}>
      <ServerIcon server={server} size={48} rounded={active ? 16 : 24} />
    </RailItem>
  );
});

function RailItem({
  active,
  unread,
  badge,
  label,
  onPress,
  children,
}: {
  active?: boolean;
  unread?: boolean;
  badge?: number;
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.railItem}>
      {/* Pill on the left edge, like the desktop rail. */}
      <View style={[styles.pill, active ? styles.pillActive : unread ? styles.pillUnread : null]} />
      <Pressable onPress={onPress} accessibilityLabel={label} style={({ pressed }) => pressed && { transform: [{ scale: 0.94 }] }}>
        {children}
      </Pressable>
      {!!badge && badge > 0 && (
        <View style={styles.railBadge}>
          <Badge count={badge} />
        </View>
      )}
    </View>
  );
}

// ---------- Início (DMs) ----------

function DirectPanel({ nav }: { nav: Nav }) {
  const conversations = useNexus(useShallow(sortedConversations));
  const pending = useNexus((s) => s.incoming.length);
  const [creating, setCreating] = useState(false);
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>Início</Text>
        <IconButton name="plus" label="Novo grupo" filled onPress={() => setCreating(true)} color={colors.text} />
      </View>
      <FlatList
        data={conversations}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.md }}
        ListHeaderComponent={
          <View style={{ gap: 2 }}>
            <Pressable
              style={({ pressed }) => [styles.navItem, pressed && styles.pressed]}
              onPress={() => nav.push({ name: 'friends' })}
            >
              <View style={styles.navIcon}>
                <Icon name="users" size={20} color={colors.text} />
              </View>
              <Text style={[common.text, { flex: 1, fontWeight: '600' }]}>Amigos</Text>
              <Badge count={pending} />
            </Pressable>
            <Text style={[common.section, styles.sectionPad]}>Mensagens diretas</Text>
          </View>
        }
        renderItem={({ item }) => <ConversationRow conversation={item} onPress={() => nav.push({ name: 'chat', id: item.id })} />}
        ListEmptyComponent={<Text style={common.empty}>Nenhuma conversa ainda. Abra uma pelos Amigos.</Text>}
      />
      {creating && <CreateGroup onClose={() => setCreating(false)} onCreated={(id) => nav.push({ name: 'chat', id })} />}
    </View>
  );
}

const ConversationRow = memo(function ConversationRow({
  conversation,
  onPress,
}: {
  conversation: ConversationView;
  onPress: () => void;
}) {
  const title = useNexus((s) => conversationTitle(s, conversation));
  const peer = useNexus((s) => (conversation.kind === 'dm' ? dmPeer(s, conversation) : undefined));
  const peerUser = useNexus((s) => (peer ? s.users[peer.id] : undefined));
  const presence = useNexus((s) => (peer ? (s.presences[peer.id] ?? 'offline') : undefined));
  const inCall = useNexus((s) => (callForConversation(s, conversation.id)?.participants.length ?? 0) > 0);
  const unread = conversation.unread_count > 0;
  return (
    <Pressable style={({ pressed }) => [styles.convRow, pressed && styles.pressed]} onPress={onPress}>
      {conversation.kind === 'dm' ? (
        <Avatar user={peerUser ?? peer} presence={presence} size={40} />
      ) : (
        <View style={styles.groupIcon}>
          <Gradient radius={20} />
          <Icon name="users" size={18} color="#fff" />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={[common.text, { color: unread ? colors.text : colors.textMuted, fontWeight: unread ? '700' : '500' }]} numberOfLines={1}>
          {title}
        </Text>
        {conversation.kind === 'group' && (
          <Text style={common.faint} numberOfLines={1}>
            {conversation.members.length} membros
          </Text>
        )}
      </View>
      {inCall && <Icon name="volume" size={18} color={colors.success} />}
      <Badge count={conversation.unread_count} />
    </Pressable>
  );
});

// ---------- bottom bars ----------

function CallBar({ nav }: { nav: Nav }) {
  const status = useCall((s) => s.status);
  const conversationId = useCall((s) => s.conversationId);
  const muted = useCall((s) => s.muted);
  const label = useNexus((s) => {
    const c = conversationId ? s.conversations[conversationId] : undefined;
    if (!c) return '';
    const server = c.server_id ? s.servers[c.server_id] : undefined;
    return server ? `${c.name} / ${server.name}` : conversationTitle(s, c);
  });
  if (status === 'idle') return null;
  const connected = status === 'connected';
  return (
    <Pressable style={[common.panel, styles.callBar]} onPress={() => nav.push({ name: 'call' })}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.callStatus, { color: connected ? colors.success : colors.idle }]}>
          {connected ? 'Conectado à voz' : status === 'connecting' ? 'Conectando…' : 'Reconectando…'}
        </Text>
        <Text style={common.faint} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <IconButton
        name={muted ? 'micOff' : 'mic'}
        label={muted ? 'Ativar microfone' : 'Silenciar microfone'}
        danger={muted}
        filled
        onPress={() => void calls.toggleMute()}
      />
      <IconButton name="phoneOff" label="Sair da chamada" danger filled onPress={() => void calls.leave()} />
    </Pressable>
  );
}

function UserBar({ nav }: { nav: Nav }) {
  const me = useNexus((s) => s.me);
  const live = useNexus((s) => (s.me ? s.presences[s.me.id] : undefined));
  if (!me) return null;
  const presence: Presence = live ?? (me.status === 'invisible' ? 'offline' : me.status);
  return (
    <Pressable style={[common.panel, styles.userBar]} onPress={() => nav.push({ name: 'settings' })}>
      <Avatar user={me} size={36} presence={presence} />
      <View style={{ flex: 1 }}>
        <Text style={[common.text, { fontWeight: '700' }]} numberOfLines={1}>
          {me.display_name}
        </Text>
        <Text style={common.faint}>{STATUS_LABEL[me.status] ?? 'Online'}</Text>
      </View>
      <IconButton name="settings" label="Configurações" onPress={() => nav.push({ name: 'settings' })} />
    </Pressable>
  );
}

function ConnectionBanner() {
  const connection = useNexus((s) => s.connection);
  if (connection === 'ready') return null;
  return (
    <Text style={styles.banner}>{connection === 'reconnecting' ? 'Reconectando…' : connection === 'stopped' ? 'Desconectado' : 'Conectando…'}</Text>
  );
}

function UpdateBanner() {
  const { available, status, error } = useUpdate();
  if (!available) return null;
  const label =
    status === 'downloading'
      ? 'Baixando… o instalador do Android abrirá em seguida.'
      : status === 'needs-permission'
        ? 'Permita "instalar apps desconhecidos" para o Nexus e toque de novo.'
        : status === 'error'
          ? (error ?? 'Falha na atualização. Toque para tentar de novo.')
          : `Nexus ${available.version} disponível — toque para atualizar`;
  return (
    <Pressable style={styles.update} onPress={() => void installUpdate()}>
      <Text style={common.text}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  layout: { flexDirection: 'row' },
  main: { flex: 1, paddingVertical: space.sm, paddingRight: space.sm, gap: space.sm },
  rail: { width: 72 },
  railContent: { alignItems: 'center', paddingVertical: space.sm, gap: space.sm },
  railItem: { width: 72, alignItems: 'center', justifyContent: 'center' },
  pill: {
    position: 'absolute',
    left: 0,
    width: 4,
    height: 0,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    backgroundColor: colors.text,
  },
  pillActive: { height: 36 },
  pillUnread: { height: 8 },
  railBadge: { position: 'absolute', right: 6, bottom: -2 },
  railSep: { width: 32, height: 2, borderRadius: 1, backgroundColor: colors.border },
  home: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  add: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: space.sm,
    height: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  panelTitle: { color: colors.text, fontSize: 17, fontWeight: '800', flex: 1 },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: 10,
    borderRadius: radius.md,
    marginTop: space.sm,
  },
  navIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionPad: { paddingHorizontal: space.sm, paddingTop: space.lg, paddingBottom: space.xs },
  convRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
    borderRadius: radius.md,
  },
  pressed: { backgroundColor: colors.surfaceHover },
  groupIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBar: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.md, paddingRight: space.xs, paddingVertical: 6 },
  callStatus: { fontWeight: '800', fontSize: 14 },
  userBar: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.sm, paddingRight: space.xs, paddingVertical: 8 },
  banner: { backgroundColor: colors.idle, color: '#1d1300', textAlign: 'center', fontWeight: '700', paddingVertical: 3 },
  update: {
    backgroundColor: 'rgba(84,104,245,0.16)',
    borderColor: 'rgba(84,104,245,0.45)',
    borderWidth: 1,
    borderRadius: radius.md,
    margin: space.sm,
    padding: space.sm,
  },
});
