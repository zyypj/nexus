import React, { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { installUpdate, useUpdate } from '../lib/updater';
import { colors, common, space } from '../ui/theme';

/**
 * Blocking screen while a newer version exists: the app is only usable after
 * updating. The download starts by itself; Android then asks to confirm.
 */
export function UpdateRequired() {
  const { available, status, error } = useUpdate();

  useEffect(() => {
    if (available && status === 'idle') void installUpdate();
  }, [available, status]);

  if (!available) return null;
  const message =
    status === 'downloading'
      ? 'Baixando… o instalador do Android abrirá em seguida. Confirme a instalação.'
      : status === 'needs-permission'
        ? 'Permita "instalar apps desconhecidos" para o Nexus e toque em Atualizar.'
        : status === 'error'
          ? (error ?? 'Falha ao baixar a atualização.')
          : 'Preparando a atualização…';
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Atualização obrigatória</Text>
      <Text style={styles.version}>Nexus {available.version}</Text>
      <Text style={[common.muted, styles.center]}>{message}</Text>
      {status === 'downloading' ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Pressable style={[common.button, styles.button]} onPress={() => void installUpdate()}>
          <Text style={common.buttonText}>Atualizar</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  version: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  center: { textAlign: 'center' },
  button: { alignSelf: 'stretch' },
});
