import type { Id } from "@nexus/protocol";
import { create } from "zustand";

/**
 * Server dialogs and the profile card, opened from anywhere (header menu,
 * right-click menus, member list) and rendered once by GlobalDialogs.
 */
export type ServerDialog =
  | { kind: "invite"; serverId: Id }
  | { kind: "settings"; serverId: Id }
  | { kind: "channel"; serverId: Id; categoryId: Id | null; type: "text" | "voice" }
  | { kind: "category"; serverId: Id }
  | { kind: "channelSettings"; serverId: Id; channelId: Id }
  | { kind: "leave"; serverId: Id }
  | { kind: "nickname"; serverId: Id; userId: Id };

export interface ProfileCard {
  userId: Id;
  /** Server context: nickname, roles and moderation. */
  serverId: Id | null;
  x: number;
  y: number;
}

interface DialogState {
  dialog: ServerDialog | null;
  profile: ProfileCard | null;
}

export const useDialogs = create<DialogState>()(() => ({ dialog: null, profile: null }));

export const openDialog = (dialog: ServerDialog) => useDialogs.setState({ dialog, profile: null });
export const closeDialog = () => useDialogs.setState({ dialog: null });
export const openProfile = (profile: ProfileCard) => useDialogs.setState({ profile });
export const closeProfile = () => useDialogs.setState({ profile: null });
