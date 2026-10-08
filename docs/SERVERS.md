# Servidores (0.2.0)

Espaços com **categorias**, **canais de texto e de voz**, **cargos com cores e permissões**,
**convites**, **expulsão** e **banimento**.

## Modelo

- **Canais são conversas.** Canais de texto (`text`) e de voz (`voice`) são linhas de
  `conversations` com `server_id`. Por isso mensagens, anexos (sem limite de tamanho), vídeo/áudio
  no chat, mensagens de voz, reações, respostas, edição, "digitando…", não lidas e chamadas
  funcionam nos canais sem código duplicado. A diferença está no acesso: num canal ele vem do
  servidor + permissões, e não de uma lista de membros.
- **Tabelas** (`migrations/0002_servers.sql`): `servers`, `server_members` (apelido),
  `server_roles` (cor, posição, permissões, destaque), `member_roles`, `server_bans`,
  `server_invites` (limite de usos, expiração), `channel_categories`, `permission_overwrites`
  (por categoria ou canal, por cargo) e `channel_reads` (estado de leitura dos canais).
- A migração reconstrói `conversations` (nova regra de tipos) pelo procedimento oficial do SQLite,
  dentro de uma transação, e **o servidor salva um backup (`data/backups/nexus-schemaN-*.db`)
  antes de qualquer migração pendente**. Testado numa cópia com dados da 0.1.x: contagens
  idênticas, integridade e chaves estrangeiras ok.

## Permissões

Bits em `services/server/src/permissions.rs` (espelhados em `packages/protocol`):

| Geral | Membros | Texto | Voz |
|---|---|---|---|
| Administrador | Criar convites | Ver canais | Conectar |
| Gerenciar servidor | Expulsar | Enviar mensagens | Falar |
| Gerenciar cargos | Banir | Enviar arquivos | Vídeo e tela |
| Gerenciar canais | Mudar o próprio apelido | Adicionar reações | |
| | Gerenciar apelidos | Gerenciar mensagens | |

Cálculo (igual ao do Discord):

1. o **dono** tem tudo;
2. base = `@everyone` + todos os cargos do membro; **Administrador** = tudo;
3. ajustes da **categoria** e depois do **canal**: em cada camada, primeiro o de `@everyone`,
   depois a união dos cargos do membro (nega e depois permite);
4. sem "Ver canais" o canal não existe para a pessoa (some da lista, 404 na API).

**Hierarquia:** só se age (expulsar, banir, cargos, apelido) sobre quem tem o cargo mais alto
*abaixo* do seu; ninguém dá permissões que não tem; o dono está acima de todos.

Nos canais de voz, "Falar" e "Vídeo e tela" viram as fontes permitidas no token do LiveKit (quem
não pode falar entra só ouvindo; sem "Conectar" não recebe token).

## Eventos

`SERVER_CREATE`, `SERVER_UPDATE`, `SERVER_DELETE`. Cada membro recebe a **própria visão** do
servidor (só os canais que pode ver, com as permissões dele). Com algumas dezenas de membros por
servidor, mandar a visão inteira a cada mudança é barato e evita bugs de sincronização. As
mensagens dos canais vão só para quem pode ver o canal.

Canais de voz **não tocam** (as pessoas entram e saem); mensagens de canais não geram
notificação nem som (só ficam como não lidas).

## Apps

- **Windows:** barra de servidores, canais por categoria (recolhíveis), quem está em cada canal
  de voz (com mutado/ensurdecido/ao vivo e anel de fala), lista de membros agrupada por cargo
  com cores, cartão de membro, convite com código para copiar, configurações do servidor
  (visão geral, cargos, membros, convites, banimentos) e do canal/categoria (nome, tópico,
  permissões por cargo com negar/herdar/permitir).
- **Android:** aba Servidores, entrar por código / criar, canais de texto (com tudo do chat) e
  de voz, convite pelo compartilhamento do Android. Cargos/permissões/moderação ficam no Windows
  por enquanto.

## API

`POST /api/servers` · `GET|PATCH|DELETE /api/servers/{id}` · `POST|DELETE /api/servers/{id}/icon` ·
`POST /api/servers/{id}/transfer` · `DELETE /api/servers/{id}/members/@me` ·
`PATCH|DELETE /api/servers/{id}/members/{user}` · `GET /api/servers/{id}/bans` ·
`PUT|DELETE /api/servers/{id}/bans/{user}` · `GET|POST /api/servers/{id}/invites` ·
`GET|POST|DELETE /api/server-invites/{code}` · `POST /api/servers/{id}/roles` ·
`PUT /api/servers/{id}/roles/order` · `PATCH|DELETE /api/servers/{id}/roles/{role}` ·
`POST /api/servers/{id}/categories` · `PATCH|DELETE /api/servers/{id}/categories/{cat}` ·
`POST /api/servers/{id}/channels` · `PATCH|DELETE /api/servers/{id}/channels/{ch}` ·
`PUT /api/servers/{id}/layout` · `PUT|DELETE /api/servers/{id}/overwrites/{alvo}/{cargo}`.

Testes: `services/server/tests/servers.rs` (estrutura, convites, eventos, canais privados,
hierarquia, banimento, canais de voz) e `src/permissions.rs` (motor de permissões).
