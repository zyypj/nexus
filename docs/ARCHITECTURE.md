# Arquitetura

Nexus é um app de comunicação privado para algumas dezenas de pessoas. A
arquitetura é deliberadamente pequena: **dois serviços**, **um banco SQLite**,
**um WebSocket por cliente**.

```
                 ┌──────────────────────────── Pterodactyl node ───────────────────────────┐
                 │                                                                          │
 Windows (Tauri) │  ┌───────────────────────────┐        webhook         ┌───────────────┐ │
 Android (RN)    │  │  Nexus Server (Rust/Axum) │ ◄───────────────────── │ LiveKit (SFU) │ │
   │   │         │  │  REST /api + /gateway WS  │ ──── RoomService ────► │  media only   │ │
   │   │ HTTPS/WS│  │  SQLite (WAL) + uploads   │                        └──────▲────────┘ │
   │   └─────────┼─►│  /data/nexus.db           │                               │          │
   │             │  │  /data/uploads/           │                               │          │
   │             │  └───────────────────────────┘                               │          │
   │             └──────────────────────────────────────────────────────────────┼──────────┘
   └──────────── WebRTC (UDP mux 1 porta / ICE-TCP) ────────────────────────────┘
```

## Responsabilidades

| Serviço | Faz | Não faz |
|---|---|---|
| **Nexus Server** (`services/server`) | usuários, convites, autenticação, sessões, amizades, bloqueios, DMs, grupos, mensagens, reações, leitura/não lidas, uploads, presença, digitando, WebSocket, autorização, criação de calls e **emissão de tokens LiveKit** | tráfego de mídia |
| **LiveKit** (self-hosted) | WebRTC, SFU, Opus, VP8/H.264, simulcast, screen share, adaptive bitrate | usuários, permissões, decisões de quem entra |

Fluxo de uma chamada:

1. Cliente → `POST /api/conversations/{id}/call` (ou `/api/calls/{id}/join`).
2. Servidor verifica se o usuário é membro da conversa (e se não há bloqueio em DM).
3. Servidor cria (ou reaproveita) a call ativa da conversa — **uma room LiveKit por call**,
   nome aleatório `nexus-call-<12 hex>` — e assina um JWT LiveKit **válido só para essa room**,
   com identidade = id do usuário.
4. Cliente conecta direto no LiveKit com esse token.
5. LiveKit avisa o servidor por webhook (`participant_left`, `room_finished`) quando alguém cai;
   o servidor também remove participantes cujo gateway caiu há mais de 45 s.

Calls de conversas diferentes são rooms diferentes: Grupo A (João, Pedro, Lucas) e Grupo B
(Carlos, Marcos) falam ao mesmo tempo sem nenhuma interferência — testado em
`services/server/tests/calls.rs::simultaneous_calls_are_isolated`.

## Servidor (Rust)

