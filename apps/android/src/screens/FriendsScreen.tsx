import type { PublicUser } from '@nexus/protocol';
import { ApiError } from '@nexus/shared';
import React, { useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';
import type { Nav } from '../App';
import { client, useNexus } from '../lib/nexus';
import { Avatar, Button, Header, Icon, IconButton } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';

type Tab = 'online' | 'all' | 'pending';

/** Friends: online / all / pending, and add by username (like the desktop). */
export function FriendsScreen({ nav }: { nav: Nav }) {
  const [tab, setTab] = useState<Tab>('online');
  const pending = useNexus((s) => s.incoming.length + s.outgoing.length);
  return (
    <View style={common.screen}>
      <Header title="Amigos" onBack={nav.back} />
      <AddFriend />
      <View style={styles.tabs}>
        {(
          [
            ['online', 'Online'],
            ['all', 'Todos'],
            ['pending', pending ? `Pendentes (${pending})` : 'Pendentes'],
          ] as const
        ).map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} style={[styles.tab, tab === key && styles.tabActive]}>
            <Text style={[styles.tabText, tab === key && { color: colors.text }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'pending' ? <Pending /> : <FriendList onlineOnly={tab === 'online'} nav={nav} />}
    </View>
  );
}

function AddFriend() {
  const [username, setUsername] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function add() {
    if (!username.trim()) return;
    setMsg(null);
    try {
      const r = await client().api.sendFriendRequest(username.trim());
      setMsg({ ok: true, text: r.status === 'accepted' ? 'Vocês agora são amigos!' : 'Pedido de amizade enviado.' });
      setUsername('');
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError && e.status === 404 ? 'Usuário não encontrado.' : (e as Error).message });
    }
  }
  return (
    <View style={{ paddingHorizontal: space.md, gap: space.xs }}>
      <View style={styles.addBox}>
        <Icon name="userPlus" size={20} />
        <TextInput
          style={styles.addInput}
          placeholder="Adicionar pelo nome de usuário"
          placeholderTextColor={colors.textFaint}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={() => void add()}
        />
        <Pressable style={[styles.addSend, !username.trim() && { opacity: 0.4 }]} onPress={() => void add()} disabled={!username.trim()}>
          <Text style={common.buttonText}>Enviar</Text>
        </Pressable>
      </View>
      {msg && <Text style={[common.muted, { color: msg.ok ? colors.success : colors.danger }]}>{msg.text}</Text>}
    </View>
  );
}

function FriendList({ onlineOnly, nav }: { onlineOnly: boolean; nav: Nav }) {
  const friends = useNexus(
    useShallow((s) =>
      Object.values(s.friends)
        .map((f) => s.users[f.user.id] ?? f.user)
        .filter((u) => !onlineOnly || (s.presences[u.id] ?? 'offline') !== 'offline')
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    ),
  );
  const presences = useNexus((s) => s.presences);
  async function openDm(u: PublicUser) {
    const c = await client().api.openDm(u.id);
    nav.push({ name: 'chat', id: c.id });
  }
  return (
    <FlatList
      data={friends}
      keyExtractor={(u) => u.id}
      contentContainerStyle={{ padding: space.sm }}
      ListHeaderComponent={
        <Text style={[common.section, { padding: space.sm }]}>
          {onlineOnly ? 'Online' : 'Todos os amigos'} — {friends.length}
        </Text>
      }
      ListEmptyComponent={
        <Text style={common.empty}>{onlineOnly ? 'Ninguém online agora.' : 'Você ainda não tem amigos aqui. Adicione pelo nome de usuário acima.'}</Text>
      }
      renderItem={({ item }) => (
        <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => void openDm(item)}>
          <Avatar user={item} presence={presences[item.id] ?? 'offline'} ringColor={colors.bg} />
          <View style={{ flex: 1 }}>
            <Text style={[common.text, { fontWeight: '700' }]}>{item.display_name}</Text>
            <Text style={common.faint}>@{item.username}</Text>
          </View>
          <IconButton name="message" label="Mensagem" filled onPress={() => void openDm(item)} />
          <IconButton
            name="more"
            label="Mais opções"
            filled
            onPress={() =>
              Alert.alert(item.display_name, undefined, [
                {
                  text: 'Remover amigo',
                  style: 'destructive',
                  onPress: () => void client().api.removeFriend(item.id),
                },
                { text: 'Bloquear', style: 'destructive', onPress: () => void client().api.block(item.id) },
                { text: 'Cancelar', style: 'cancel' },
              ])
            }
          />
        </Pressable>
      )}
    />
  );
}

