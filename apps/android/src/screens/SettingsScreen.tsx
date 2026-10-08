import type { UserStatus } from '@nexus/protocol';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Nav } from '../App';
import { calls } from '../call/callManager';
import { client, useNexus, useSession } from '../lib/nexus';
import { Avatar, IconButton } from '../ui/components';
import { colors, common, space } from '../ui/theme';

const STATUS: Record<UserStatus, string> = { online: 'Online', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível' };

export function SettingsScreen({ nav }: { nav: Nav }) {
  const me = useNexus((s) => s.me);
  const serverUrl = useSession((s) => s.serverUrl);
  const [displayName, setDisplayName] = useState(me?.display_name ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  if (!me) return null;
  return (
    <View style={common.screen}>
      <View style={common.header}>
        <IconButton name="reply" label="Voltar" onPress={nav.back} />
        <Text style={common.headerTitle}>Configurações</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={[common.row, { gap: space.md }]}>
          <Avatar user={me} size={64} />
          <View>
            <Text style={[common.text, { fontSize: 18, fontWeight: '700' }]}>{me.display_name}</Text>
            <Text style={common.muted}>@{me.username}</Text>
          </View>
        </View>
        <Text style={common.label}>Status</Text>
        <View style={[common.row, { flexWrap: 'wrap', gap: space.sm }]}>
          {(Object.keys(STATUS) as UserStatus[]).map((st) => (
            <Pressable
              key={st}
              onPress={() => void client().api.updateMe({ status: st })}
              style={[common.buttonSecondary, me.status === st && { borderColor: colors.accent }]}
            >
              <Text style={common.text}>{STATUS[st]}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={common.label}>Nome de exibição</Text>
        <TextInput style={common.input} value={displayName} onChangeText={setDisplayName} maxLength={32} />
        <Text style={common.label}>Sobre mim</Text>
        <TextInput style={common.input} value={bio} onChangeText={setBio} maxLength={190} multiline />
        <Pressable
          style={common.button}
          onPress={() =>
            void client()
              .api.updateMe({ display_name: displayName, bio })
              .then(() => setMsg('Perfil salvo.'))
              .catch((e: Error) => setMsg(e.message))
          }
        >
          <Text style={common.buttonText}>Salvar perfil</Text>
        </Pressable>
        {msg && <Text style={common.muted}>{msg}</Text>}
        <Text style={common.muted}>
          Áudio: cancelamento de eco, supressão de ruído e controle de ganho usam o processamento do próprio aparelho
          (quando disponível) e o do WebRTC.
        </Text>
        <Text style={common.muted}>Servidor: {serverUrl}</Text>
        <Pressable
          style={[common.buttonSecondary, { borderColor: colors.danger }]}
          onPress={async () => {
            await calls.leave();
            await client().logout();
            useSession.setState({ phase: 'login' });
          }}
        >
          <Text style={{ color: colors.danger, fontWeight: '600' }}>Sair da conta</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
});
