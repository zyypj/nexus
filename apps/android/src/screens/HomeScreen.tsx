import type { ConversationView, PublicUser } from '@nexus/protocol';
import { ApiError, callForConversation, conversationTitle, dmPeer, sortedConversations } from '@nexus/shared';
import React, { memo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import type { Nav } from '../App';
import { useCall } from '../call/callManager';
import { client, useNexus } from '../lib/nexus';
import { Avatar, Badge, Icon, IconButton } from '../ui/components';
import { colors, common, space } from '../ui/theme';

export function HomeScreen({ nav }: { nav: Nav }) {
  const [tab, setTab] = useState<'chats' | 'friends'>('chats');
  const pending = useNexus((s) => s.incoming.length);
  const connection = useNexus((s) => s.connection);
  const inCall = useCall((s) => s.status !== 'idle');
  return (
    <View style={common.screen}>
      <View style={common.header}>
        <Text style={common.headerTitle}>Nexus</Text>
        {inCall && <IconButton name="phone" active label="Voltar para a chamada" onPress={() => nav.push({ name: 'call' })} />}
        <IconButton name="settings" label="Configurações" onPress={() => nav.push({ name: 'settings' })} />
      </View>
      {connection !== 'ready' && (
        <Text style={styles.banner}>{connection === 'reconnecting' ? 'Reconectando…' : 'Conectando…'}</Text>
      )}
      <View style={styles.tabs}>
        <Tab label="Conversas" active={tab === 'chats'} onPress={() => setTab('chats')} />
        <Tab label={pending ? `Amigos (${pending})` : 'Amigos'} active={tab === 'friends'} onPress={() => setTab('friends')} />
      </View>
      {tab === 'chats' ? <Conversations nav={nav} /> : <Friends nav={nav} />}
    </View>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[common.text, { color: active ? colors.text : colors.textMuted, fontWeight: active ? '600' : '400' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Conversations({ nav }: { nav: Nav }) {
  const conversations = useNexus(useShallow(sortedConversations));
  const [creating, setCreating] = useState(false);
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={conversations}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => <ConversationRow conversation={item} onPress={() => nav.push({ name: 'chat', id: item.id })} />}
        ListEmptyComponent={<Text style={styles.empty}>Nenhuma conversa ainda. Abra uma pela aba Amigos.</Text>}
      />
      <Pressable style={styles.fab} onPress={() => setCreating(true)} accessibilityLabel="Novo grupo">
        <Icon name="plus" color={colors.accentText} />
      </Pressable>
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
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }]} onPress={onPress}>
      {conversation.kind === 'dm' ? (
        <Avatar user={peerUser ?? peer} presence={presence} />
      ) : (
        <View style={styles.groupIcon}>
          <Icon name="hash" size={18} />
        </View>
      )}
      <Text
        style={[common.text, { flex: 1, fontWeight: conversation.unread_count ? '700' : '400' }]}
        numberOfLines={1}
      >
        {title}
      </Text>
      {inCall && <Icon name="volume" size={18} color={colors.success} />}
      <Badge count={conversation.unread_count} />
    </Pressable>
  );
});

