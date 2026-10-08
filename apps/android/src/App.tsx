import type { Id } from '@nexus/protocol';
import React, { useEffect, useState } from 'react';
import { BackHandler, PermissionsAndroid, Platform, StatusBar, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { calls, useCall } from './call/callManager';
import { createClient, savedServerUrl, useNexus, useSession } from './lib/nexus';
import { CallScreen } from './screens/CallScreen';
import { ChatScreen } from './screens/ChatScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LoginScreen } from './screens/LoginScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { colors } from './ui/theme';

export type Route = { name: 'home' } | { name: 'chat'; id: Id } | { name: 'call' } | { name: 'settings' };

export interface Nav {
  push: (r: Route) => void;
  back: () => void;
}

export default function App() {
  const phase = useSession((s) => s.phase);

  useEffect(() => {
    void (async () => {
      const url = await savedServerUrl();
      if (!url) {
        useSession.setState({ phase: 'login' });
        return;
      }
      const ok = await createClient(url).restore().catch(() => false);
      useSession.setState({ phase: ok ? 'app' : 'login' });
    })();
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => undefined);
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom']}>
        {phase === 'boot' ? <View style={{ flex: 1 }} /> : phase === 'login' ? <LoginScreen /> : <Main />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Main() {
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const nav: Nav = {
    push: (r) => setStack((s) => [...s, r]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
  };
  const route = stack[stack.length - 1] ?? { name: 'home' };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        nav.back();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  });

  // Keep the shared store's "active conversation" in sync with the screen.
  useEffect(() => {
    const c = useSession.getState().client;
    if (!c) return;
    void c.openConversation(route.name === 'chat' ? route.id : null);
  }, [route]);

  // Leave the LiveKit room when the server ends the call.
  const callId = useCall((s) => s.callId);
  const exists = useNexus((s) => (callId ? !!s.calls[callId] : true));
  const ready = useNexus((s) => s.connection === 'ready');
  useEffect(() => {
    if (callId && ready && !exists) void calls.onCallEnded(callId);
  }, [callId, exists, ready]);

  switch (route.name) {
    case 'chat':
      return <ChatScreen key={route.id} conversationId={route.id} nav={nav} />;
    case 'call':
      return <CallScreen nav={nav} />;
    case 'settings':
      return <SettingsScreen nav={nav} />;
    default:
      return <HomeScreen nav={nav} />;
  }
}
