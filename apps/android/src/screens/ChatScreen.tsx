import { type Attachment, type Id, Permissions, hasPermission, isChannel } from '@nexus/protocol';
import {
  type ClientMessage,
  callForConversation,
  conversationTitle,
  dmPeer,
  formatBytes,
  formatDay,
  formatTime,
  memberColor,
  memberName,
  sameDay,
  typingUsers,
} from '@nexus/shared';
import { QUICK_REACTIONS } from '@nexus/ui';
import React, { memo, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  PermissionsAndroid,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import type { Nav } from '../App';
import { calls, useCall } from '../call/callManager';
import { seekAudio, toggleAudio, useChatAudio } from '../lib/chatAudio';
import { client, useNexus } from '../lib/nexus';
import { mediaKind, openImage, openVideo } from '../media/media';
import { NexusNative, type PickedFile } from '../native/NexusNative';
import { Avatar, Gradient, Header, Icon, IconButton, Sheet, SheetItem, SolidIcon } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';

const EMPTY: ClientMessage[] = [];

const PRESENCE_LABEL: Record<string, string> = { online: 'Online', idle: 'Ausente', dnd: 'Não perturbe', offline: 'Offline' };

export function ChatScreen({ conversationId, nav }: { conversationId: Id; nav: Nav }) {
  const conv = useNexus((s) => s.conversations[conversationId]);
  const title = useNexus((s) => (conv ? conversationTitle(s, conv) : ''));
  const peer = useNexus((s) => (conv?.kind === 'dm' ? dmPeer(s, conv) : undefined));
  const peerUser = useNexus((s) => (peer ? s.users[peer.id] : undefined));
  const presence = useNexus((s) => (peer ? (s.presences[peer.id] ?? 'offline') : undefined));
  const serverName = useNexus((s) => (conv?.server_id ? s.servers[conv.server_id]?.name : undefined));
  const items = useNexus((s) => s.messages[conversationId]?.items ?? EMPTY);
  const hasMore = useNexus((s) => s.messages[conversationId]?.hasMore ?? false);
  const activeCall = useNexus((s) => callForConversation(s, conversationId));
  const callsEnabled = useNexus((s) => s.server?.calls_enabled ?? false);
  const myCallConv = useCall((s) => s.conversationId);
  const [replyTo, setReplyTo] = useState<ClientMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<ClientMessage | null>(null);
  const [editing, setEditing] = useState<ClientMessage | null>(null);
  // Inverted list: newest first.
  const data = useMemo(() => [...items].reverse(), [items]);
  if (!conv) return null;
  const channel = isChannel(conv);
  const perms = conv.permissions;
  const canSend = !channel || hasPermission(perms, Permissions.SEND_MESSAGES);
  const canAttach = !channel || hasPermission(perms, Permissions.ATTACH_FILES);

  const startCall = async (video: boolean) => {
    if (activeCall) await calls.join(activeCall.id);
    else await calls.start(conversationId, video);
    nav.push({ name: 'call' });
  };

  const subtitle = peer
    ? PRESENCE_LABEL[presence ?? 'offline']
    : channel
      ? conv.topic || serverName || ''
      : `${conv.members.length} membros`;

  return (
    <KeyboardAvoidingView style={common.screen} behavior="height">
      <Header
        title={title}
        subtitle={subtitle}
        onBack={nav.back}
        left={
          peer ? (
            <Avatar user={peerUser ?? peer} size={36} presence={presence} ringColor={colors.bg} />
          ) : (
            <View style={styles.headerIcon}>
              <Icon name={conv.kind === 'voice' ? 'volume' : channel ? 'hash' : 'users'} size={20} color={colors.text} />
            </View>
          )
        }
        right={
          <>
            {callsEnabled && !channel && myCallConv !== conversationId && (
              <>
                <IconButton name="phone" label="Chamada de voz" filled color={colors.text} onPress={() => void startCall(false)} />
                <IconButton name="video" label="Chamada de vídeo" filled color={colors.text} onPress={() => void startCall(true)} />
              </>
            )}
            {myCallConv === conversationId && (
              <IconButton name="phone" label="Abrir chamada" filled color={colors.success} onPress={() => nav.push({ name: 'call' })} />
            )}
          </>
        }
      />
      {activeCall && activeCall.participants.length > 0 && myCallConv !== conversationId && (
        <Pressable style={styles.joinBar} onPress={() => void startCall(false)}>
          <Icon name="volume" size={18} color={colors.success} />
          <Text style={[common.text, { flex: 1, fontWeight: '600' }]}>
            Chamada em andamento · {activeCall.participants.length}
          </Text>
          <Text style={styles.joinText}>Entrar</Text>
        </Pressable>
      )}
      <View style={[common.panel, styles.chatPanel]}>
        <FlatList
          inverted
          data={data}
          keyExtractor={(m) => m.id}
          onEndReached={() => hasMore && void client().loadOlder(conversationId)}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingVertical: space.sm }}
          ListFooterComponent={hasMore ? undefined : <ChatStart title={title} channel={channel} dm={!!peer} />}
          renderItem={({ item, index }) => {
            const older = data[index + 1];
            const newDay = !older || !sameDay(older.created_at, item.created_at);
            const compact =
              !newDay &&
              !!older &&
              older.author_id === item.author_id &&
              item.created_at - older.created_at < 300_000 &&
              !item.reply_to;
            return (
              <View>
                {newDay && <DaySeparator at={item.created_at} />}
                <MessageRow message={item} compact={compact} onLongPress={() => setActionsFor(item)} />
              </View>
            );
          }}
        />
        <Typing conversationId={conversationId} />
      </View>
      {!canSend ? (
        <View style={[common.panel, styles.readOnly]}>
          <Icon name="lock" size={16} />
          <Text style={[common.muted, { flex: 1 }]}>Você não tem permissão para enviar mensagens em #{conv.name}.</Text>
        </View>
      ) : (
        <Composer
          conversationId={conversationId}
          placeholder={channel ? `Conversar em #${conv.name}` : `Mensagem para ${title}`}
          canAttach={canAttach}
          replyTo={replyTo}
          editing={editing}
          onDone={() => {
            setReplyTo(null);
            setEditing(null);
          }}
        />
      )}
      {actionsFor && (
        <Actions
          message={actionsFor}
          onClose={() => setActionsFor(null)}
          onReply={() => setReplyTo(actionsFor)}
          onEdit={() => setEditing(actionsFor)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

/** Top of the history (shown once everything is loaded). */
function ChatStart({ title, channel, dm }: { title: string; channel: boolean; dm: boolean }) {
  return (
    <View style={styles.start}>
      <View style={styles.startIcon}>
        <Gradient radius={28} />
        <Icon name={channel ? 'hash' : dm ? 'message' : 'users'} size={26} color="#fff" />
      </View>
      <Text style={styles.startTitle}>{channel ? `Bem-vindo a #${title}` : title}</Text>
      <Text style={[common.muted, { textAlign: 'center' }]}>
        {channel ? 'Este é o começo do canal.' : dm ? 'Este é o começo da conversa de vocês.' : 'Este é o começo do grupo.'}
      </Text>
    </View>
  );
}

function DaySeparator({ at }: { at: number }) {
  return (
    <View style={styles.dayRow}>
      <View style={styles.dayLine} />
      <Text style={styles.day}>{formatDay(at)}</Text>
      <View style={styles.dayLine} />
    </View>
  );
}

const MessageRow = memo(function MessageRow({
  message: m,
  compact,
  onLongPress,
}: {
  message: ClientMessage;
  compact: boolean;
  onLongPress: () => void;
}) {
  const author = useNexus((s) => s.users[m.author_id]);
  const myId = useNexus((s) => s.me?.id);
  // Server channels: nickname and role color.
  const authorName = useNexus((s) => {
    const sid = s.conversations[m.conversation_id]?.server_id;
    return sid ? memberName(s, s.servers[sid], m.author_id) : (s.users[m.author_id]?.display_name ?? 'Usuário');
  });
  const authorColor = useNexus((s) => {
    const sid = s.conversations[m.conversation_id]?.server_id;
    const sv = sid ? s.servers[sid] : undefined;
    return sv ? memberColor(sv, m.author_id) : undefined;
  });
  const replyAuthor = useNexus((s) => (m.reply_to ? s.users[m.reply_to.author_id]?.display_name : undefined));
  const blocked = useNexus((s) => !!s.blocked[m.author_id]);
  if (blocked) return <Text style={[common.faint, { paddingHorizontal: space.md, paddingVertical: 4 }]}>Mensagem de usuário bloqueado</Text>;
  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={280}
      android_ripple={{ color: colors.surfaceHover }}
      style={[styles.message, compact && { paddingTop: 1 }, m.local === 'sending' && { opacity: 0.65 }]}
    >
      {m.reply_to && (
        <View style={styles.replyRow}>
          <View style={styles.replyCurve} />
          <Text style={styles.replyText} numberOfLines={1}>
            <Text style={{ fontWeight: '700', color: colors.textMuted }}>{replyAuthor ?? '?'} </Text>
            {m.reply_to.content || 'Anexo'}
          </Text>
        </View>
      )}
      <View style={styles.messageBody}>
        <View style={{ width: 40 }}>{!compact && <Avatar user={author} size={40} />}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {!compact && (
            <View style={[common.row, { gap: 8 }]}>
              <Text style={[styles.author, authorColor ? { color: authorColor } : null]} numberOfLines={1}>
                {authorName}
              </Text>
              <Text style={styles.time}>{formatTime(m.created_at)}</Text>
            </View>
          )}
          {!!m.content && (
            <Text style={[styles.content, m.local === 'failed' && { color: colors.danger }]} selectable={false}>
              {m.content}
              {m.edited_at ? <Text style={styles.time}> (editada)</Text> : null}
            </Text>
          )}
          {m.local === 'failed' && <Text style={common.error}>Falha ao enviar. Segure para descartar.</Text>}
          {m.local === 'sending' && m.upload && (
            <View style={styles.upload}>
              <Text style={common.faint} numberOfLines={1}>
                Enviando {m.upload.file} · {Math.floor((m.upload.sent / Math.max(1, m.upload.total)) * 100)}% de{' '}
                {formatBytes(m.upload.total)}
              </Text>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${(m.upload.sent / Math.max(1, m.upload.total)) * 100}%` }]} />
              </View>
            </View>
          )}
          {m.attachments.length > 0 && (
            <View style={{ gap: 6, marginTop: 4 }}>
              {m.attachments.map((a) => (
                <AttachmentView key={a.id} a={a} conversationId={m.conversation_id} />
              ))}
            </View>
          )}
          {m.reactions.length > 0 && (
            <View style={styles.reactions}>
              {m.reactions.map((r) => {
                const mine = !!myId && r.user_ids.includes(myId);
                return (
                  <Pressable
                    key={r.emoji}
                    onPress={() => void client().toggleReaction(m.conversation_id, m.id, r.emoji)}
                    style={[styles.reaction, mine && styles.reactionMine]}
                  >
                    <Text style={{ fontSize: 15 }}>{r.emoji}</Text>
                    <Text style={[styles.reactionCount, mine && { color: colors.text }]}>{r.user_ids.length}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
});

function AttachmentView({ a, conversationId }: { a: Attachment; conversationId: Id }) {
  const { width } = useWindowDimensions();
  const url = client().api.url(a.url) ?? '';
  const max = Math.min(width - 96, 320);
  const kind = mediaKind(a);
  if (kind === 'image') {
    const w = a.width ?? 320;
    const h = a.height ?? 240;
    const scale = Math.min(1, max / w, 320 / h);
    return (
      <Pressable onPress={() => openImage(conversationId, a.id)} style={({ pressed }) => pressed && { opacity: 0.85 }}>
        <Image source={{ uri: url }} style={[styles.image, { width: Math.max(80, w * scale), height: Math.max(60, h * scale) }]} />
      </Pressable>
    );
  }
  if (kind === 'voice' || kind === 'audio') return <AudioRow a={a} url={url} voice={kind === 'voice'} />;
  if (kind === 'video') {
    const ratio = a.width && a.height ? a.width / a.height : 16 / 9;
    const w = max;
    const h = Math.min(260, Math.max(140, w / ratio));
    return (
      <Pressable onPress={() => openVideo(a)} style={({ pressed }) => [styles.video, { width: w, height: h }, pressed && { opacity: 0.9 }]}>
        <Gradient from="#141833" to="#05060c" radius={radius.md} />
        <View style={styles.videoPlay}>
          <Gradient radius={30} />
          <SolidIcon name="play" size={26} color="#fff" />
        </View>
        <View style={styles.videoInfo}>
          <Icon name="video" size={14} color="rgba(255,255,255,0.8)" />
          <Text style={styles.videoName} numberOfLines={1}>
            {a.file_name}
          </Text>
          <Text style={styles.videoSize}>{formatBytes(a.size)}</Text>
        </View>
      </Pressable>
    );
  }
  return (
    <Pressable style={({ pressed }) => [styles.file, { maxWidth: max }, pressed && { opacity: 0.85 }]} onPress={() => void Linking.openURL(url)}>
      <View style={styles.fileIcon}>
        <Icon name="file" size={22} color={colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.fileName} numberOfLines={1}>
          {a.file_name}
        </Text>
        <Text style={common.faint}>{formatBytes(a.size)}</Text>
      </View>
      <Icon name="external" size={18} />
    </Pressable>
  );
}

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

/** Voice message / audio file: play-pause, tap the bar to seek. */
function AudioRow({ a, url, voice }: { a: Attachment; url: string; voice: boolean }) {
  const mine = useChatAudio((s) => s.id === a.id);
  const state = useChatAudio((s) => (s.id === a.id ? s.state : 'idle'));
  const position = useChatAudio((s) => (s.id === a.id ? s.position : 0));
  const duration = useChatAudio((s) => (s.id === a.id ? s.duration : 0));
  const [width, setWidth] = useState(1);
  const playing = state === 'playing' || state === 'loading';
  const pct = duration ? Math.min(1, position / duration) : 0;
  return (
    <View style={[styles.audio, voice && styles.voice]}>
      <Pressable style={styles.audioPlay} onPress={() => toggleAudio(a.id, url)} accessibilityLabel={playing ? 'Pausar' : 'Tocar'}>
        <Gradient radius={20} />
        {state === 'loading' ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <SolidIcon name={playing ? 'pause' : 'play'} size={18} color="#fff" />
        )}
      </Pressable>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={[common.text, { fontWeight: '600', fontSize: 14 }]} numberOfLines={1}>
          {voice ? 'Mensagem de voz' : a.file_name}
        </Text>
        <Pressable
          onLayout={(e) => setWidth(e.nativeEvent.layout.width || 1)}
          onPress={(e) => mine && duration && seekAudio(a.id, (e.nativeEvent.locationX / width) * duration)}
          hitSlop={10}
          style={styles.track}
        >
          <View style={[styles.fill, { width: `${pct * 100}%` }]} />
        </Pressable>
        <Text style={common.faint}>
          {state === 'error'
            ? 'Não foi possível tocar'
            : `${fmtMs(position)}${duration ? ` / ${fmtMs(Math.round(duration / 1000) * 1000)}` : ''}`}
          {!voice ? ` · ${formatBytes(a.size)}` : ''}
        </Text>
      </View>
    </View>
  );
}

function Typing({ conversationId }: { conversationId: Id }) {
  const names = useNexus((s) =>
    typingUsers(s, conversationId)
      .map((id) => s.users[id]?.display_name ?? 'Alguém')
      .join(', '),
  );
  return (
    <Text style={styles.typing} numberOfLines={1}>
      {names ? `${names} está digitando…` : ' '}
    </Text>
  );
}

function Composer({
  conversationId,
  placeholder,
  canAttach,
  replyTo,
  editing,
  onDone,
}: {
  conversationId: Id;
  placeholder: string;
  canAttach: boolean;
  replyTo: ClientMessage | null;
  editing: ClientMessage | null;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastEditing, setLastEditing] = useState<string | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
  const replyName = useNexus((s) => (replyTo ? (s.users[replyTo.author_id]?.display_name ?? '') : ''));
  if (editing && editing.id !== lastEditing) {
    setLastEditing(editing.id);
    setText(editing.content);
  }

  async function send() {
    const content = text.trim();
    setError(null);
    try {
      if (editing) {
        await client().editMessage(conversationId, editing.id, content);
      } else {
        if (!content && files.length === 0) return;
        const toSend = files;
        setFiles([]);
        setText('');
        onDone();
        await client().sendMessage(conversationId, content, {
          replyTo: replyTo?.id ?? null,
          files: toSend.map((f) => ({ file: { uri: f.uri, name: f.name, type: f.type }, name: f.name })),
        });
        return;
      }
      setText('');
      setLastEditing(null);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function startVoice() {
    setError(null);
    const perm = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (perm !== PermissionsAndroid.RESULTS.GRANTED) {
      setError('Permita o acesso ao microfone para gravar.');
      return;
    }
    try {
      await NexusNative.voiceStart();
      setRecording(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function finishVoice(sendIt: boolean) {
    setRecording(null);
    if (!sendIt) {
      NexusNative.voiceCancel();
      return;
    }
    const f = await NexusNative.voiceStop().catch(() => null);
    if (!f || f.durationMs < 700) {
      setError('Gravação muito curta.');
      return;
    }
    try {
      await client().sendMessage(conversationId, '', {
        replyTo: replyTo?.id ?? null,
        files: [{ file: { uri: f.uri, name: f.name, type: f.type }, name: f.name }],
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Clock while recording; leaving the chat discards the recording.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (recording === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => () => NexusNative.voiceCancel(), []);

  if (recording !== null) {
    return (
      <View style={[styles.composer, styles.recording]}>
        <IconButton name="trash" label="Cancelar gravação" danger filled onPress={() => void finishVoice(false)} />
        <View style={styles.recDot} />
        <Text style={[common.text, { fontWeight: '800', fontVariant: ['tabular-nums'] }]}>{fmtMs(Date.now() - recording)}</Text>
        <Text style={[common.muted, { flex: 1 }]}>Gravando…</Text>
        <Pressable style={styles.sendButton} onPress={() => void finishVoice(true)} accessibilityLabel="Enviar mensagem de voz">
          <Gradient radius={21} />
          <Icon name="send" size={20} color="#fff" />
        </Pressable>
      </View>
    );
  }

  const canSendNow = !!text.trim() || files.length > 0 || !!editing;
  return (
    <View style={styles.composerWrap}>
      {(replyTo || editing) && (
        <View style={styles.contextBar}>
          <Icon name={editing ? 'edit' : 'reply'} size={14} color={colors.accent} />
          <Text style={[common.muted, { flex: 1 }]} numberOfLines={1}>
            {editing ? 'Editando mensagem' : `Respondendo a ${replyName}: ${replyTo?.content || 'Anexo'}`}
          </Text>
          <IconButton
            name="x"
            size={16}
            label="Cancelar"
            onPress={() => {
              setText('');
              setLastEditing(null);
              onDone();
            }}
          />
        </View>
      )}
      {files.length > 0 && (
        <View style={styles.chips}>
          {files.map((f, i) => (
            <View key={`${f.uri}${i}`} style={styles.chip}>
              {f.type.startsWith('image/') ? (
                <Image source={{ uri: f.uri }} style={styles.chipThumb} />
              ) : (
                <Icon name={f.type.startsWith('video/') ? 'video' : 'file'} size={18} color={colors.accent} />
              )}
              <View style={{ maxWidth: 140 }}>
                <Text style={[common.text, { fontSize: 13 }]} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={common.faint}>{formatBytes(f.size)}</Text>
              </View>
              <Pressable hitSlop={8} onPress={() => setFiles((prev) => prev.filter((_, j) => j !== i))} accessibilityLabel="Remover">
                <Icon name="x" size={16} />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {error && <Text style={[common.error, { paddingHorizontal: space.md }]}>{error}</Text>}
      <View style={styles.composer}>
        {canAttach && !editing && (
          <Pressable
            style={styles.attachButton}
            accessibilityLabel="Anexar"
            onPress={() => void NexusNative.pickFiles().then((f) => setFiles((prev) => [...prev, ...f].slice(0, 10)))}
          >
            <Icon name="plus" size={22} color={colors.text} />
          </Pressable>
        )}
        <TextInput
          style={styles.input}
          multiline
          value={text}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          onChangeText={(t) => {
            setText(t);
            if (t) client().typing(conversationId);
          }}
          maxLength={4000}
        />
        {canSendNow ? (
          <Pressable style={styles.sendButton} onPress={() => void send()} accessibilityLabel={editing ? 'Salvar' : 'Enviar'}>
            <Gradient radius={21} />
            <Icon name={editing ? 'check' : 'send'} size={20} color="#fff" />
          </Pressable>
        ) : canAttach ? (
          <Pressable style={styles.micButton} onPress={() => void startVoice()} accessibilityLabel="Gravar mensagem de voz">
            <Icon name="mic" size={22} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function Actions({
  message,
  onClose,
  onReply,
  onEdit,
}: {
  message: ClientMessage;
  onClose: () => void;
  onReply: () => void;
  onEdit: () => void;
}) {
  const myId = useNexus((s) => s.me?.id);
  const conv = useNexus((s) => s.conversations[message.conversation_id]);
  const mine = message.author_id === myId;
  const channel = !!conv && isChannel(conv);
  const canReact = !channel || hasPermission(conv?.permissions, Permissions.ADD_REACTIONS);
  const canDelete =
    mine || conv?.owner_id === myId || (channel && hasPermission(conv?.permissions, Permissions.MANAGE_MESSAGES));
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet onClose={onClose}>
      {canReact && !message.local && (
        <View style={styles.reactRow}>
          {QUICK_REACTIONS.map((e) => (
            <Pressable
              key={e}
              style={({ pressed }) => [styles.reactButton, pressed && { transform: [{ scale: 1.15 }] }]}
              onPress={act(() => void client().toggleReaction(message.conversation_id, message.id, e))}
            >
              <Text style={{ fontSize: 24 }}>{e}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {!message.local && <SheetItem icon="reply" label="Responder" onPress={act(onReply)} />}
      {mine && !message.local && !!message.content && <SheetItem icon="edit" label="Editar mensagem" onPress={act(onEdit)} />}
      {!!message.content && (
        <SheetItem icon="copy" label="Copiar texto" onPress={act(() => NexusNative.copyText(message.content))} />
      )}
      {message.local === 'failed' && (
        <SheetItem icon="x" label="Descartar" onPress={act(() => client().discardFailed(message.conversation_id, message.id))} />
      )}
      {canDelete && !message.local && (
        <SheetItem
          icon="trash"
          label="Apagar mensagem"
          danger
          onPress={act(() =>
            Alert.alert('Apagar mensagem?', 'Isso não pode ser desfeito.', [
              { text: 'Cancelar', style: 'cancel' },
              {
                text: 'Apagar',
                style: 'destructive',
                onPress: () => void client().deleteMessage(message.conversation_id, message.id),
              },
            ]),
          )}
        />
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatPanel: { flex: 1, marginHorizontal: space.sm },
  joinBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.sm,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: 'rgba(47,210,122,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(47,210,122,0.35)',
  },
  joinText: { color: colors.success, fontWeight: '800' },
  start: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl, paddingHorizontal: space.lg },
  startIcon: { width: 56, height: 56, borderRadius: 28, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  startTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, marginVertical: space.md },
  dayLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  day: { color: colors.textFaint, fontSize: 12, fontWeight: '700' },
  message: { paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: 2 },
  messageBody: { flexDirection: 'row', gap: space.md },
  replyRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 18, marginBottom: 2 },
  replyCurve: {
    width: 22,
    height: 10,
    marginTop: 8,
    borderTopLeftRadius: 6,
    borderLeftWidth: 2,
    borderTopWidth: 2,
    borderColor: colors.border,
  },
  replyText: { flex: 1, color: colors.textFaint, fontSize: 13 },
  author: { color: colors.text, fontWeight: '700', fontSize: 15, flexShrink: 1 },
  time: { color: colors.textFaint, fontSize: 11 },
  content: { color: colors.text, fontSize: 15, lineHeight: 21 },
  image: { borderRadius: radius.md, backgroundColor: colors.surfaceRaised },
  video: { borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  videoPlay: { width: 60, height: 60, borderRadius: 30, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', paddingLeft: 3, elevation: 4 },
  videoInfo: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  videoName: { color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 },
  videoSize: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  audio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.sm,
    paddingRight: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 320,
  },
  voice: { borderRadius: 26 },
  audioPlay: { width: 40, height: 40, borderRadius: 20, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  track: { height: 5, borderRadius: 3, backgroundColor: colors.surfaceHover, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.accent },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: space.sm,
    paddingRight: space.md,
  },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: 'rgba(84,104,245,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileName: { color: colors.text, fontWeight: '600', fontSize: 14 },
  upload: { marginTop: 6, gap: 4 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  reaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.round,
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: colors.surfaceRaised,
  },
  reactionMine: { borderColor: colors.accent, backgroundColor: 'rgba(84,104,245,0.18)' },
  reactionCount: { color: colors.textMuted, fontWeight: '700', fontSize: 13 },
  typing: { color: colors.textMuted, fontSize: 12, paddingHorizontal: space.md, paddingBottom: 4, height: 20 },
  readOnly: { flexDirection: 'row', alignItems: 'center', gap: space.sm, margin: space.sm, padding: space.md },
  composerWrap: { paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.sm, gap: 6 },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: 6,
    paddingRight: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipThumb: { width: 36, height: 36, borderRadius: 8 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    padding: 5,
    borderRadius: 26,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recording: { alignItems: 'center', marginHorizontal: space.sm, marginBottom: space.sm, gap: space.md, paddingLeft: space.xs },
  attachButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  sendButton: { width: 42, height: 42, borderRadius: 21, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, color: colors.text, fontSize: 15, maxHeight: 130, paddingVertical: 10, paddingHorizontal: 6 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  reactRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: space.md,
    marginBottom: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  reactButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
