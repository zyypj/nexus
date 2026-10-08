import { type Attachment, type Id, Permissions, hasPermission, isChannel } from '@nexus/protocol';
import {
  type ClientMessage,
  callForConversation,
  conversationTitle,
  dmPeer,
  formatBytes,
  formatDay,
  formatTime,
  sameDay,
  typingUsers,
  memberColor,
  memberName,
} from '@nexus/shared';
import { QUICK_REACTIONS } from '@nexus/ui';
import React, { memo, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  PermissionsAndroid,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Nav } from '../App';
import { calls, useCall } from '../call/callManager';
import { client, useNexus } from '../lib/nexus';
import { NexusNative, type PickedFile } from '../native/NexusNative';
import { Avatar, Icon, IconButton } from '../ui/components';
import { colors, common, space } from '../ui/theme';
import { seekAudio, toggleAudio, useChatAudio } from '../lib/chatAudio';

const EMPTY: ClientMessage[] = [];

export function ChatScreen({ conversationId, nav }: { conversationId: Id; nav: Nav }) {
  const conv = useNexus((s) => s.conversations[conversationId]);
  const title = useNexus((s) => (conv ? conversationTitle(s, conv) : ''));
  const peer = useNexus((s) => (conv?.kind === 'dm' ? dmPeer(s, conv) : undefined));
  const presence = useNexus((s) => (peer ? (s.presences[peer.id] ?? 'offline') : undefined));
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
  const canSend = !channel || hasPermission(conv.permissions, Permissions.SEND_MESSAGES);

  const startCall = async (video: boolean) => {
    if (activeCall) await calls.join(activeCall.id);
    else await calls.start(conversationId, video);
    nav.push({ name: 'call' });
  };

  return (
    <KeyboardAvoidingView style={common.screen} behavior="height">
      <View style={common.header}>
        <IconButton name="reply" label="Voltar" onPress={nav.back} />
        {peer ? <Avatar user={peer} size={32} presence={presence} /> : <Icon name={conv.kind === 'voice' ? 'volume' : 'hash'} />}
        <Text style={common.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {callsEnabled && !channel && myCallConv !== conversationId && (
          <>
            <IconButton name="phone" label="Chamada de voz" onPress={() => void startCall(false)} />
            <IconButton name="video" label="Chamada de vídeo" onPress={() => void startCall(true)} />
          </>
        )}
        {myCallConv === conversationId && (
          <IconButton name="phone" active label="Abrir chamada" onPress={() => nav.push({ name: 'call' })} />
        )}
      </View>
      {activeCall && activeCall.participants.length > 0 && myCallConv !== conversationId && (
        <Pressable style={styles.joinBar} onPress={() => void startCall(false)}>
          <Text style={common.text}>Chamada em andamento · {activeCall.participants.length} · Toque para entrar</Text>
        </Pressable>
      )}
      <FlatList
        inverted
        data={data}
        keyExtractor={(m) => m.id}
        onEndReached={() => hasMore && void client().loadOlder(conversationId)}
        onEndReachedThreshold={0.5}
        renderItem={({ item, index }) => {
          const older = data[index + 1];
          const newDay = !older || !sameDay(older.created_at, item.created_at);
          const compact =
            !newDay && !!older && older.author_id === item.author_id && item.created_at - older.created_at < 300_000 && !item.reply_to;
          return (
            <View>
              {newDay && <Text style={styles.day}>{formatDay(item.created_at)}</Text>}
              <MessageRow message={item} compact={compact} onLongPress={() => setActionsFor(item)} />
            </View>
          );
        }}
      />
      <Typing conversationId={conversationId} />
      {!canSend ? (
        <Text style={[common.muted, { padding: space.md, textAlign: 'center' }]}>
          Você não tem permissão para enviar mensagens em #{conv.name}.
        </Text>
      ) : (
      <Composer
        conversationId={conversationId}
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
  if (blocked) return <Text style={[common.muted, { paddingHorizontal: space.md }]}>Mensagem de usuário bloqueado</Text>;
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={300} style={[styles.message, compact && { paddingTop: 2 }]}>
      <View style={{ width: 38 }}>{!compact && <Avatar user={author} size={38} />}</View>
      <View style={{ flex: 1 }}>
        {m.reply_to && (
          <Text style={common.muted} numberOfLines={1}>
            ↩ {replyAuthor}: {m.reply_to.content || 'Anexo'}
          </Text>
        )}
        {!compact && (
          <View style={common.row}>
            <Text style={[styles.author, authorColor ? { color: authorColor } : null]}>{authorName}</Text>
            <Text style={styles.time}>{formatTime(m.created_at)}</Text>
          </View>
        )}
        {!!m.content && (
          <Text style={[common.text, m.local === 'failed' && { color: colors.danger }, m.local === 'sending' && { opacity: 0.6 }]}>
            {m.content}
            {m.edited_at ? <Text style={styles.time}> (editada)</Text> : null}
          </Text>
        )}
        {m.local === 'sending' && m.upload && (
          <View style={styles.upload}>
            <Text style={common.muted} numberOfLines={1}>
              Enviando {m.upload.file} · {Math.floor((m.upload.sent / Math.max(1, m.upload.total)) * 100)}% de{' '}
              {formatBytes(m.upload.total)}
            </Text>
            <View style={styles.uploadTrack}>
              <View style={[styles.uploadFill, { width: `${(m.upload.sent / Math.max(1, m.upload.total)) * 100}%` }]} />
            </View>
          </View>
        )}
        {m.attachments.map((a) => (
          <AttachmentView key={a.id} a={a} />
        ))}
        {m.reactions.length > 0 && (
          <View style={styles.reactions}>
            {m.reactions.map((r) => (
              <Pressable
                key={r.emoji}
                onPress={() => void client().toggleReaction(m.conversation_id, m.id, r.emoji)}
                style={[styles.reaction, myId && r.user_ids.includes(myId) ? styles.reactionMine : null]}
              >
                <Text style={common.text}>
                  {r.emoji} <Text style={common.muted}>{r.user_ids.length}</Text>
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </Pressable>
  );
});

function AttachmentView({ a }: { a: Attachment }) {
  const url = client().api.url(a.url) ?? '';
  if (a.content_type.startsWith('image/')) {
    const w = a.width ?? 320;
    const h = a.height ?? 240;
    const scale = Math.min(1, 260 / w, 260 / h);
    return (
      <Pressable onPress={() => void Linking.openURL(url)}>
        <Image source={{ uri: url }} style={{ width: w * scale, height: h * scale, borderRadius: 10, marginTop: 4 }} />
      </Pressable>
    );
  }
  const kind = mediaKind(a);
  if (kind === 'voice' || kind === 'audio') return <AudioRow a={a} url={url} voice={kind === 'voice'} />;
  if (kind === 'video') {
    // Opens in the phone's video player (inline playback would need a native video view).
    return (
      <Pressable style={styles.video} onPress={() => void Linking.openURL(url)}>
        <View style={styles.videoPlay}>
          <View style={styles.playGlyph} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={common.text} numberOfLines={1}>
            {a.file_name}
          </Text>
          <Text style={common.muted}>Vídeo · {formatBytes(a.size)} · toque para assistir</Text>
        </View>
      </Pressable>
    );
  }
  return (
    <Pressable style={styles.file} onPress={() => void Linking.openURL(url)}>
      <Icon name="file" />
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.accent }} numberOfLines={1}>
          {a.file_name}
        </Text>
        <Text style={common.muted}>{formatBytes(a.size)}</Text>
      </View>
    </Pressable>
  );
}

const VOICE_PREFIX = 'mensagem-de-voz';
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']);

function mediaKind(a: Attachment): 'voice' | 'audio' | 'video' | null {
  if (a.file_name.startsWith(VOICE_PREFIX)) return 'voice';
  if (VIDEO_TYPES.has(a.content_type)) return 'video';
  if (a.content_type.startsWith('audio/')) return 'audio';
  return null;
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
        {state === 'loading' ? (
          <ActivityIndicator color={colors.accentText} size="small" />
        ) : playing ? (
          <View style={styles.pauseGlyph} />
        ) : (
          <View style={styles.playGlyph} />
        )}
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[common.text, { fontWeight: '600' }]} numberOfLines={1}>
          {voice ? 'Mensagem de voz' : a.file_name}
        </Text>
        <Pressable
          onLayout={(e) => setWidth(e.nativeEvent.layout.width || 1)}
          onPress={(e) => mine && duration && seekAudio(a.id, (e.nativeEvent.locationX / width) * duration)}
          hitSlop={8}
          style={styles.audioTrack}
        >
          <View style={[styles.audioFill, { width: `${pct * 100}%` }]} />
        </Pressable>
        <Text style={common.muted}>
          {state === 'error' ? 'Não foi possível tocar' : `${fmtMs(position)}${duration ? ` / ${fmtMs(Math.round(duration / 1000) * 1000)}` : ''}`}
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
  return <Text style={styles.typing}>{names ? `${names} digitando…` : ' '}</Text>;
}

function Composer({
  conversationId,
  replyTo,
  editing,
  onDone,
}: {
  conversationId: Id;
  replyTo: ClientMessage | null;
  editing: ClientMessage | null;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastEditing, setLastEditing] = useState<string | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
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

  async function finishVoice(send: boolean) {
    setRecording(null);
    if (!send) {
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
      <View style={[styles.composer, common.row, { gap: space.md, paddingHorizontal: space.sm }]}>
        <IconButton name="trash" label="Cancelar gravação" danger onPress={() => void finishVoice(false)} />
        <View style={styles.recDot} />
        <Text style={[common.text, { fontWeight: '700' }]}>{fmtMs(Date.now() - recording)}</Text>
        <Text style={[common.muted, { flex: 1 }]}>Gravando…</Text>
        <Pressable style={[common.button, { paddingHorizontal: space.lg }]} onPress={() => void finishVoice(true)}>
          <Text style={common.buttonText}>Enviar</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.composer}>
      {(replyTo || editing) && (
        <View style={[common.row, { gap: space.sm, paddingHorizontal: space.sm }]}>
          <Text style={[common.muted, { flex: 1 }]} numberOfLines={1}>
            {editing ? 'Editando mensagem' : `Respondendo: ${replyTo?.content || 'Anexo'}`}
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
        <Text style={[common.muted, { paddingHorizontal: space.sm }]}>
          {files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ')}
        </Text>
      )}
      {error && <Text style={[common.error, { paddingHorizontal: space.sm }]}>{error}</Text>}
      <View style={common.row}>
        <IconButton
          name="paperclip"
          label="Anexar"
          onPress={() => void NexusNative.pickFiles().then((f) => setFiles((prev) => [...prev, ...f].slice(0, 10)))}
        />
        <TextInput
          style={styles.input}
          multiline
          value={text}
          placeholder="Escreva uma mensagem"
          placeholderTextColor={colors.textFaint}
          onChangeText={(t) => {
            setText(t);
            if (t) client().typing(conversationId);
          }}
          maxLength={4000}
        />
        {!text.trim() && files.length === 0 && !editing ? (
          <IconButton name="mic" label="Gravar mensagem de voz" onPress={() => void startVoice()} />
        ) : (
          <IconButton name="send" active label="Enviar" onPress={() => void send()} />
        )}
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
  const isOwner = useNexus((s) => s.conversations[message.conversation_id]?.owner_id === s.me?.id);
  const mine = message.author_id === myId;
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <View style={styles.sheet}>
          <View style={[common.row, { justifyContent: 'space-around' }]}>
            {QUICK_REACTIONS.map((e) => (
              <Pressable key={e} onPress={act(() => void client().toggleReaction(message.conversation_id, message.id, e))}>
                <Text style={{ fontSize: 26 }}>{e}</Text>
              </Pressable>
            ))}
          </View>
          <SheetItem label="Responder" onPress={act(onReply)} />
          {mine && <SheetItem label="Editar" onPress={act(onEdit)} />}
          {(mine || isOwner) && (
            <SheetItem
              label="Apagar"
              danger
              onPress={act(() => void client().deleteMessage(message.conversation_id, message.id))}
            />
          )}
          {message.local === 'failed' && (
            <SheetItem label="Descartar" onPress={act(() => client().discardFailed(message.conversation_id, message.id))} />
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

function SheetItem({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable style={styles.sheetItem} onPress={onPress}>
      <Text style={[common.text, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  audio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: 4,
    padding: space.sm,
    borderRadius: 12,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 320,
  },
  voice: { borderRadius: 24 },
  audioPlay: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: {
    width: 0,
    height: 0,
    marginLeft: 3,
    borderLeftWidth: 12,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    borderLeftColor: colors.accentText,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  pauseGlyph: { width: 12, height: 14, borderLeftWidth: 4, borderRightWidth: 4, borderColor: colors.accentText },
  audioTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceHover, overflow: 'hidden' },
  audioFill: { height: '100%', backgroundColor: colors.accent },
  video: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: 4,
    padding: space.sm,
    borderRadius: 12,
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 320,
  },
  videoPlay: {
    width: 56,
    height: 40,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  upload: { marginTop: 6, gap: 4 },
  uploadTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceHover, overflow: 'hidden' },
  uploadFill: { height: '100%', backgroundColor: colors.accent },
  joinBar: { backgroundColor: 'rgba(63,185,80,0.18)', padding: space.sm, alignItems: 'center' },
  day: { color: colors.textFaint, textAlign: 'center', fontSize: 12, marginVertical: space.sm },
  message: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm },
  author: { color: colors.text, fontWeight: '700', marginRight: 6 },
  time: { color: colors.textFaint, fontSize: 11 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reaction: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: colors.surfaceRaised,
  },
  reactionMine: { borderColor: colors.accent },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: space.sm,
    marginTop: 4,
  },
  typing: { color: colors.textMuted, fontSize: 12, paddingHorizontal: space.md, height: 18 },
  composer: {
    margin: space.sm,
    backgroundColor: colors.surfaceRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 2,
  },
  input: { flex: 1, color: colors.text, fontSize: 15, maxHeight: 120, paddingVertical: 8 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, padding: space.lg, gap: space.sm, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  sheetItem: { paddingVertical: 12 },
});
