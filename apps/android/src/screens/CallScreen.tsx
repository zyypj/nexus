import { VideoTrack } from '@livekit/react-native';
import { conversationTitle } from '@nexus/shared';
import type { IconName } from '@nexus/ui';
import { Track } from 'livekit-client';
import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Nav } from '../App';
import { type ParticipantView, calls, useCall } from '../call/callManager';
import { useNexus } from '../lib/nexus';
import { Avatar, Button, Header, Icon, Sheet, SheetItem } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';

export function CallScreen({ nav }: { nav: Nav }) {
  const s = useCall();
  const title = useNexus((st) => {
    const c = s.conversationId ? st.conversations[s.conversationId] : undefined;
    if (!c) return '';
    const server = c.server_id ? st.servers[c.server_id] : undefined;
    return server ? `${c.name} · ${server.name}` : conversationTitle(st, c);
  });
  const [shareMenu, setShareMenu] = useState(false);
  const [volumeFor, setVolumeFor] = useState<ParticipantView | null>(null);
  const sharer = s.participants.find((p) => p.hasScreen && !p.isLocal);

  if (s.status === 'idle') {
    return (
      <View style={[common.screen, styles.ended]}>
        <View style={styles.endedIcon}>
          <Icon name="phoneOff" size={30} color={colors.textMuted} />
        </View>
        <Text style={[common.headerTitle, { flex: 0 }]}>Chamada encerrada</Text>
        {s.error && <Text style={[common.error, { textAlign: 'center' }]}>{s.error}</Text>}
        <Button label="Voltar" variant="secondary" onPress={nav.back} />
      </View>
    );
  }

  const statusText = s.status === 'connected' ? 'Conectado' : s.status === 'connecting' ? 'Conectando…' : 'Reconectando…';
  return (
    <View style={[common.screen, { backgroundColor: '#06070d' }]}>
      <Header
        title={title}
        onBack={nav.back}
        subtitle={
          <View style={[common.row, { gap: 6 }]}>
            <View style={[styles.statusDot, { backgroundColor: s.status === 'connected' ? colors.success : colors.idle }]} />
            <Text style={[common.faint, { color: s.status === 'connected' ? colors.success : colors.idle }]}>
              {statusText} · {s.participants.length} {s.participants.length === 1 ? 'pessoa' : 'pessoas'}
            </Text>
          </View>
        }
      />
      {s.error && (
        <Pressable style={styles.notice} onPress={() => useCall.setState({ error: null })}>
          <Text style={common.error}>{s.error}</Text>
        </Pressable>
      )}
      {s.captureBlocked && <Text style={styles.warn}>Este aplicativo não permite que seu áudio seja compartilhado.</Text>}
      {sharer && (
        <View style={styles.screenShare}>
          <VideoTrack trackRef={calls.trackRef(sharer.identity, Track.Source.ScreenShare)} objectFit="contain" style={{ flex: 1 }} />
          <View style={styles.liveTag}>
            <Text style={styles.liveText}>AO VIVO · {sharer.name}</Text>
          </View>
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
        ListFooterComponent={
          s.participants.length > 1 ? (
            <Text style={[common.faint, { textAlign: 'center', marginTop: space.sm }]}>Segure em alguém para ajustar o volume.</Text>
          ) : undefined
        }
      />
      <View style={[common.panel, styles.controls]}>
        <Control
          name={s.muted ? 'micOff' : 'mic'}
          danger={s.muted}
          label={s.muted ? 'Ativar microfone' : 'Silenciar'}
          onPress={() => void calls.toggleMute()}
        />
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
          hangup
          label="Sair da chamada"
          onPress={async () => {
            await calls.leave();
            nav.back();
          }}
        />
      </View>
      {shareMenu && (
        <Sheet title="Compartilhar tela" onClose={() => setShareMenu(false)}>
          <SheetItem
            icon="screen"
            label="Só a tela"
            onPress={() => {
              setShareMenu(false);
              void calls.startScreenShare(false);
            }}
          />
          <SheetItem
            icon="volume"
            label="Tela + áudio do aparelho"
            hint="Android 10+. Sem o som da chamada."
            onPress={() => {
              setShareMenu(false);
              void calls.startScreenShare(true);
            }}
          />
          <Text style={[common.faint, { paddingTop: space.sm }]}>
            Apps que proíbem a captura de áudio não serão ouvidos (o Android respeita a escolha deles).
          </Text>
        </Sheet>
      )}
      {volumeFor && <VolumeSheet p={volumeFor} onClose={() => setVolumeFor(null)} />}
    </View>
  );
}

function Tile({ p, small, onLongPress }: { p: ParticipantView; small: boolean; version: number; onLongPress: () => void }) {
  const user = useNexus((s) => s.users[p.identity]);
  const height = small ? 84 : 190;
  const speaking = p.speaking && !p.micMuted;
  return (
    <Pressable onLongPress={onLongPress} style={[styles.tile, { height }, speaking && styles.speaking]}>
      {p.hasCamera ? (
        <VideoTrack
          trackRef={calls.trackRef(p.identity, Track.Source.Camera)}
          objectFit="cover"
          mirror={p.isLocal}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <Avatar user={user ?? { id: p.identity, display_name: p.name, avatar_url: null }} size={small ? 40 : 72} speaking={speaking} />
      )}
      <View style={styles.label}>
        {p.micMuted && <Icon name="micOff" size={12} color={colors.danger} />}
        <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
          {user?.display_name ?? p.name}
        </Text>
      </View>
    </Pressable>
  );
}

function Control(props: {
  name: IconName;
  onPress: () => void;
  label: string;
  danger?: boolean;
  active?: boolean;
  hangup?: boolean;
}) {
  const bg = props.hangup
    ? colors.danger
    : props.danger
      ? 'rgba(244,80,107,0.18)'
      : props.active
        ? colors.accent
        : colors.surfaceRaised;
  const fg = props.hangup || props.active ? '#fff' : props.danger ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityLabel={props.label}
      style={({ pressed }) => [styles.control, props.hangup && styles.hangup, { backgroundColor: bg }, pressed && { transform: [{ scale: 0.94 }] }]}
    >
      <Icon name={props.name} color={fg} />
    </Pressable>
  );
}

/** Local-only volume, 0–300%. Long-press a tile to open. */
function VolumeSheet({ p, onClose }: { p: ParticipantView; onClose: () => void }) {
  const volume = useCall((s) => s.volumes[p.identity] ?? 1);
  const pct = Math.round(volume * 100);
  const step = (d: number) => calls.setVolume(p.identity, (pct + d) / 100);
  return (
    <Sheet title={p.name} onClose={onClose}>
      <View style={{ gap: space.md }}>
        <View style={[common.row, { justifyContent: 'space-between' }]}>
          <StepButton label="−10%" onPress={() => step(-10)} />
          <View style={{ alignItems: 'center' }}>
            <Text style={[styles.volume, pct > 100 && { color: colors.highlight }]}>{pct === 0 ? 'Mudo' : `${pct}%`}</Text>
            <Text style={common.faint}>volume para você</Text>
          </View>
          <StepButton label="+10%" onPress={() => step(10)} />
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${(pct / 300) * 100}%` }]} />
          <View style={[styles.mark, { left: '33.3%' }]} />
        </View>
        <View style={[common.row, { gap: space.sm }]}>
          {[0, 50, 100, 200, 300].map((v) => (
            <Pressable
              key={v}
              onPress={() => calls.setVolume(p.identity, v / 100)}
              style={[styles.preset, pct === v && styles.presetOn]}
            >
              <Text style={[common.text, { fontWeight: '700', fontSize: 13 }]}>{v === 0 ? 'Mudo' : `${v}%`}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={common.faint}>Só altera o que você ouve. Acima de 100% o som é amplificado.</Text>
      </View>
    </Sheet>
  );
}

function StepButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.step, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <Text style={[common.text, { fontWeight: '800' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ended: { alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  endedIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  notice: { marginHorizontal: space.md, padding: space.sm, borderRadius: radius.md, backgroundColor: 'rgba(244,80,107,0.12)' },
  warn: { color: colors.highlight, padding: space.sm, textAlign: 'center' },
  screenShare: { height: 240, backgroundColor: '#000', margin: space.sm, borderRadius: radius.lg, overflow: 'hidden' },
  liveTag: { position: 'absolute', top: 8, left: 8, backgroundColor: colors.danger, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  liveText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
  },
  speaking: { borderColor: colors.speaking },
  label: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.round,
    paddingHorizontal: 8,
    paddingVertical: 3,
    maxWidth: '90%',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    margin: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
  },
  control: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  hangup: { width: 64, borderRadius: 26 },
  volume: { color: colors.text, fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'] },
  step: {
    width: 64,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceHover },
  fill: { height: '100%', borderRadius: 3, backgroundColor: colors.accent },
  mark: { position: 'absolute', top: -3, width: 2, height: 12, backgroundColor: colors.textFaint },
  preset: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  presetOn: { borderColor: colors.accent, backgroundColor: 'rgba(84,104,245,0.18)' },
});
