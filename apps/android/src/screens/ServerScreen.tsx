import { type ConversationView, type Id, Permissions, type ServerView, hasPermission } from '@nexus/protocol';
import { type ChannelGroup, callForConversation, memberColor, memberName, serverChannels } from '@nexus/shared';
import React, { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, Share, StyleSheet, Text, TextInput, View, ScrollView } from 'react-native';
import type { Nav } from '../App';
import { calls, useCall } from '../call/callManager';
import { setHomeUi, useHomeUi } from '../lib/homeUi';
import { client, useNexus } from '../lib/nexus';
import { NexusNative } from '../native/NexusNative';
import { Avatar, Button, Icon, ServerIcon, Sheet, SheetItem } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';

export { ServerIcon };

/** Channels of one server by category (the home panel when a server is selected). */
export function ServerPanel({ serverId, nav }: { serverId: Id; nav: Nav }) {
  const server = useNexus((s) => s.servers[serverId]);
  const conversations = useNexus((s) => s.conversations);
  const groups = useMemo(
    () => (server ? serverChannels({ servers: { [serverId]: server }, conversations }, serverId) : []),
    [server, conversations, serverId],
  );
  const [menu, setMenu] = useState(false);
  const [nickname, setNickname] = useState(false);
  if (!server) return null;
  const meId = client().store.getState().me?.id;
  const canInvite = hasPermission(server.permissions, Permissions.CREATE_INVITE);

  async function invite() {
    const inv = await client().api.createServerInvite(serverId, { expires_in_secs: 7 * 86400 });
    void Share.share({ message: `Entra no ${server?.name} no Nexus! Código do convite: ${inv.code}` });
  }

  return (
    <View style={{ flex: 1 }}>
      <Pressable style={styles.header} onPress={() => setMenu(true)} accessibilityLabel="Opções do servidor">
        <Text style={styles.title} numberOfLines={1}>
          {server.name}
        </Text>
        <Icon name="chevronDown" size={18} color={colors.text} />
      </Pressable>
      <ScrollView contentContainerStyle={{ padding: space.sm, paddingBottom: space.lg }}>
        {canInvite && (
          <Pressable style={({ pressed }) => [styles.inviteCard, pressed && { opacity: 0.85 }]} onPress={() => void invite()}>
            <Icon name="userPlus" size={20} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={[common.text, { fontWeight: '700' }]}>Convidar pessoas</Text>
              <Text style={common.faint}>Gera um código válido por 7 dias</Text>
            </View>
            <Icon name="share" size={18} />
          </Pressable>
        )}
        {groups.map((g) => (
          <Category key={g.category?.id ?? 'none'} group={g} server={server} nav={nav} />
        ))}
        {groups.every((g) => g.channels.length === 0) && <Text style={common.empty}>Nenhum canal visível para você aqui.</Text>}
      </ScrollView>
      {menu && (
        <Sheet title={server.name} onClose={() => setMenu(false)}>
          {canInvite && (
            <SheetItem
              icon="link"
              label="Convidar pessoas"
              onPress={() => {
                setMenu(false);
                void invite();
              }}
            />
          )}
          {hasPermission(server.permissions, Permissions.CHANGE_NICKNAME) && (
            <SheetItem
              icon="edit"
              label="Mudar meu apelido"
              onPress={() => {
                setMenu(false);
                setNickname(true);
              }}
            />
          )}
          <SheetItem
            icon="copy"
            label="Copiar nome do servidor"
            onPress={() => {
              setMenu(false);
              NexusNative.copyText(server.name);
            }}
          />
          <Text style={[common.faint, { paddingVertical: space.sm }]}>
            Cargos, permissões e moderação ficam no app de Windows por enquanto.
          </Text>
          {server.owner_id !== meId && (
            <SheetItem
              icon="doorOut"
              label="Sair do servidor"
              danger
              onPress={() => {
                setMenu(false);
                Alert.alert(`Sair de ${server.name}?`, 'Você só volta com um novo convite.', [
                  { text: 'Cancelar', style: 'cancel' },
                  {
                    text: 'Sair',
                    style: 'destructive',
                    onPress: () =>
                      void client()
                        .api.leaveServer(serverId)
                        .then(() => setHomeUi({ serverId: null })),
                  },
                ]);
              }}
            />
          )}
        </Sheet>
      )}
      {nickname && meId && <NicknameSheet server={server} userId={meId} onClose={() => setNickname(false)} />}
    </View>
  );
}

