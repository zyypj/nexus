import { isNewer } from '@nexus/shared';
import { create } from 'zustand';
import { APK_ASSET, GITHUB_REPO } from '../buildInfo';
import { NexusNative, UPDATE_ERROR_EVENT, nativeEvents } from '../native/NexusNative';

/**
 * Self-update from GitHub Releases (no Play Store). Mandatory: the app checks
 * the latest release before opening (`startupCheck`) and, when a newer one
 * exists, shows only the update screen until it is installed (Android always
 * asks the user to confirm the install and verifies the signing key).
 * Also re-checks every 6 hours and when the app returns to the foreground.
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

export async function checkForUpdate(timeoutMs = 15_000): Promise<void> {
  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const current = await NexusNative.getAppVersion();
    useUpdate.setState({ current });
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: abort.signal,
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
  } finally {
    clearTimeout(t);
  }
}

/** Launch check (at most ~8 s, so an offline phone still opens the app). */
export async function startupCheck(): Promise<void> {
  await checkForUpdate(8000);
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
  // startupCheck() already ran at launch.
  timer = setTimeout(loop, 6 * 60 * 60 * 1000);
}

nativeEvents?.addListener(UPDATE_ERROR_EVENT, (e) => {
  useUpdate.setState({ status: 'error', error: (e as { message?: string }).message ?? 'Falha na atualização' });
});
