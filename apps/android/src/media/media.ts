import type { Attachment, Id } from '@nexus/protocol';
import { create } from 'zustand';
import { client } from '../lib/nexus';
import { NexusNative } from '../native/NexusNative';

const VOICE_PREFIX = 'mensagem-de-voz';
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/3gpp']);

export type MediaKind = 'image' | 'video' | 'voice' | 'audio' | 'file';

export function mediaKind(a: Attachment): MediaKind {
  if (a.content_type.startsWith('image/')) return 'image';
  if (a.file_name.startsWith(VOICE_PREFIX)) return 'voice';
  if (VIDEO_TYPES.has(a.content_type) || a.content_type.startsWith('video/')) return 'video';
  if (a.content_type.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface GalleryItem {
  attachment: Attachment;
  url: string;
  authorId: Id;
  createdAt: number;
}

interface ViewerState {
  items: GalleryItem[];
  index: number;
}

/** Image viewer state; rendered once by <ImageViewer /> at the app root. */
export const useViewer = create<ViewerState>()(() => ({ items: [], index: 0 }));

export const closeViewer = () => useViewer.setState({ items: [], index: 0 });

/**
 * Opens the image viewer on one attachment, with every image already loaded
 * in that conversation as a swipeable gallery (oldest → newest).
 */
export function openImage(conversationId: Id, attachmentId: Id) {
  const s = client().store.getState();
  const items: GalleryItem[] = [];
  for (const m of s.messages[conversationId]?.items ?? []) {
    for (const a of m.attachments) {
      if (mediaKind(a) !== 'image') continue;
      items.push({ attachment: a, url: client().api.url(a.url) ?? '', authorId: m.author_id, createdAt: m.created_at });
    }
  }
  const index = items.findIndex((i) => i.attachment.id === attachmentId);
  if (index >= 0) useViewer.setState({ items, index });
}

/** Full-screen native player. */
export function openVideo(a: Attachment) {
  NexusNative.playVideo(client().api.url(a.url) ?? '', a.file_name, a.content_type || 'video/*');
}