function Category({ group, server, nav }: { group: ChannelGroup; server: ServerView; nav: Nav }) {
  const id = group.category?.id;
  const collapsed = useHomeUi((s) => (id ? !!s.collapsed[id] : false));
  const active = useNexus((s) => s.activeConversationId);
  // A collapsed category still shows unread channels.
  const shown = collapsed ? group.channels.filter((c) => c.unread_count > 0 || c.id === active) : group.channels;
  return (
    <View style={{ marginBottom: space.xs }}>
      {group.category && (
        <Pressable
          style={styles.category}
          onPress={() => id && setHomeUi({ collapsed: { ...useHomeUi.getState().collapsed, [id]: !collapsed } })}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} color={colors.textFaint} />
          <Text style={common.section}>{group.category.name}</Text>
        </Pressable>
      )}
      {shown.map((c) =>
        c.kind === 'voice' ? (
          <VoiceRow key={c.id} channel={c} server={server} nav={nav} />
        ) : (
          <TextRow key={c.id} channel={c} nav={nav} />
        ),
      )}
    </View>
  );
}

function TextRow({ channel, nav }: { channel: ConversationView; nav: Nav }) {
  const unread = channel.unread_count;
  const locked = !hasPermission(channel.permissions, Permissions.SEND_MESSAGES);
  return (
    <Pressable
      style={({ pressed }) => [styles.channel, pressed && styles.pressed]}
      onPress={() => nav.push({ name: 'chat', id: channel.id })}
    >
      <Icon name={locked ? 'lock' : 'hash'} size={20} color={unread ? colors.text : colors.textFaint} />
      <Text style={[styles.channelName, unread > 0 && styles.unread]} numberOfLines={1}>
        {channel.name}
      </Text>
      {unread > 0 && (
        <View style={common.badge}>
          <Text style={common.badgeText}>{unread >= 100 ? '99+' : unread}</Text>
        </View>
      )}
    </Pressable>
  );
}

function VoiceRow({ channel, server, nav }: { channel: ConversationView; server: ServerView; nav: Nav }) {
  const call = useNexus((s) => callForConversation(s, channel.id));
  const here = useCall((s) => s.conversationId === channel.id);
  const canConnect = hasPermission(channel.permissions, Permissions.CONNECT);
  return (
    <View>
      <Pressable
        disabled={!canConnect}
        style={({ pressed }) => [
          styles.channel,
          here && styles.connected,
          pressed && styles.pressed,
          !canConnect && { opacity: 0.5 },
        ]}
        onPress={async () => {
          if (!here) await calls.start(channel.id);
          nav.push({ name: 'call' });
        }}
      >
        <Icon name={canConnect ? 'volume' : 'lock'} size={20} color={here ? colors.success : colors.textFaint} />
        <Text style={[styles.channelName, here && { color: colors.success, fontWeight: '700' }]} numberOfLines={1}>
          {channel.name}
        </Text>
        {!!call?.participants.length && <Text style={common.faint}>{call.participants.length}</Text>}
      </Pressable>
      {call?.participants.map((p) => (
        <VoiceMember key={p.user_id} server={server} userId={p.user_id} muted={p.muted || p.deafened} screen={p.screen} />
      ))}
    </View>
  );
}

function VoiceMember({ server, userId, muted, screen }: { server: ServerView; userId: Id; muted: boolean; screen: boolean }) {
  const user = useNexus((s) => s.users[userId]);
  const name = useNexus((s) => memberName(s, server, userId));
  const color = memberColor(server, userId);
  return (
    <View style={styles.voiceMember}>
      <Avatar user={user} size={24} />
      <Text style={[common.muted, { flex: 1 }, color ? { color } : null]} numberOfLines={1}>
        {name}
      </Text>
      {screen && <Text style={styles.live}>AO VIVO</Text>}
      {muted && <Icon name="micOff" size={14} color={colors.danger} />}
    </View>
  );
}

