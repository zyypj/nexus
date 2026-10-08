# Hospedagem no Pterodactyl

São só **dois servidores** no painel: **Nexus Server** (API + WebSocket + SQLite + uploads) e
**Nexus LiveKit** (mídia). Os eggs estão em `infrastructure/pterodactyl/`.

## 1. Como funciona

Os eggs usam a imagem genérica `ghcr.io/parkervcp/yolks:debian` — **nenhuma imagem Docker
precisa ser publicada**. O Nexus Server é baixado das
[GitHub Releases](https://github.com/zyypj/nexus/releases) e **se atualiza sozinho a cada
start** (SHA-256 conferido); o LiveKit usa o binário oficial do projeto LiveKit. Detalhes em
[UPDATES.md](UPDATES.md).

Pré-requisito: existir ao menos uma release publicada (`node scripts/release.mjs 0.1.0` e
`git push origin HEAD v0.1.0`).

Os Dockerfiles (`services/server/Dockerfile`, `infrastructure/livekit/Dockerfile`) continuam
disponíveis para quem preferir Docker puro.

## 2. Importar os eggs

Admin → Nests → crie um nest "Nexus" → **Import Egg** → `egg-nexus-server.json` e
`egg-nexus-livekit.json` (estão no repositório em `infrastructure/pterodactyl/` e anexados a
cada release).

Variáveis de atualização do egg Nexus: `GITHUB_REPO` (`zyypj/nexus`), `NEXUS_VERSION` (`latest`
ou uma versão fixa) e `AUTO_UPDATE` (`1`). Para receber uma versão nova basta reiniciar o
servidor — dá para automatizar com um *Schedule* diário de restart no painel.

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
| Max upload size | `0` (sem limite; ou ex. `2GB`) |
| Min free disk | `1GB` (uploads recusados se o disco ficaria abaixo disso) |

Persistência: `NEXUS_DATA_DIR=/home/container/data`, ou seja, `data/nexus.db` (+ WAL) e
`data/uploads/` ficam no volume do servidor e sobrevivem a reinstalações da imagem.
**Backup**: copie a pasta `data/` com o servidor parado (ou use `sqlite3 nexus.db ".backup x.db"`).

## 7. Primeiro acesso

Digite no **console do servidor Nexus** no painel (o servidor lê comandos do stdin):

```
invite create --max-uses 1 --expires-in 7d
```

Saída:

```
Invite criado:
NEXUS-H7Q2-P9KA
```

O **primeiro** usuário cadastrado vira administrador e pode gerar convites pelo app
(Amigos → Convites). Outros comandos do console: `help`, `invite list`, `invite revoke CODE`,
`user list`, `user disable NOME`, `user enable NOME`, `user promote NOME`, `user demote NOME`.
Fora do painel, os mesmos comandos existem como `nexus-server admin <comando>`
(ex. `docker exec -it <container> nexus-server admin user list`).

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
