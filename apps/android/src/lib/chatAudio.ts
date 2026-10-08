import { create } from 'zustand';
import { AUDIO_EVENT, NexusNative, nativeEvents } from '../native/NexusNative';

/** State of the single chat audio player (native MediaPlayer). */
interface ChatAudio {
  id: string | null;
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error' | 'stopped';
  position: number;
  duration: number;
}

export const useChatAudio = create<ChatAudio>()(() => ({ id: null, state: 'idle', position: 0, duration: 0 }));

nativeEvents?.addListener(AUDIO_EVENT, (e) => {
  const ev = e as { id: string; state: ChatAudio['state']; position: number; duration: number };
  useChatAudio.setState({ id: ev.id, state: ev.state, position: ev.position, duration: ev.duration });
});

export function toggleAudio(id: string, url: string) {
  const s = useChatAudio.getState();
  if (s.id === id && (s.state === 'playing' || s.state === 'loading')) NexusNative.audioPause();
  else NexusNative.audioPlay(id, url);
}

export function seekAudio(id: string, positionMs: number) {
  if (useChatAudio.getState().id === id) NexusNative.audioSeek(positionMs);
}