function Friends({ nav }: { nav: Nav }) {
  const friends = useNexus(
    useShallow((s) =>
      Object.values(s.friends)
        .map((f) => s.users[f.user.id] ?? f.user)
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    ),
  );
  const incoming = useNexus((s) => s.incoming);
  const outgoing = useNexus((s) => s.outgoing);
  const presences = useNexus((s) => s.presences);
  const [username, setUsername] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function add() {
    setMsg(null);
    try {
      const r = await client().api.sendFriendRequest(username.trim());
      setMsg(r.status === 'accepted' ? 'Vocês agora são amigos!' : 'Pedido enviado.');
      setUsername('');
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 404 ? 'Usuário não encontrado.' : (e as Error).message);
    }
  }

  async function openDm(u: PublicUser) {
    const c = await client().api.openDm(u.id);
    nav.push({ name: 'chat', id: c.id });
  }

  type Item =
    | { kind: 'header'; label: string }
    | { kind: 'incoming' | 'outgoing'; id: string; user: PublicUser }
    | { kind: 'friend'; user: PublicUser };
  const items: Item[] = [
    ...(incoming.length ? [{ kind: 'header' as const, label: 'Pedidos recebidos' }] : []),
    ...incoming.map((r) => ({ kind: 'incoming' as const, id: r.id, user: r.from })),
    ...(outgoing.length ? [{ kind: 'header' as const, label: 'Pedidos enviados' }] : []),
    ...outgoing.map((r) => ({ kind: 'outgoing' as const, id: r.id, user: r.to })),
    { kind: 'header' as const, label: `Amigos — ${friends.length}` },
    ...friends.map((u) => ({ kind: 'friend' as const, user: u })),
  ];

  return (
    <FlatList
      data={items}
      keyExtractor={(it, i) => (it.kind === 'header' ? `h${i}` : `${it.kind}-${'id' in it ? it.id : it.user.id}`)}
      ListHeaderComponent={
        <View style={{ padding: space.md, gap: space.sm }}>
          <View style={common.row}>
            <TextInput
              style={[common.input, { flex: 1 }]}
              placeholder="Adicionar pelo nome de usuário"
              placeholderTextColor={colors.textFaint}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              onSubmitEditing={() => void add()}
            />
            <IconButton name="plus" label="Enviar pedido" active onPress={() => void add()} />
          </View>
          {msg && <Text style={common.muted}>{msg}</Text>}
        </View>
      }
      renderItem={({ item }) => {
        if (item.kind === 'header') return <Text style={styles.section}>{item.label}</Text>;
        const presence = presences[item.user.id] ?? 'offline';
        return (
          <View style={styles.row}>
            <Avatar user={item.user} presence={presence} />
            <View style={{ flex: 1 }}>
              <Text style={common.text}>{item.user.display_name}</Text>
              <Text style={common.muted}>@{item.user.username}</Text>
            </View>
            {item.kind === 'incoming' && (
              <>
                <IconButton name="check" active label="Aceitar" onPress={() => void client().api.acceptFriendRequest(item.id)} />
                <IconButton name="x" label="Recusar" onPress={() => void client().api.deleteFriendRequest(item.id)} />
              </>
            )}
            {item.kind === 'outgoing' && (
              <IconButton name="x" label="Cancelar" onPress={() => void client().api.deleteFriendRequest(item.id)} />
            )}
            {item.kind === 'friend' && <IconButton name="send" label="Mensagem" onPress={() => void openDm(item.user)} />}
          </View>
        );
      }}
    />
  );
}

function CreateGroup({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const friends = useNexus(useShallow((s) => Object.values(s.friends).map((f) => f.user)));
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modal}>
          <Text style={common.headerTitle}>Novo grupo</Text>
          <TextInput
            style={common.input}
            placeholder="Nome (opcional)"
            placeholderTextColor={colors.textFaint}
            value={name}
            onChangeText={setName}
          />
          <FlatList
            style={{ maxHeight: 300 }}
            data={friends}
            keyExtractor={(f) => f.id}
            renderItem={({ item }) => (
              <Pressable style={styles.row} onPress={() => toggle(item.id)}>
                <Avatar user={item} size={32} />
                <Text style={[common.text, { flex: 1 }]}>{item.display_name}</Text>
                {selected.includes(item.id) && <Icon name="check" color={colors.accent} />}
              </Pressable>
            )}
          />
          <View style={[common.row, { gap: space.sm, justifyContent: 'flex-end' }]}>
            <Pressable style={common.buttonSecondary} onPress={onClose}>
              <Text style={common.text}>Cancelar</Text>
            </Pressable>
            <Pressable
              style={[common.button, { paddingHorizontal: 16 }]}
              onPress={async () => {
                const c = await client().api.createGroup(name.trim(), selected);
                onClose();
                onCreated(c.id);
              }}
            >
              <Text style={common.buttonText}>Criar</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.highlight, color: '#1d1300', textAlign: 'center', fontWeight: '600', paddingVertical: 2 },
  tabs: { flexDirection: 'row', paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  tabActive: { backgroundColor: colors.surfaceRaised },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: 10 },
  groupIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { color: colors.textFaint, padding: space.xl, textAlign: 'center' },
  section: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  fab: {
    position: 'absolute',
    right: space.lg,
    bottom: space.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: space.lg },
  modal: { backgroundColor: colors.surface, borderRadius: 14, padding: space.lg, gap: space.md },
});
