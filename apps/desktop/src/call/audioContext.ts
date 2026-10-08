/**
 * One shared 48 kHz AudioContext for the whole call: LiveKit's playback mix
 * (per-user gain up to 300%), RNNoise and system-audio injection all run in
 * the same audio thread instead of spinning up several.
 */
let ctx: AudioContext | null = null;

export function sharedAudioContext(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
  }
  return ctx;
}

/**
 * Closes the context after a call: frees the audio thread, worklets (RNNoise
 * WASM) and LiveKit's mix graph instead of keeping them suspended in memory.
 */
export async function releaseAudio(): Promise<void> {
  const c = ctx;
  ctx = null;
  if (c && c.state !== "closed") await c.close();
}

export async function resumeAudio(): Promise<void> {
  const c = sharedAudioContext();
  if (c.state !== "running") await c.resume();
}

const loadedModules = new WeakMap<AudioContext, Set<string>>();

export async function addWorkletOnce(context: AudioContext, url: string): Promise<void> {
  let set = loadedModules.get(context);
  if (!set) {
    set = new Set();
    loadedModules.set(context, set);
  }
  if (set.has(url)) return;
  await context.audioWorklet.addModule(url);
  set.add(url);
}
