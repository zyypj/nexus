/**
 * Turns what the user typed into the server's base URL.
 *
 * With a scheme it is used as is. Without one ("151.244.40.191:30001",
 * "nexus.exemplo.com") HTTPS is tried first and plain HTTP second: most
 * self-hosted servers (Pterodactyl without a proxy) only speak HTTP, and
 * assuming https:// made the login fail with no hint of why.
 */
export function serverUrlCandidates(raw: string): string[] {
  const url = raw.trim().replace(/\/+$/, "");
  if (!url) return [];
  if (/^https?:\/\//i.test(url)) return [url];
  return [`https://${url}`, `http://${url}`];
}

export class ServerUnreachableError extends Error {
  constructor(public readonly tried: string[]) {
    super(`Não foi possível conectar a ${tried.join(" nem a ")}.`);
    this.name = "ServerUnreachableError";
  }
}

/** First candidate whose /api/info answers like a Nexus server. */
export async function resolveServerUrl(
  raw: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<string> {
  const candidates = serverUrlCandidates(raw);
  for (const base of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/api/info`, { signal: ctrl.signal });
      if (res.ok) {
        const info = (await res.json().catch(() => null)) as { version?: unknown } | null;
        if (info && typeof info.version === "string") return base;
      }
    } catch {
      // unreachable / TLS error / timeout: try the next candidate
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ServerUnreachableError(candidates);
}
