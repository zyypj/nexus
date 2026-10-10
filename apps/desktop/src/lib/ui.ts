import { type Id, Permissions } from "@nexus/protocol";
import { create } from "zustand";

/**
 * Desktop-only navigation state, remembered between sessions: which server
 * is open (null = Início/DMs), the last channel of each server and the
 * collapsed categories.
 */
interface UiState {
  serverId: Id | null;
  lastChannel: Record<Id, Id>;
  collapsed: Record<Id, boolean>;
  memberList: boolean;
  /** Height of the call area as a fraction of the chat; null = automatic. */
  callSize: number | null;
  /** Order of the server icons, set by dragging them (this device only). */
  serverOrder: Id[];
  set: (patch: Partial<Omit<UiState, "set">>) => void;
}

const KEY = "nexus.ui.v1";

function load(): Partial<UiState> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<UiState>;
  } catch {
    return {};
  }
}

export const useUi = create<UiState>()((set, get) => ({
  serverId: null,
  lastChannel: {},
  collapsed: {},
  callSize: null,
  serverOrder: [],
  // Narrow windows start without the member list (it would cover the chat).
  memberList: typeof window === "undefined" || window.innerWidth >= 1100,
  ...load(),
  set: (patch) => {
    set(patch);
    const { set: _omit, ...data } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      // storage full / disabled: navigation state is a convenience only
    }
  },
}));

/** Labels and help text for the permission editor. */
export const PERMISSION_INFO: { key: keyof typeof Permissions; label: string; help: string; group: string }[] = [
  { key: "ADMINISTRATOR", label: "Administrador", help: "Todas as permissões e ignora restrições de canais.", group: "Geral" },
  { key: "MANAGE_SERVER", label: "Gerenciar servidor", help: "Mudar nome e ícone, ver e apagar convites.", group: "Geral" },
  { key: "MANAGE_ROLES", label: "Gerenciar cargos", help: "Criar e editar cargos abaixo do seu e as permissões dos canais.", group: "Geral" },
  { key: "MANAGE_CHANNELS", label: "Gerenciar canais", help: "Criar, editar, mover e apagar canais e categorias.", group: "Geral" },
  { key: "CREATE_INVITE", label: "Criar convites", help: "Gerar códigos para chamar pessoas.", group: "Membros" },
  { key: "KICK_MEMBERS", label: "Expulsar membros", help: "Remover membros com cargo abaixo do seu.", group: "Membros" },
  { key: "BAN_MEMBERS", label: "Banir membros", help: "Banir e desbanir; banidos não voltam por convite.", group: "Membros" },
  { key: "CHANGE_NICKNAME", label: "Mudar o próprio apelido", help: "", group: "Membros" },
  { key: "MANAGE_NICKNAMES", label: "Gerenciar apelidos", help: "Mudar o apelido de membros abaixo de você.", group: "Membros" },
  { key: "VIEW_CHANNEL", label: "Ver canais", help: "Sem isso o canal fica invisível.", group: "Texto" },
  { key: "SEND_MESSAGES", label: "Enviar mensagens", help: "", group: "Texto" },
  { key: "ATTACH_FILES", label: "Enviar arquivos", help: "Imagens, vídeos, áudios e mensagens de voz.", group: "Texto" },
  { key: "ADD_REACTIONS", label: "Adicionar reações", help: "", group: "Texto" },
  { key: "MANAGE_MESSAGES", label: "Gerenciar mensagens", help: "Apagar mensagens de outras pessoas.", group: "Texto" },
  { key: "CONNECT", label: "Conectar", help: "Entrar nos canais de voz.", group: "Voz" },
  { key: "SPEAK", label: "Falar", help: "Sem isso a pessoa só escuta.", group: "Voz" },
  { key: "VIDEO", label: "Vídeo e tela", help: "Câmera e compartilhamento de tela.", group: "Voz" },
  { key: "MOVE_MEMBERS", label: "Mover membros", help: "Levar quem está num canal de voz para outro.", group: "Voz" },
];

/** Role color presets (Nexus palette + classics). */
export const ROLE_COLORS = [
  0x5b73f7, 0x9b5cf6, 0xec4899, 0xf4506b, 0xf97316, 0xf5b041, 0x2fd27a, 0x14b8a6, 0x22d3ee, 0x3b82f6, 0x94a3b8, 0xe9ebf8,
];

export const colorHex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

/** Stable gradient for a server without an icon. */
export function serverGradient(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 58%), hsl(${(a + 50) % 360} 72% 48%))`;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}