- **Axum 0.8 + Tokio**, um binário (`nexus-server`), runtime limitado a ≤ 4 threads.
- **SQLite via SQLx 0.9**, WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5s`,
  migrations embutidas (`services/server/migrations`).
- IDs **UUIDv7** (texto): ordem lexicográfica = ordem cronológica; paginação e contagem de não
  lidas usam isso diretamente.
- Hub do gateway em memória (`gateway/hub.rs`): eventos serializados **uma vez** e compartilhados
  entre destinatários; fila por conexão limitada (256) — cliente lento é desconectado.
- Rate limit em memória (token bucket) — sem Redis.
- Uploads em disco com nomes aleatórios de 128 bits, URLs assinadas (HMAC) de 24 h.
- Admin via CLI (`nexus-server admin ...`) e API `/api/admin/*`.

### Migração futura para PostgreSQL

Todo acesso passa por `db::Db` (`services/server/src/db.rs`). Pontos específicos de SQLite:
índices únicos parciais (`WHERE ended_at IS NULL`), `INSERT OR IGNORE` e o placeholder `?`.
Para migrar: trocar o alias para `PgPool`, reescrever as migrations (os índices parciais existem
no Postgres), trocar `INSERT OR IGNORE` por `ON CONFLICT DO NOTHING` e `?` por `$n`.
Nada disso é feito agora: não há necessidade para dezenas de usuários.

## Gateway (WebSocket)

Uma conexão por cliente em `/gateway`:

| Direção | Frame |
|---|---|
| S→C | `HELLO {heartbeat_interval_ms}` |
| C→S | `{"op":"IDENTIFY","d":{"token":"<access>"}}` (o token **nunca** vai na URL) |
| S→C | `READY {...estado completo...}` — também é o ponto de re-sync após reconectar |
| C→S | `{"op":"HEARTBEAT"}` a cada 30 s → `HEARTBEAT_ACK` |
| C→S | `TYPING_START` / `TYPING_STOP` |
| S→C | `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_REACTION_ADD/REMOVE`, `CONVERSATION_READ`, `TYPING_START/STOP`, `FRIEND_REQUEST`, `FRIEND_REQUEST_DELETE`, `FRIEND_ACCEPT`, `FRIEND_REMOVE`, `USER_BLOCK/UNBLOCK`, `USER_UPDATE`, `PRESENCE_UPDATE`, `CONVERSATION_CREATE/UPDATE/DELETE`, `CALL_CREATE`, `CALL_JOIN`, `CALL_LEAVE`, `CALL_STATE_UPDATE`, `CALL_END` |

Cliente (`packages/shared/src/gateway.ts`): heartbeat por um único `setTimeout` encadeado (só
enquanto conectado), detecção de conexão zumbi (ACK ausente), reconexão com **backoff
exponencial com jitter** (1 s → 30 s), refresh do token em `4004` e re-sync via `READY` +
recarga da conversa aberta. Sem polling.

Códigos de fechamento: `4001` sessão revogada/conta desativada/cliente lento, `4002` payload
inválido, `4003` heartbeat expirado, `4004` autenticação falhou, `4005` IDENTIFY duplicado.

## Clientes

```
packages/protocol  tipos do protocolo (espelho de models.rs)
packages/shared    ApiClient, GatewayClient, store (zustand vanilla), NexusClient
packages/ui        tokens visuais (cores, espaçamento) usados por desktop e Android
apps/desktop       Tauri 2 + React + Vite; Rust nativo para hotkeys, áudio e credenciais
apps/android       React Native + Kotlin (MediaProjection, AudioPlaybackCapture, serviço em primeiro plano)
```

A lógica de estado (aplicar eventos do gateway, mensagens otimistas, não lidas, digitando,
calls) é **compartilhada** entre Windows e Android em `packages/shared/src/store.ts`, com testes.

### Windows (Tauri 2)

- WebView2 (Chromium do sistema) em vez de Electron: sem runtime Chromium próprio no instalador
  (instalador NSIS de ~2 MB).
- `livekit-client` carregado **sob demanda** ao entrar numa call (bundle inicial 336 KB em vez de 864 KB).
- Lista de mensagens virtualizada (`@tanstack/react-virtual`).
- Rust nativo (`apps/desktop/src-tauri/src`):
  - `hotkeys.rs`: hooks de baixo nível teclado/mouse (push-to-talk funciona minimizado / em jogo);
  - `system_audio.rs`: WASAPI **process loopback** excluindo a árvore de processos do Nexus;
  - `secrets.rs`: refresh token no Windows Credential Manager.

Detalhes em [WINDOWS.md](WINDOWS.md), [AUDIO.md](AUDIO.md), [SCREEN_SHARE.md](SCREEN_SHARE.md).

## Dados

Tabelas: `users`, `sessions`, `invites`, `friend_requests`, `friendships`, `blocked_users`,
`conversations`, `conversation_members`, `messages`, `message_reactions`, `message_attachments`,
`calls`, `call_participants` (ver `services/server/migrations/0001_init.sql`).

Persistência: `/data/nexus.db` (+ `-wal`, `-shm`) e `/data/uploads/{files,avatars,tmp}`.
No Pterodactyl, `/data` = `/home/container/data`.