function NicknameSheet({ server, userId, onClose }: { server: ServerView; userId: Id; onClose: () => void }) {
  const current = server.members.find((m) => m.user.id === userId)?.nickname ?? '';
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const save = (nickname: string | null) =>
    client()
      .api.updateServerMember(server.id, userId, { nickname })
      .then(onClose)
      .catch((e: Error) => setError(e.message));
  return (
    <Sheet title="Meu apelido" onClose={onClose}>
      <View style={{ gap: space.md }}>
        <TextInput
          style={common.input}
          value={value}
          onChangeText={setValue}
          maxLength={32}
          autoFocus
          placeholder="Vazio = usar seu nome de exibição"
          placeholderTextColor={colors.textFaint}
        />
        {error && <Text style={common.error}>{error}</Text>}
        <Button label="Salvar" onPress={() => void save(value.trim() || null)} />
        {!!current && <Button label="Remover apelido" variant="secondary" onPress={() => void save(null)} />}
      </View>
    </Sheet>
  );
}

/** Create a server or join one with an invite code. */
export function AddServer({ onClose, onOpen }: { onClose: () => void; onOpen: (id: Id) => void }) {
  const [mode, setMode] = useState<'join' | 'create'>('join');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const view =
        mode === 'create'
          ? await client().api.createServer(value.trim())
          : await client().api.joinServer(value.trim().split(/[\s/]+/).pop() ?? '');
      client().store.setState((s) => ({ servers: { ...s.servers, [view.id]: view } }));
      onClose();
      onOpen(view.id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(
        mode === 'join' ? (status === 403 ? 'Você foi banido deste servidor.' : 'Convite inválido ou expirado.') : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[common.panel, styles.modal]} onPress={() => undefined}>
          <Text style={[common.headerTitle, { flex: 0, textAlign: 'center' }]}>
            {mode === 'join' ? 'Entrar em um servidor' : 'Criar um servidor'}
          </Text>
          <Text style={[common.muted, { textAlign: 'center' }]}>
            {mode === 'join'
              ? 'Cole o código do convite que te mandaram.'
              : 'Seu espaço para conversar, com canais de texto e de voz.'}
          </Text>
          <View style={styles.segment}>
            {(['join', 'create'] as const).map((m) => (
              <Pressable key={m} onPress={() => setMode(m)} style={[styles.segmentItem, mode === m && styles.segmentOn]}>
                <Text style={[common.text, { fontWeight: '600', color: mode === m ? colors.text : colors.textMuted }]}>
                  {m === 'join' ? 'Entrar com convite' : 'Criar servidor'}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={common.input}
            value={value}
            onChangeText={setValue}
            autoFocus
            autoCapitalize="none"
            placeholder={mode === 'join' ? 'Código do convite' : 'Nome do servidor'}
            placeholderTextColor={colors.textFaint}
            maxLength={64}
          />
          {error && <Text style={common.error}>{error}</Text>}
          <Button label={mode === 'join' ? 'Entrar' : 'Criar'} busy={busy} disabled={!value.trim()} onPress={() => void submit()} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 56,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '800', flex: 1 },
  inviteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    marginBottom: space.sm,
    borderRadius: radius.md,
    backgroundColor: 'rgba(84,104,245,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(84,104,245,0.35)',
  },
  category: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.xs,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  channel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 9,
    borderRadius: radius.sm,
  },
  pressed: { backgroundColor: colors.surfaceHover },
  connected: { backgroundColor: 'rgba(47,210,122,0.1)' },
  channelName: { flex: 1, color: colors.textMuted, fontSize: 16, fontWeight: '500' },
  unread: { color: colors.text, fontWeight: '700' },
  voiceMember: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: 36, paddingRight: space.sm, paddingVertical: 4 },
  live: {
    color: '#fff',
    backgroundColor: colors.danger,
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 5,
    borderRadius: 4,
    overflow: 'hidden',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(3,4,10,0.65)', justifyContent: 'center', padding: space.lg },
  modal: { padding: space.lg, gap: space.md },
  segment: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: radius.md, padding: 4 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.sm },
  segmentOn: { backgroundColor: colors.surfaceRaised },
});
