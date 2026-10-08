import { ApiError } from '@nexus/shared';
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createClient, saveServerUrl, savedServerUrl, useSession } from '../lib/nexus';
import { colors, common, space } from '../ui/theme';

function normalizeUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function LoginScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void savedServerUrl().then(setServer);
  }, []);

  async function submit() {
    setError(null);
    const url = normalizeUrl(server);
    if (!url) return setError('Informe o endereço do servidor.');
    setBusy(true);
    try {
      const c = createClient(url);
      await c.api.info();
      if (mode === 'login') await c.login(username.trim(), password);
      else await c.register(username.trim(), password, invite.trim(), displayName.trim() || undefined);
      await saveServerUrl(url);
      useSession.setState({ phase: 'app' });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.code === 'invalid_credentials' ? 'Usuário ou senha incorretos.' : e.message);
      } else setError('Não foi possível conectar ao servidor.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={common.screen} behavior="height">
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>Nexus</Text>
        <View style={styles.tabs}>
          {(['login', 'register'] as const).map((m) => (
            <Pressable key={m} onPress={() => setMode(m)} style={[styles.tab, mode === m && styles.tabActive]}>
              <Text style={[common.text, mode !== m && { color: colors.textMuted }]}>
                {m === 'login' ? 'Entrar' : 'Criar conta'}
              </Text>
            </Pressable>
          ))}
        </View>
        <Field label="Servidor" value={server} onChangeText={setServer} placeholder="https://nexus.exemplo.com" url />
        <Field label="Usuário" value={username} onChangeText={setUsername} />
        {mode === 'register' && <Field label="Nome de exibição" value={displayName} onChangeText={setDisplayName} />}
        <Field label="Senha" value={password} onChangeText={setPassword} secure />
        {mode === 'register' && (
          <Field
            label="Código de convite"
            value={invite}
            onChangeText={(t) => setInvite(t.toUpperCase())}
            placeholder="NEXUS-XXXX-XXXX"
          />
        )}
        {error && <Text style={common.error}>{error}</Text>}
        <Pressable style={[common.button, busy && { opacity: 0.6 }]} onPress={() => void submit()} disabled={busy}>
          <Text style={common.buttonText}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secure?: boolean;
  url?: boolean;
}) {
  return (
    <View>
      <Text style={common.label}>{props.label}</Text>
      <TextInput
        style={common.input}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textFaint}
        secureTextEntry={props.secure}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={props.url ? 'url' : 'default'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.xl, gap: space.md, flexGrow: 1, justifyContent: 'center' },
  brand: { color: colors.text, fontSize: 30, fontWeight: '700', marginBottom: space.md },
  tabs: { flexDirection: 'row', gap: space.sm },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  tabActive: { backgroundColor: colors.surfaceRaised },
});
