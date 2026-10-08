import { isNewer } from '@nexus/shared';
import { create } from 'zustand';
import { APK_ASSET, GITHUB_REPO } from '../buildInfo';
import { NexusNative, UPDATE_ERROR_EVENT, nativeEvents } from '../native/NexusNative';

/**
 * Self-update from GitHub Releases (no Play Store): checks the latest release
 * at startup and every 6 hours, offers the APK, and hands it to Android's
 * installer (the user confirms; Android verifies the signing key).
 */
interface UpdateState {
  current: string | null;
  available: { version: string; url: string; notes: string } | null;
  status: 'idle' | 'downloading' | 'needs-permission' | 'error';
  error: string | null;
}

export const useUpdate = create<UpdateState>()(() => ({ current: null, available: null, status: 'idle', error: null }));

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body?: string;
  assets: { name: string; browser_download_url: string }[];
}

export async function checkForUpdate(): Promise<void> {
  try {
    const current = await NexusNative.getAppVersion();
    useUpdate.setState({ current });
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const rel = (await res.json()) as GithubRelease;
    const asset = rel.assets.find((a) => a.name === APK_ASSET);
    if (rel.draft || rel.prerelease || !asset || !isNewer(rel.tag_name, current)) return;
    useUpdate.setState({
      available: { version: rel.tag_name.replace(/^v/, ''), url: asset.browser_download_url, notes: rel.body ?? '' },
    });
  } catch {
    // offline: try again at the next check
  }
}

export async function installUpdate(): Promise<void> {
  const a = useUpdate.getState().available;
  if (!a) return;
  try {
    const r = await NexusNative.installUpdate(a.url, a.version);
    useUpdate.setState({ status: r === 'permission' ? 'needs-permission' : 'downloading', error: null });
  } catch (e) {
    useUpdate.setState({ status: 'error', error: (e as Error).message });
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function startUpdateChecks(): void {
  if (timer) return;
  const loop = () => {
    void checkForUpdate();
    timer = setTimeout(loop, 6 * 60 * 60 * 1000);
  };
  timer = setTimeout(loop, 10_000);
}

nativeEvents?.addListener(UPDATE_ERROR_EVENT, (e) => {
  useUpdate.setState({ status: 'error', error: (e as { message?: string }).message ?? 'Falha na atualização' });
});
