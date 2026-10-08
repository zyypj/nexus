# Hospedagem no Pterodactyl

São só **dois servidores** no painel: **Nexus Server** (API + WebSocket + SQLite + uploads) e
**Nexus LiveKit** (mídia). Os eggs estão em `infrastructure/pterodactyl/`.

## 1. Imagens Docker

Os eggs usam imagens próprias:

| Egg | Imagem | Dockerfile |
|---|---|---|
| Nexus Server | `ghcr.io/OWNER/nexus-server:latest` | `services/server/Dockerfile` (contexto: raiz do repo) |
| Nexus LiveKit | `ghcr.io/OWNER/nexus-livekit:latest` | `infrastructure/livekit/Dockerfile` |

Opção A — GitHub Actions: suba o repositório no GitHub e rode **Actions → Docker images →
Run workflow** (ou crie uma tag `v0.1.0`). As imagens vão para o GHCR da sua conta. Torne os
pacotes públicos (ou configure credenciais do registry no Wings).

Opção B — manual, em qualquer máquina com Docker:

```bash
docker build -f services/server/Dockerfile -t ghcr.io/SEU_USUARIO/nexus-server:latest .
docker build -t ghcr.io/SEU_USUARIO/nexus-livekit:latest infrastructure/livekit
docker push ghcr.io/SEU_USUARIO/nexus-server:latest
docker push ghcr.io/SEU_USUARIO/nexus-livekit:latest
```

Depois de importar os eggs, troque `OWNER` pelo seu usuário em **Admin → Nests → (egg) →
Docker Images** (ou edite o JSON antes de importar).

## 2. Importar os eggs

Admin → Nests → crie um nest "Nexus" → **Import Egg** → `egg-nexus-server.json` e
`egg-nexus-livekit.json`.

## 3. Allocations (portas)

Pterodactyl mapeia cada allocation em **TCP e UDP** com o mesmo número. O Nexus aproveita isso.

| Servidor | Allocation | TCP | UDP | Obrigatória |
|---|---|---|---|---|
| Nexus Server | primária (ex. **3000**) | API HTTP + WebSocket `/gateway` | — | sim |
| Nexus LiveKit | primária (ex. **7880**) | sinalização LiveKit (WebSocket/API/webhook) | **toda a mídia WebRTC** (UDP mux, porta única) | sim |
| Nexus LiveKit | adicional (ex. **7881**) | ICE/TCP (fallback quando UDP é bloqueado) | — | sim (recomendada) |
| Nexus LiveKit | adicional (ex. 3478) | — | TURN/UDP | não |
| Nexus LiveKit | adicional (ex. 5349 ou 443) | TURN/TLS (precisa de certificado) | — | não |

Total mínimo: **3 portas** (1 Nexus + 2 LiveKit). Nenhum range UDP grande é necessário.
Libere no firewall do node: `3000/tcp`, `7880/tcp`, `7880/udp`, `7881/tcp`.

## 4. Segredos

Gere **um** segredo para o LiveKit e use-o nos dois servidores:

```bash
openssl rand -hex 32
```

Nada fica dentro dos eggs: os valores são variáveis do servidor no painel (marcadas como não
visíveis ao usuário final). O `JWT_SECRET` do Nexus pode ficar vazio: na primeira inicialização
é gerado e salvo em `/home/container/data/.jwt_secret`.

## 5. Criar o servidor LiveKit

Variáveis:

| Variável | Valor |
|---|---|
| API key | `nexus` |
| API secret | o segredo gerado |
| Public IP | IP público do node (ex. `203.0.113.5`) |
| Signaling port / UDP media port | vazios (usam a allocation primária) |
| ICE/TCP port | número da 2ª allocation (ex. `7881`) |
| Webhook URL | `http://203.0.113.5:3000/api/livekit/webhook` (endereço do Nexus Server) |

O `livekit.yaml` é gerado a cada start a partir dessas variáveis (sem segredos no arquivo; as
chaves vão por `LIVEKIT_KEYS`). Console mostra, por exemplo:
`livekit: signaling tcp/7880, media udp/7880, ice-tcp tcp/7881, public ip 203.0.113.5`.

## 6. Criar o servidor Nexus

| Variável | Valor |
|---|---|
| Public URL | `http://203.0.113.5:3000` (ou o domínio HTTPS) |
| LiveKit URL | `ws://203.0.113.5:7880` (ou `wss://media.exemplo.com` com proxy TLS) |
| LiveKit API URL | opcional, ex. `http://172.18.0.1:7880` para falar com o LiveKit pela rede interna |
| LiveKit API key / secret | os mesmos do LiveKit |
| Public registration | `false` |
| Max upload size | `25MB` |

Persistência: `NEXUS_DATA_DIR=/home/container/data`, ou seja, `data/nexus.db` (+ WAL) e
`data/uploads/` ficam no volume do servidor e sobrevivem a reinstalações da imagem.
**Backup**: copie a pasta `data/` com o servidor parado (ou use `sqlite3 nexus.db ".backup x.db"`).

## 7. Primeiro acesso

No console do servidor Nexus (ou via SFTP/terminal do container):

```bash
nexus-server admin invite create --max-uses 1 --expires-in 7d
```

Saída:

```
Invite criado:
NEXUS-H7Q2-P9KA
```

O **primeiro** usuário cadastrado vira administrador e pode gerar convites pelo app
(Amigos → Convites). Outros comandos: `admin invite list`, `admin invite revoke CODE`,
`admin user list`, `admin user disable NOME`, `admin user enable NOME`, `admin user promote NOME`.

> No Pterodactyl o console envia texto para o stdin do processo, não executa comandos. Rode os
> comandos administrativos pelo SFTP+terminal do node (`docker exec -it <container> nexus-server
> admin ...`) ou pelo app (contas admin).

## 8. HTTPS (recomendado)

O Pterodactyl não fornece TLS. Opções:

1. Proxy reverso (Caddy/Nginx) no node: `https://chat.exemplo.com → 127.0.0.1:3000` e
   `wss://media.exemplo.com → 127.0.0.1:7880`. Defina `TRUST_PROXY=true` no Nexus.
2. TLS direto no Nexus: coloque `fullchain.pem`/`privkey.pem` em `/home/container/tls/` e
   preencha `NEXUS_TLS_CERT`/`NEXUS_TLS_KEY`.

A mídia WebRTC é sempre criptografada (DTLS-SRTP), com ou sem TLS na sinalização.

## Diagnóstico

- `curl http://IP:3000/health` → `{"ok":true,...}`.
- Calls não conectam: confira o firewall para **UDP 7880** e TCP 7881, e se `Public IP` está
  correto (é o endereço anunciado aos clientes).
- Calls "fantasmas" após queda: confira se o `Webhook URL` do LiveKit alcança o Nexus.
