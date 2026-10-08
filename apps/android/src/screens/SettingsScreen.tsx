import type { UserStatus } from '@nexus/protocol';
import { presenceColor } from '@nexus/ui';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Nav } from '../App';
import { calls } from '../call/callManager';
import { client, useNexus, useSession } from '../lib/nexus';
import { playSound, useSoundPrefs } from '../lib/sounds';
import { NexusNative } from '../native/NexusNative';
import { Avatar, Button, Card, Gradient, Header } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';

const STATUS: Record<UserStatus, string> = { online: 'Online', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível' };

export function SettingsScreen({ nav }: { nav: Nav }) {
  const me = useNexus((s) => s.me);
  const serverUrl = useSession((s) => s.serverUrl);
  const [displayName, setDisplayName] = useState(me?.display_name ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState('');
  const sounds = useSoundPrefs();
  useEffect(() => {
    Promise.resolve()
      .then(() => NexusNative.getAppVersion())
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  if (!me) return null;
  const dirty = displayName !== me.display_name || bio !== (me.bio ?? '');

  return (
    <View style={common.screen}>
      <Header title="Configurações" onBack={nav.back} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* Profile card */}
        <View style={common.panel}>
          <View style={styles.banner}>
            <Gradient />
          </View>
          <View style={styles.profile}>
            <View style={styles.avatarRing}>
              <Avatar user={me} size={72} />
            </View>
            <Text style={styles.name}>{me.display_name}</Text>
            <Text style={common.muted}>@{me.username}</Text>
          </View>
        </View>

        <Card title="Status">
          <View style={styles.chips}>
            {(Object.keys(STATUS) as UserStatus[]).map((st) => {
              const on = me.status === st;
              return (
                <Pressable
                  key={st}
                  onPress={() => void client().api.updateMe({ status: st })}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <View style={[styles.dot, { backgroundColor: presenceColor(st === 'invisible' ? 'offline' : st) }]} />
                  <Text style={[common.text, { fontWeight: on ? '700' : '500' }]}>{STATUS[st]}</Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <Card title="Perfil">
          <View>
            <Text style={common.label}>Nome de exibição</Text>
            <TextInput style={common.input} value={displayName} onChangeText={setDisplayName} maxLength={32} />
          </View>
          <View>
            <Text style={common.label}>Sobre mim</Text>
            <TextInput
              style={[common.input, { minHeight: 80, textAlignVertical: 'top' }]}
              value={bio}
              onChangeText={setBio}
              maxLength={190}
              multiline
              placeholder="Conte um pouco sobre você"
              placeholderTextColor={colors.textFaint}
            />
          </View>
          {msg && <Text style={[common.muted, { color: msg.ok ? colors.success : colors.danger }]}>{msg.text}</Text>}
          <Button
            label="Salvar perfil"
            busy={saving}
            disabled={!dirty}
            onPress={async () => {
              setSaving(true);
              try {
                await client().api.updateMe({ display_name: displayName, bio });
                setMsg({ ok: true, text: 'Perfil salvo.' });
              } catch (e) {
                setMsg({ ok: false, text: (e as Error).message });
              } finally {
                setSaving(false);
              }
            }}
          />
        </Card>

        <Card title="Sons">
          <View style={[common.row, { justifyContent: 'space-between', gap: space.md }]}>
            <View style={{ flex: 1 }}>
              <Text style={[common.text, { fontWeight: '600' }]}>Sons do app</Text>
              <Text style={common.faint}>Entrar e sair da chamada, mute, tela, mensagens</Text>
            </View>
            <Switch
              value={sounds.enabled}
              onValueChange={(enabled) => sounds.set({ enabled })}
              trackColor={{ true: colors.accent, false: colors.surfaceHover }}
              thumbColor="#fff"
            />
          </View>
          {sounds.enabled && (
            <View style={styles.segment}>
              {[0.3, 0.6, 1].map((v) => (
                <Pressable
                  key={v}
                  onPress={() => {
                    sounds.set({ volume: v });
                    playSound('message');
                  }}
                  style={[styles.segmentItem, sounds.volume === v && styles.segmentOn]}
                >
                  <Text style={[common.text, { fontWeight: '600', color: sounds.volume === v ? colors.text : colors.textMuted }]}>
                    {v === 0.3 ? 'Baixo' : v === 0.6 ? 'Médio' : 'Alto'}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </Card>

        <Card title="Áudio">
          <Text style={common.muted}>
            Cancelamento de eco, supressão de ruído e controle de ganho usam o processamento do próprio aparelho (quando
            disponível) e o do WebRTC.
          </Text>
        </Card>

        <Card title="Sobre">
          <InfoRow label="Servidor" value={serverUrl} />
          <InfoRow label="Versão" value={version || '—'} />
        </Card>

        <Button
          label="Sair da conta"
          variant="danger"
          icon="logout"
          onPress={() =>
            Alert.alert('Sair da conta?', 'Você vai precisar entrar de novo neste aparelho.', [
              { text: 'Cancelar', style: 'cancel' },
              {
                text: 'Sair',
                style: 'destructive',
                onPress: async () => {
                  await calls.leave();
                  await client().logout();
                  useSession.setState({ phase: 'login' });
                },
              },
            ])
          }
        />
      </ScrollView>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={[common.row, { justifyContent: 'space-between', gap: space.md }]}>
      <Text style={common.muted}>{label}</Text>
      <Text style={[common.text, { flexShrink: 1, textAlign: 'right' }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.md, paddingBottom: space.xxl, gap: space.lg },
  banner: { height: 72 },
  profile: { alignItems: 'center', paddingBottom: space.lg, marginTop: -40, gap: 2 },
  avatarRing: { borderRadius: 44, borderWidth: 5, borderColor: colors.surface, marginBottom: space.xs },
  name: { color: colors.text, fontSize: 20, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.round,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: 'rgba(84,104,245,0.16)' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  segment: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: radius.md, padding: 4 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.sm },
  segmentOn: { backgroundColor: colors.surfaceRaised },
});
