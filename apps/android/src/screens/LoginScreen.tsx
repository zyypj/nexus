import { ApiError, ServerUnreachableError, resolveServerUrl, serverUrlCandidates } from '@nexus/shared';
import React, { useEffect, useState } from 'react';
import { Image, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { createClient, saveServerUrl, savedServerUrl, useSession } from '../lib/nexus';
import { Button } from '../ui/components';
import { colors, common, radius, space } from '../ui/theme';

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
    if (serverUrlCandidates(server).length === 0) return setError('Informe o endereço do servidor.');
    setBusy(true);
    try {
      // Without http:// or https://, tries HTTPS and then HTTP.
      const url = await resolveServerUrl(server);
      setServer(url);
      const c = createClient(url);
      if (mode === 'login') await c.login(username.trim(), password);
      else await c.register(username.trim(), password, invite.trim(), displayName.trim() || undefined);
      await saveServerUrl(url);
      useSession.setState({ phase: 'app' });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.code === 'invalid_credentials' ? 'Usuário ou senha incorretos.' : e.message);
      } else if (e instanceof ServerUnreachableError) {
        setError(`${e.message} Confira o endereço e a porta.`);
      } else setError('Não foi possível conectar ao servidor.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={common.screen} behavior="height">
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Image source={require('../assets/logo.png')} style={styles.logo} resizeMode="contain" />
        <Text style={styles.brand}>Nexus</Text>
        <Text style={[common.muted, { textAlign: 'center', marginBottom: space.md }]}>
          {mode === 'login' ? 'Que bom te ver de novo!' : 'Crie sua conta com o convite que te mandaram.'}
        </Text>
        <View style={[common.panel, styles.card]}>
        <View style={styles.tabs}>
          {(['login', 'register'] as const).map((m) => (
            <Pressable key={m} onPress={() => setMode(m)} style={[styles.tab, mode === m && styles.tabActive]}>
              <Text style={[common.text, { fontWeight: '600' }, mode !== m && { color: colors.textMuted }]}>
                {m === 'login' ? 'Entrar' : 'Criar conta'}
              </Text>
            </Pressable>
          ))}
        </View>
        <Field label="Servidor" value={server} onChangeText={setServer} placeholder="ex.: 151.244.40.191:30001" url />
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
        <Button label={mode === 'login' ? 'Entrar' : 'Criar conta'} busy={busy} onPress={() => void submit()} />
        </View>
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
  container: { padding: space.lg, gap: space.xs, flexGrow: 1, justifyContent: 'center' },
  logo: { width: 84, height: 72, alignSelf: 'center', marginBottom: space.sm },
  brand: { color: colors.text, fontSize: 30, fontWeight: '800', textAlign: 'center' },
  card: { padding: space.lg, gap: space.md },
  tabs: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: radius.md, padding: 4 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.sm },
  tabActive: { backgroundColor: colors.surfaceRaised },
});
