import type { Attachment } from "@nexus/protocol";
import { formatBytes } from "@nexus/shared";
import { useEffect, useRef, useState } from "react";
import { openExternal } from "../lib/platform";
import { settings } from "../lib/settings";
import { Icon } from "./Icon";

/** Voice messages are recorded by the apps with this file-name prefix. */
export const VOICE_PREFIX = "mensagem-de-voz";

export type MediaKind = "video" | "audio" | "voice" | null;

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"]);

export function mediaKind(a: Attachment): MediaKind {
  if (a.file_name.startsWith(VOICE_PREFIX)) return "voice";
  if (VIDEO_TYPES.has(a.content_type)) return "video";
  if (a.content_type.startsWith("audio/")) return "audio";
  return null;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Only one audio/video plays at a time across the chat. */
let current: HTMLMediaElement | null = null;
function claim(el: HTMLMediaElement) {
  if (current && current !== el) current.pause();
  current = el;
}

type SinkElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
/** Plays on the output device chosen in the settings (same as the calls). */
function useOutputDevice(ref: React.RefObject<HTMLMediaElement | null>) {
  useEffect(() => {
    const id = settings().outputDeviceId;
    const el = ref.current as SinkElement | null;
    if (el && id && id !== "default") void el.setSinkId?.(id).catch(() => undefined);
  }, [ref]);
}

function FileFallback({ a, url, note }: { a: Attachment; url: string; note?: string }) {
  return (
    <button type="button" className="attachment-file" onClick={() => void openExternal(url)}>
      <Icon name="file" size={28} />
      <span>
        <strong>{a.file_name}</strong>
        <small>
          {formatBytes(a.size)}
          {note ? ` · ${note}` : ""}
        </small>
      </span>
    </button>
  );
}

export function VideoPlayer({ a, url }: { a: Attachment; url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useOutputDevice(ref);
  if (failed) return <FileFallback a={a} url={url} note="formato não suportado para tocar aqui — clique para baixar" />;
  return (
    <div className="attachment-video">
      <video
        ref={ref}
        src={url}
        controls
        preload="metadata"
        playsInline
        onPlay={(e) => claim(e.currentTarget)}
        onError={() => setFailed(true)}
      />
      <div className="attachment-media-footer">
        <span title={a.file_name}>{a.file_name}</span>
        <small>{formatBytes(a.size)}</small>
        <button type="button" className="icon-btn small" title="Baixar" onClick={() => void openExternal(url)}>
          <Icon name="paperclip" size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * Compact player for audio files and voice messages. Recordings made with
 * MediaRecorder have no duration in their header (Infinity); seeking far
 * ahead once makes Chromium compute it.
 */
export function AudioPlayer({ a, url, voice }: { a: Attachment; url: string; voice: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  useOutputDevice(ref);

  const onMeta = () => {
    const el = ref.current;
    if (!el) return;
    if (Number.isFinite(el.duration)) {
      setDuration(el.duration);
      return;
    }
    const fix = () => {
      if (!Number.isFinite(el.duration)) return;
      el.removeEventListener("durationchange", fix);
      setDuration(el.duration);
      el.currentTime = 0;
    };
    el.addEventListener("durationchange", fix);
    el.currentTime = 1e101;
  };

  if (failed) return <FileFallback a={a} url={url} note="não foi possível tocar — clique para baixar" />;
  const pct = duration ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <div className={`attachment-audio${voice ? " voice" : ""}`}>
      <audio
        ref={ref}
        src={url}
        preload="metadata"
        onLoadedMetadata={onMeta}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={(e) => {
          claim(e.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="audio-play"
        aria-label={playing ? "Pausar" : "Tocar"}
        onClick={() => {
          const el = ref.current;
          if (!el) return;
          if (el.paused) void el.play().catch(() => setFailed(true));
          else el.pause();
        }}
      >
        {playing ? <span className="pause-glyph" aria-hidden /> : <span className="play-glyph" aria-hidden />}
      </button>
      <div className="audio-body">
        <div className="audio-title">
          {voice ? (
            <>
              <Icon name="mic" size={14} /> Mensagem de voz
            </>
          ) : (
            <span title={a.file_name}>{a.file_name}</span>
          )}
        </div>
        <input
          type="range"
          className="audio-seek"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration || 1)}
          style={{ ["--pct" as string]: `${pct}%` }}
          onChange={(e) => {
            const el = ref.current;
            if (el && duration) el.currentTime = Number(e.target.value);
          }}
          aria-label="Posição"
        />
        <div className="audio-time">
          {fmtTime(time)} / {fmtTime(Math.round(duration))}
          {!voice && <small> · {formatBytes(a.size)}</small>}
        </div>
      </div>
    </div>
  );
}
