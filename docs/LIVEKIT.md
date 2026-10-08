# LiveKit

O LiveKit (self-hosted, versão testada **v1.13.9**) cuida **só da mídia**: WebRTC, SFU, Opus,
VP8/H.264, simulcast, screen share e adaptive bitrate. Usuários, permissões e quem entra em qual
call são decididos pelo Nexus Server.

## Portas (verificado com o binário v1.13.9)

O LiveKit permite que **toda a mídia UDP passe por uma única porta** (`rtc.udp_port`, "UDP mux")
em vez da faixa padrão 50000–60000. Também testamos que a porta UDP pode ter **o mesmo número**
da porta TCP de sinalização (sockets TCP e UDP independentes). Resultado: 2 portas.

| Uso | Protocolo | Config | Padrão Nexus |
|---|---|---|---|
| Sinalização (HTTP/WebSocket, API, webhook) | TCP | `port` | 7880 |
| Mídia WebRTC (UDP mux, porta única) | UDP | `rtc.udp_port` | **mesmo número da sinalização** (7880) |
| ICE sobre TCP (redes que bloqueiam UDP) | TCP | `rtc.tcp_port` | 7881 |
| TURN/UDP (opcional) | UDP | `turn.udp_port` | desligado |
| TURN/TLS (opcional, precisa de certificado) | TCP | `turn.tls_port` | desligado |

Teste feito: `livekit-server` com `port: 17880`, `rtc.udp_port: 17880`, `rtc.tcp_port: 17881`;
`netstat` mostrou TCP 17880 (HTTP) e UDP 17880 (mídia) no mesmo processo e um participante
publicou vídeo normalmente.

## Configuração

Nada de segredo em arquivo: o `livekit-server` lê as chaves de `LIVEKIT_KEYS="<key>: <secret>"`
(confirmado em `livekit-server --help`). A imagem `infrastructure/livekit/Dockerfile` gera
`livekit.yaml` a cada start a partir de variáveis:

| Variável | Significado |
|---|---|
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | par de chaves (segredo ≥ 32 caracteres), igual ao do Nexus Server |
| `LIVEKIT_PUBLIC_IP` | IP público anunciado aos clientes (`rtc.node_ip`); vazio = descobre via STUN |
| `LIVEKIT_DOMAIN` | domínio (só necessário para TURN/TLS) |
| `LIVEKIT_PORT` | porta de sinalização (vazio = `SERVER_PORT` do Pterodactyl) |
| `LIVEKIT_UDP_PORT` | porta UDP de mídia (vazio = mesma da sinalização) |
| `LIVEKIT_TCP_PORT` | porta ICE/TCP (padrão 7881) |
| `LIVEKIT_WEBHOOK_URL` | `http(s)://<nexus>/api/livekit/webhook` |
| `LIVEKIT_MAX_PARTICIPANTS` | limite por room (padrão 25) |
| `LIVEKIT_TURN_ENABLED`, `LIVEKIT_TURN_UDP_PORT`, `LIVEKIT_TURN_TLS_PORT`, `LIVEKIT_TURN_CERT`, `LIVEKIT_TURN_KEY` | TURN embutido (opcional) |

Gerar um segredo: `openssl rand -hex 32` (ou `livekit-server generate-keys`).

No Nexus Server: `LIVEKIT_URL` (endereço que os **clientes** usam, ex. `ws://203.0.113.5:7880`
ou `wss://media.exemplo.com`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` e opcionalmente
`LIVEKIT_API_URL` (endereço interno para a API RoomService).

## Tokens

O Nexus assina o JWT do LiveKit (HS256, `iss` = API key, `sub` = id do usuário, `name` =
nome de exibição) com o grant:

```json
{ "room": "nexus-call-…", "roomJoin": true, "canPublish": true, "canSubscribe": true,
  "canPublishData": true,
  "canPublishSources": ["microphone", "camera", "screen_share", "screen_share_audio"] }
```

Sem `roomAdmin`, `roomCreate` ou `roomList`. Validade de 10 minutos (o LiveKit renova o token de
quem já está conectado). Para operações administrativas (expulsar participante, apagar room) o
servidor usa um token de 60 s com `roomAdmin` só para a room em questão.

## Webhooks

O LiveKit envia `participant_left` e `room_finished` para `/api/livekit/webhook`. O servidor
valida o JWT do header `Authorization` e o claim `sha256` do corpo antes de agir. Isso mantém
o estado das calls correto quando um cliente trava ou perde a rede (validado com o LiveKit real:
matar o cliente encerrou a call no Nexus em ~20 s).

## TLS

O LiveKit não termina TLS na porta de sinalização. Opções:

1. Proxy reverso (Caddy/Nginx) na frente da porta 7880 → `wss://media.exemplo.com`.
2. Sem proxy: `ws://IP:7880`. A mídia continua criptografada (DTLS-SRTP), mas o token de
   entrada (curto, restrito à room) trafega sem TLS. Aceitável para uso entre amigos; prefira (1).

## Desenvolvimento local

```bash
# binário oficial para Windows: https://github.com/livekit/livekit/releases
$env:LIVEKIT_BIN = "C:\caminho\livekit-server.exe"
powershell -File scripts/dev-livekit.ps1
```

Usa `infrastructure/livekit/livekit.dev.yaml` (127.0.0.1, UDP mux 7882, webhook para
`127.0.0.1:3000`) e as chaves de `scripts/dev.env.example`.
