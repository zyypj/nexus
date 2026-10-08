/**
 * Renders every screen with a realistic state (DMs, a server with channels,
 * messages with image/video/audio/file attachments) to catch runtime errors
 * in the UI without a device.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-keychain', () => ({
  getGenericPassword: async () => false,
  setGenericPassword: async () => true,
  resetGenericPassword: async () => true,
}));
jest.mock('@livekit/react-native', () => ({
  AudioSession: { startAudioSession: jest.fn(), stopAudioSession: jest.fn(), configureAudio: jest.fn() },
  VideoTrack: () => null,
  registerGlobals: jest.fn(),
}));
jest.mock('livekit-client', () => ({
  AudioPresets: {},
  DisconnectReason: {},
  Room: class {},
  RoomEvent: {},
  Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' } },
  VideoPresets: {},
}));

import type { Nav } from '../src/App';
import { setHomeUi } from '../src/lib/homeUi';
import { createClient } from '../src/lib/nexus';
import { ImageViewer } from '../src/media/ImageViewer';
import { openImage } from '../src/media/media';
import { CallScreen } from '../src/screens/CallScreen';
import { ChatScreen } from '../src/screens/ChatScreen';
import { FriendsScreen } from '../src/screens/FriendsScreen';
import { HomeScreen } from '../src/screens/HomeScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';

const nav: Nav = { push: jest.fn(), back: jest.fn(), home: jest.fn() };
const now = Date.now();
const user = (id: string, name: string) => ({ id, username: name.toLowerCase(), display_name: name, avatar_url: null, bio: null });
const me = { ...user('me', 'Joao'), status: 'online', created_at: now };

const att = (id: string, file_name: string, content_type: string, w: number | null = null, h: number | null = null) => ({
  id,
  file_name,
  content_type,
  size: 123456,
  width: w,
  height: h,
  url: `/api/attachments/${id}`,
});
const msg = (id: string, author: string, content: string, attachments: unknown[] = [], ago = 0) => ({
  id,
  conversation_id: 'dm1',
  author_id: author,
  content,
  reply_to: null,
  attachments,
  reactions: [{ emoji: '👍', user_ids: ['me'] }],
  created_at: now - ago,
  edited_at: null,
});
const conv = (id: string, kind: string, extra: object = {}) => ({
  id,
  kind,
  name: null,
  owner_id: 'me',
  members: [user('me', 'Joao'), user('u2', 'Pedro')],
  created_at: now,
  last_message_id: null,
  last_read_message_id: null,
  unread_count: 0,
  ...extra,
});

beforeAll(() => {
  const c = createClient('http://test.local');
  c.store.setState({
    connection: 'ready',
    me: me as never,
    server: { name: 'Nexus', version: '0.2.5', calls_enabled: true, max_upload_size: 0, public_registration: false } as never,
    users: { me: user('me', 'Joao'), u2: user('u2', 'Pedro') } as never,
    presences: { u2: 'online' },
    friends: { u2: { user: user('u2', 'Pedro'), since: now } } as never,
    conversations: {
      dm1: conv('dm1', 'dm', { unread_count: 2 }),
      g1: conv('g1', 'group', { name: 'Grupo A' }),
      ch1: conv('ch1', 'text', { name: 'geral', server_id: 's1', category_id: 'cat1', position: 0, permissions: 0xffff }),
      vc1: conv('vc1', 'voice', { name: 'Sala', server_id: 's1', category_id: 'cat2', position: 1, permissions: 0xffff }),
    } as never,
    messages: {
      dm1: {
        items: [
          msg('m1', 'u2', 'Fala!', [], 60_000),
          msg('m2', 'u2', '', [att('a1', 'foto.jpg', 'image/jpeg', 1200, 800)], 50_000),
          msg('m3', 'me', 'olha o vídeo', [att('a2', 'clip.mp4', 'video/mp4', 1920, 1080)], 40_000),
          msg('m4', 'u2', '', [att('a3', 'mensagem-de-voz.m4a', 'audio/mp4')], 30_000),
          msg('m5', 'me', '', [att('a4', 'doc.pdf', 'application/pdf'), att('a5', 'foto2.png', 'image/png', 600, 900)], 20_000),
        ],
        hasMore: false,
        loading: false,
        loaded: true,
      },
    } as never,
    servers: {
      s1: {
        id: 's1',
        name: 'Os Brabos',
        icon_url: null,
        owner_id: 'me',
        created_at: now,
        permissions: 0xffff,
        roles: [{ id: 's1', name: '@everyone', color: 0, position: 0, permissions: 0, hoist: false }],
        categories: [
          { id: 'cat1', name: 'Canais de texto', position: 0 },
          { id: 'cat2', name: 'Canais de voz', position: 1 },
        ],
        channels: [],
        overwrites: [],
        members: [{ user: user('me', 'Joao'), nickname: null, role_ids: [], joined_at: now }],
      },
    } as never,
  });
});

function render(el: React.ReactElement) {
  let r: ReactTestRenderer.ReactTestRenderer | undefined;
  act(() => {
    r = ReactTestRenderer.create(el);
  });
  return r!;
}

/** All rendered text, nested <Text> included. */
const text = (r: ReactTestRenderer.ReactTestRenderer) => {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') out.push(String(node));
    else if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && 'children' in (node as object)) walk((node as { children: unknown }).children);
  };
  walk(r.toJSON());
  return out.join(' | ');
};

test('home: Início with DMs and the rail', () => {
  setHomeUi({ serverId: null });
  const r = render(<HomeScreen nav={nav} />);
  expect(text(r)).toContain('Amigos');
  expect(text(r)).toContain('Pedro');
  expect(text(r)).toContain('Grupo A');
});

test('home: server panel with categories and channels', () => {
  setHomeUi({ serverId: 's1' });
  const r = render(<HomeScreen nav={nav} />);
  const t = text(r);
  expect(t).toContain('Os Brabos');
  expect(t).toContain('geral');
  expect(t).toContain('Sala');
  act(() => setHomeUi({ serverId: null }));
});

test('chat: messages with every attachment kind', () => {
  const r = render(<ChatScreen conversationId="dm1" nav={nav} />);
  const t = text(r);
  expect(t).toContain('Fala!');
  expect(t).toContain('clip.mp4');
  expect(t).toContain('Mensagem de voz');
  expect(t).toContain('doc.pdf');
});

test('image viewer opens with the conversation gallery', () => {
  openImage('dm1', 'a5');
  const r = render(<ImageViewer />);
  expect(text(r)).toContain('2 de 2');
});

test('friends, settings and an ended call render', () => {
  expect(text(render(<FriendsScreen nav={nav} />))).toContain('Pedro');
  expect(text(render(<SettingsScreen nav={nav} />))).toContain('Configurações');
  expect(text(render(<CallScreen nav={nav} />))).toContain('Chamada encerrada');
});
