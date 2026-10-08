import { VideoTrack } from '@livekit/react-native';
import { conversationTitle } from '@nexus/shared';
import { Track } from 'livekit-client';
import React, { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Nav } from '../App';
import { type ParticipantView, calls, useCall } from '../call/callManager';
import { useNexus } from '../lib/nexus';
import { Avatar, Icon, IconButton } from '../ui/components';
import { colors, common, space } from '../ui/theme';

export function CallScreen({ nav }: { nav: Nav }) {
  const s = useCall();
  const title = useNexus((st) => {
    const c = s.conversationId ? st.conversations[s.conversationId] : undefined;
    return c ? conversationTitle(st, c) : '';
  });
  const [shareMenu, setShareMenu] = useState(false);
  const [volumeFor, setVolumeFor] = useState<ParticipantView | null>(null);
  const sharer = s.participants.find((p) => p.hasScreen && !p.isLocal);

  if (s.status === 'idle') {
    return (
      <View style={[common.screen, { alignItems: 'center', justifyContent: 'center', gap: space.md }]}>
        <Text style={common.text}>Chamada encerrada</Text>
        {s.error && <Text style={common.error}>{s.error}</Text>}
        <Pressable style={common.buttonSecondary} onPress={nav.back}>
          <Text style={common.text}>Voltar</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[common.screen, { backgroundColor: '#070a0e' }]}>
      <View style={common.header}>
        <IconButton name="reply" label="Voltar" onPress={nav.back} />
        <View style={{ flex: 1 }}>
          <Text style={common.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={{ color: s.status === 'connected' ? colors.success : colors.highlight, fontSize: 12 }}>
            {s.status === 'connected' ? 'Conectado' : s.status === 'connecting' ? 'Conectando…' : 'Reconectando…'}
          </Text>
        </View>
      </View>
      {s.error && (
        <Pressable onPress={() => useCall.setState({ error: null })}>
          <Text style={[common.error, { padding: space.sm }]}>{s.error}</Text>
        </Pressable>
      )}
      {s.captureBlocked && (
        <Text style={styles.warn}>Este aplicativo não permite que seu áudio seja compartilhado.</Text>
      )}
      {sharer && (
        <View style={styles.screenShare}>
          <VideoTrack
            trackRef={calls.trackRef(sharer.identity, Track.Source.ScreenShare)}
            objectFit="contain"
            style={{ flex: 1 }}
          />
        </View>
      )}
      <FlatList
        key={sharer ? 'strip' : 'grid'}
        data={s.participants}
        numColumns={sharer ? 4 : 2}
        keyExtractor={(p) => p.identity}
        contentContainerStyle={{ padding: space.sm, gap: space.sm }}
        columnWrapperStyle={{ gap: space.sm }}
        renderItem={({ item }) => (
          <Tile p={item} small={!!sharer} version={s.version} onLongPress={() => !item.isLocal && setVolumeFor(item)} />
        )}
      />
      <View style={styles.controls}>
        <Control name={s.muted ? 'micOff' : 'mic'} danger={s.muted} label="Microfone" onPress={() => void calls.toggleMute()} />
        <Control
          name={s.deafened ? 'headphonesOff' : 'headphones'}
          danger={s.deafened}
          label="Ensurdecer"
          onPress={() => void calls.toggleDeafen()}
        />
        <Control
          name={s.cameraOn ? 'video' : 'videoOff'}
          active={s.cameraOn}
          label="Câmera"
          onPress={() => void calls.setCamera(!s.cameraOn)}
        />
        <Control
          name="screen"
          active={s.screenOn}
          label="Compartilhar tela"
          onPress={() => (s.screenOn ? void calls.stopScreenShare() : setShareMenu(true))}
        />
        <Control
          name="phoneOff"
          danger
          label="Sair"
          onPress={async () => {
            await calls.leave();
            nav.back();
          }}
        />
      </View>
      {shareMenu && (
        <Modal transparent animationType="fade" onRequestClose={() => setShareMenu(false)}>
          <Pressable style={styles.backdrop} onPress={() => setShareMenu(false)}>
            <View style={styles.sheet}>
              <Text style={common.headerTitle}>Compartilhar tela</Text>
              <SheetButton
                label="Só a tela"
                onPress={() => {
                  setShareMenu(false);
                  void calls.startScreenShare(false);
                }}
              />
              <SheetButton
                label="Tela + áudio do aparelho"
                onPress={() => {
                  setShareMenu(false);
                  void calls.startScreenShare(true);
                }}
              />
              <Text style={common.muted}>
                O áudio de outros apps (Android 10+) é enviado sem o som da chamada. Apps que proíbem a captura não serão
                ouvidos.
              </Text>
            </View>
          </Pressable>
        </Modal>
      )}
      {volumeFor && <VolumeSheet p={volumeFor} onClose={() => setVolumeFor(null)} />}
    </View>
  );
}

function Tile({ p, small, onLongPress }: { p: ParticipantView; small: boolean; version: number; onLongPress: () => void }) {
  const user = useNexus((s) => s.users[p.identity]);
  const height = small ? 80 : 180;
  return (
    <Pressable onLongPress={onLongPress} style={[styles.tile, { height }, p.speaking && !p.micMuted && styles.speaking]}>
      {p.hasCamera ? (
        <VideoTrack
          trackRef={calls.trackRef(p.identity, Track.Source.Camera)}
          objectFit="cover"
          mirror={p.isLocal}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <Avatar user={user ?? { id: p.identity, display_name: p.name, avatar_url: null }} size={small ? 40 : 64} />
      )}
      <View style={styles.label}>
        {p.micMuted && <Icon name="micOff" size={12} color={colors.danger} />}
        <Text style={{ color: colors.text, fontSize: 12 }} numberOfLines={1}>
          {user?.display_name ?? p.name}
        </Text>
      </View>
    </Pressable>
  );
}

function Control(props: { name: Parameters<typeof Icon>[0]['name']; onPress: () => void; label: string; danger?: boolean; active?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityLabel={props.label}
      style={[styles.control, props.danger && { backgroundColor: colors.danger }, props.active && { backgroundColor: colors.accent }]}
    >
      <Icon name={props.name} color={props.danger || props.active ? '#fff' : colors.text} />
    </Pressable>
  );
}

function SheetButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={common.buttonSecondary} onPress={onPress}>
      <Text style={common.text}>{label}</Text>
    </Pressable>
  );
}

