import { NexusClient, type NexusState, conversationTitle } from '@nexus/shared';
import { AppState } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { create, useStore } from 'zustand';
import { NexusNative } from '../native/NexusNative';
import { playSound } from './sounds';

interface SessionStore {
  phase: 'boot' | 'login' | 'app';
  client: NexusClient | null;
  serverUrl: string;
}

export const useSession = create<SessionStore>()(() => ({ phase: 'boot', client: null, serverUrl: '' }));

/** Refresh token in the Android Keystore (encrypted), one entry per server. */
function tokenStore(serverUrl: string) {
  const service = `nexus.refresh.${serverUrl}`;
  return {
    load: async () => {
      const c = await Keychain.getGenericPassword({ service });
      return c ? c.password : null;
    },
    save: async (v: string) => {
      await Keychain.setGenericPassword('nexus', v, { service });
    },
    clear: async () => {
      await Keychain.resetGenericPassword({ service });
    },
  };
}

let foreground = AppState.currentState === 'active';
AppState.addEventListener('change', (s) => {
  const wasForeground = foreground;
  foreground = s === 'active';
  const c = useSession.getState().client;
  if (!c) return;
  if (foreground && !wasForeground) {
    // Back from background: reconnect immediately and catch up.
    c.gateway.reconnectNow();
    const active = c.state.activeConversationId;
    if (active) c.markRead(active);
  }
});

export function createClient(serverUrl: string): NexusClient {
  useSession.getState().client?.gateway.stop();
  const client = new NexusClient({
    baseUrl: serverUrl,
    tokenStore: tokenStore(serverUrl),
    deviceName: 'Nexus Android',
    isAppVisible: () => foreground,
    onLoggedOut: () => useSession.setState({ phase: 'login' }),
    onNotify: (m, s) => {
      playSound('message');
      const author = s.users[m.author_id]?.display_name ?? 'Nova mensagem';
      const conv = s.conversations[m.conversation_id];
      const title = conv && conv.kind === 'group' ? `${author} em ${conversationTitle(s, conv)}` : author;
      void NexusNative.notify(title, (m.content || '📎 Anexo').slice(0, 140)).catch(() => undefined);
    },
  });
  useSession.setState({ client, serverUrl });
  return client;
}

export function client(): NexusClient {
  const c = useSession.getState().client;
  if (!c) throw new Error('client not initialised');
  return c;
}

const fallback = new NexusClient({
  baseUrl: 'http://invalid',
  tokenStore: { load: async () => null, save: async () => undefined, clear: async () => undefined },
  deviceName: '',
}).store;

export function useNexus<T>(selector: (s: NexusState) => T): T {
  const c = useSession((s) => s.client);
  return useStore(c?.store ?? fallback, selector);
}

export async function savedServerUrl(): Promise<string> {
  return (await NexusNative.getPref('serverUrl').catch(() => null)) ?? '';
}

export async function saveServerUrl(url: string): Promise<void> {
  await NexusNative.setPref('serverUrl', url);
}
