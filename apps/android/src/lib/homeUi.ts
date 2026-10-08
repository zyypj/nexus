import type { Id } from '@nexus/protocol';
import { create } from 'zustand';
import { NexusNative } from '../native/NexusNative';

/**
 * Which server the home screen shows (null = Início / DMs) and collapsed
 * categories, remembered between launches like on the desktop.
 */
interface HomeUi {
  serverId: Id | null;
  collapsed: Record<Id, boolean>;
}

export const useHomeUi = create<HomeUi>()(() => ({ serverId: null, collapsed: {} }));

const KEY = 'homeUi';

export async function loadHomeUi() {
  const raw = await NexusNative.getPref(KEY).catch(() => null);
  if (!raw) return;
  try {
    useHomeUi.setState(JSON.parse(raw) as Partial<HomeUi>);
  } catch {
    // ignore a corrupt value
  }
}

export function setHomeUi(patch: Partial<HomeUi>) {
  useHomeUi.setState(patch);
  void NexusNative.setPref(KEY, JSON.stringify(useHomeUi.getState())).catch(() => undefined);
}