function Pending() {
  const incoming = useNexus((s) => s.incoming);
  const outgoing = useNexus((s) => s.outgoing);
  type Item = { kind: 'header'; label: string } | { kind: 'in' | 'out'; id: string; user: PublicUser };
  const items: Item[] = [
    ...(incoming.length ? [{ kind: 'header' as const, label: `Recebidos — ${incoming.length}` }] : []),
    ...incoming.map((r) => ({ kind: 'in' as const, id: r.id, user: r.from })),
    ...(outgoing.length ? [{ kind: 'header' as const, label: `Enviados — ${outgoing.length}` }] : []),
    ...outgoing.map((r) => ({ kind: 'out' as const, id: r.id, user: r.to })),
  ];
  return (
    <FlatList
      data={items}
      keyExtractor={(it, i) => (it.kind === 'header' ? `h${i}` : it.id)}
      contentContainerStyle={{ padding: space.sm }}
      ListEmptyComponent={<Text style={common.empty}>Nenhum pedido pendente.</Text>}
      renderItem={({ item }) =>
        item.kind === 'header' ? (
          <Text style={[common.section, { padding: space.sm }]}>{item.label}</Text>
        ) : (
          <View style={styles.row}>
            <Avatar user={item.user} />
            <View style={{ flex: 1 }}>
              <Text style={[common.text, { fontWeight: '700' }]}>{item.user.display_name}</Text>
              <Text style={common.faint}>{item.kind === 'in' ? 'Pedido recebido' : 'Pedido enviado'}</Text>
            </View>
            {item.kind === 'in' && (
              <IconButton name="check" label="Aceitar" filled color={colors.success} onPress={() => void client().api.acceptFriendRequest(item.id)} />
            )}
            <IconButton
              name="x"
              label={item.kind === 'in' ? 'Recusar' : 'Cancelar'}
              filled
              onPress={() => void client().api.deleteFriendRequest(item.id)}
            />
          </View>
        )
      }
    />
  );
}

/** New group from friends. */
export function CreateGroup({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const friends = useNexus(useShallow((s) => Object.values(s.friends).map((f) => f.user)));
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[common.panel, styles.modal]} onPress={() => undefined}>
          <Text style={[common.headerTitle, { flex: 0 }]}>Novo grupo</Text>
          <TextInput
            style={common.input}
            placeholder="Nome do grupo (opcional)"
            placeholderTextColor={colors.textFaint}
            value={name}
            onChangeText={setName}
          />
          <Text style={common.section}>Amigos — {selected.length} selecionados</Text>
          <FlatList
            style={{ maxHeight: 320 }}
            data={friends}
            keyExtractor={(f) => f.id}
            ListEmptyComponent={<Text style={common.empty}>Adicione amigos para criar um grupo.</Text>}
            renderItem={({ item }) => {
              const on = selected.includes(item.id);
              return (
                <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => toggle(item.id)}>
                  <Avatar user={item} size={34} />
                  <Text style={[common.text, { flex: 1 }]}>{item.display_name}</Text>
                  <View style={[styles.check, on && styles.checkOn]}>{on && <Icon name="check" size={14} color="#fff" />}</View>
                </Pressable>
              );
            }}
          />
          <View style={[common.row, { gap: space.sm, justifyContent: 'flex-end' }]}>
            <Button label="Cancelar" variant="secondary" onPress={onClose} />
            <Button
              label="Criar grupo"
              busy={busy}
              disabled={selected.length === 0}
              onPress={async () => {
                setBusy(true);
                try {
                  const c = await client().api.createGroup(name.trim(), selected);
                  onClose();
                  onCreated(c.id);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: space.xs, paddingHorizontal: space.md, paddingTop: space.md },
  tab: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: radius.round },
  tabActive: { backgroundColor: colors.surfaceRaised },
  tabText: { color: colors.textMuted, fontWeight: '600' },
  addBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: space.md,
    padding: 6,
  },
  addInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 6 },
  addSend: { backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.sm, borderRadius: radius.md },
  pressed: { backgroundColor: colors.surfaceHover },
  backdrop: { flex: 1, backgroundColor: 'rgba(3,4,10,0.65)', justifyContent: 'center', padding: space.lg },
  modal: { padding: space.lg, gap: space.md },
  check: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
});
