import { type ConversationView, type Id, Permissions, type ServerView, hasPermission } from '@nexus/protocol';
import { callForConversation, memberColor, memberName, serverChannels } from '@nexus/shared';
import React, { useMemo, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Nav } from '../App';
import { calls } from '../call/callManager';
import { client, useNexus } from '../lib/nexus';
import { Avatar, Icon, IconButton } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';

/** Gradient stand-in for servers without an icon (solid color on Android). */
function serverHue(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 65%, 52%)`;
}

export function ServerIcon({ server, size = 48 }: { server: Pick<ServerView, 'id' | 'name' | 'icon_url'>; size?: number }) {
  const url = client().api.url(server.icon_url);
  const words = server.name.trim().split(/\s+/);
  const initials = (words.length > 1 ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '') : server.name.slice(0, 2)).toUpperCase();
  return url ? (
    <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: size * 0.32 }} />
  ) : (
    <View style={[styles.initials, { width: size, height: size, borderRadius: size * 0.32, backgroundColor: serverHue(server.id) }]}>
      <Text style={{ color: '#fff', fontWeight: '800', fontSize: size * 0.34 }}>{initials}</Text>
    </View>
  );
}

/** Channels of one server, by category. */
export function ServerScreen({ serverId, nav }: { serverId: Id; nav: Nav }) {
  const server = useNexus((s) => s.servers[serverId]);
  const conversations = useNexus((s) => s.conversations);
  const groups = useMemo(
    () => (server ? serverChannels({ servers: { [serverId]: server }, conversations }, serverId) : []),
    [server, conversations, serverId],
  );
  const [invite, setInvite] = useState<string | null>(null);
  if (!server) return null;

  async function shareInvite() {
    const inv = await client().api.createServerInvite(serverId, { expires_in_secs: 7 * 86400 });
    setInvite(inv.code);
    void Share.share({ message: `Entra no ${server?.name} no Nexus! Código do convite: ${inv.code}` });
  }

  return (
    <View style={common.screen}>
      <View style={common.header}>
        <IconButton name="reply" label="Voltar" onPress={nav.back} />
        <ServerIcon server={server} size={30} />
        <Text style={common.headerTitle} numberOfLines={1}>
          {server.name}
        </Text>
        {hasPermission(server.permissions, Permissions.CREATE_INVITE) && (
          <IconButton name="link" label="Convidar" onPress={() => void shareInvite()} />
        )}
      </View>
      {invite && (
        <Text style={styles.inviteBar} selectable>
          Convite: {invite} (vale 7 dias)
        </Text>
      )}
      <ScrollView contentContainerStyle={{ padding: space.sm }}>
        {groups.map((g) => (
          <View key={g.category?.id ?? 'none'} style={{ marginBottom: space.sm }}>
            {g.category && <Text style={styles.category}>{g.category.name}</Text>}
            {g.channels.map((c) =>
              c.kind === 'voice' ? (
                <VoiceRow key={c.id} channel={c} server={server} nav={nav} />
              ) : (
                <Pressable
                  key={c.id}
                  style={({ pressed }) => [styles.channel, pressed && { backgroundColor: colors.surfaceHover }]}
                  onPress={() => nav.push({ name: 'chat', id: c.id })}
                >
                  <Icon name="hash" size={18} color={c.unread_count ? colors.text : colors.textMuted} />
                  <Text style={[styles.channelName, c.unread_count > 0 && styles.unread]} numberOfLines={1}>
                    {c.name}
                  </Text>
                  {c.unread_count > 0 && (
                    <View style={common.badge}>
                      <Text style={common.badgeText}>{c.unread_count >= 100 ? '99+' : c.unread_count}</Text>
                    </View>
                  )}
                </Pressable>
              ),
            )}
          </View>
        ))}
        <Text style={[common.muted, { textAlign: 'center', marginTop: space.lg }]}>
          Cargos, permissões e moderação ficam no app de Windows por enquanto.
        </Text>
      </ScrollView>
    </View>
  );
}

function VoiceRow({ channel, server, nav }: { channel: ConversationView; server: ServerView; nav: Nav }) {
  const call = useNexus((s) => callForConversation(s, channel.id));
  const canConnect = hasPermission(channel.permissions, Permissions.CONNECT);
  return (
    <View>
      <Pressable
        disabled={!canConnect}
        style={({ pressed }) => [styles.channel, pressed && { backgroundColor: colors.surfaceHover }, !canConnect && { opacity: 0.5 }]}
        onPress={async () => {
          await calls.start(channel.id);
          nav.push({ name: 'call' });
        }}
      >
        <Icon name="volume" size={18} color={colors.textMuted} />
        <Text style={styles.channelName} numberOfLines={1}>
          {channel.name}
        </Text>
      </Pressable>
      {call?.participants.map((p) => (
        <VoiceMember key={p.user_id} server={server} userId={p.user_id} muted={p.muted || p.deafened} />
      ))}
    </View>
  );
}

function VoiceMember({ server, userId, muted }: { server: ServerView; userId: Id; muted: boolean }) {
  const user = useNexus((s) => s.users[userId]);
  const name = useNexus((s) => memberName(s, server, userId));
  const color = memberColor(server, userId);
  return (
    <View style={styles.voiceMember}>
      <Avatar user={user} size={22} />
      <Text style={[common.muted, { flex: 1 }, color ? { color } : null]} numberOfLines={1}>
        {name}
      </Text>
      {muted && <Icon name="micOff" size={14} color={colors.textFaint} />}
    </View>
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
        mode === 'join'
          ? status === 403
            ? 'Você foi banido deste servidor.'
            : 'Convite inválido ou expirado.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.tabs}>
            {(['join', 'create'] as const).map((m) => (
              <Pressable key={m} onPress={() => setMode(m)} style={[styles.tab, mode === m && styles.tabActive]}>
                <Text style={[common.text, mode !== m && { color: colors.textMuted }]}>
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
          <Pressable style={[common.button, (busy || !value.trim()) && { opacity: 0.5 }]} disabled={busy || !value.trim()} onPress={() => void submit()}>
            <Text style={common.buttonText}>{mode === 'join' ? 'Entrar' : 'Criar'}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  initials: { alignItems: 'center', justifyContent: 'center' },
  inviteBar: {
    backgroundColor: 'rgba(84,104,245,0.16)',
    color: colors.text,
    padding: space.sm,
    textAlign: 'center',
  },
  category: {
    color: colors.textFaint,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: space.sm,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  channel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 10,
    borderRadius: radius.sm,
  },
  channelName: { flex: 1, color: colors.textMuted, fontSize: 16 },
  unread: { color: colors.text, fontWeight: '700' },
  voiceMember: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: 36, paddingVertical: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: space.lg },
  sheet: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  tabs: { flexDirection: 'row', gap: space.sm },
  tab: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  tabActive: { backgroundColor: colors.surfaceRaised },
});