/** Local-only volume, 0–200%. Long-press a tile to open. */
function VolumeSheet({ p, onClose }: { p: ParticipantView; onClose: () => void }) {
  const volume = useCall((s) => s.volumes[p.identity] ?? 1);
  const pct = Math.round(volume * 100);
  const step = (d: number) => calls.setVolume(p.identity, (pct + d) / 100);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          <Text style={common.headerTitle}>{p.name}</Text>
          <View style={[common.row, { justifyContent: 'space-between' }]}>
            <SheetButton label="−25%" onPress={() => step(-25)} />
            <Text style={[common.text, { fontSize: 22 }]}>{pct}%</Text>
            <SheetButton label="+25%" onPress={() => step(25)} />
          </View>
          <View style={[common.row, { gap: space.sm }]}>
            <SheetButton label="Silenciar" onPress={() => calls.setVolume(p.identity, 0)} />
            <SheetButton label="100%" onPress={() => calls.setVolume(p.identity, 1)} />
          </View>
          <Text style={common.muted}>Só altera o que você ouve.</Text>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  warn: { color: colors.highlight, padding: space.sm, textAlign: 'center' },
  screenShare: { height: 240, backgroundColor: '#000', margin: space.sm, borderRadius: 10, overflow: 'hidden' },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  speaking: { borderColor: colors.speaking },
  label: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: '90%',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: space.md,
    backgroundColor: colors.surface,
  },
  control: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, padding: space.lg, gap: space.md, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
});
