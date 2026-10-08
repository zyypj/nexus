# Segurança

Mesmo sendo entre amigos, o Nexus é exposto à internet. Este documento lista o que é protegido,
como, e onde está testado.

## Cadastro e autenticação

| Item | Implementação | Teste |
|---|---|---|
| Cadastro fechado | `ALLOW_PUBLIC_REGISTRATION=false` (padrão) exige convite válido | `auth.rs::register_requires_invite_when_registration_is_private` |
| Convites | `NEXUS-XXXX-XXXX` (40 bits aleatórios), uso máximo, expiração, revogação; consumo atômico **dentro da transação** do cadastro | `invite_respects_max_uses_and_expiry`, `failed_signup_does_not_burn_invite` |
| Senhas | **Argon2id** v19 (m=19 MiB, t=2, p=1 — baseline OWASP), em thread de bloqueio; nunca armazenadas em texto | `first_user_is_admin_and_password_is_hashed` |
| Enumeração de usuários | login com usuário inexistente executa um Argon2 "falso" (tempo equivalente) e retorna a mesma mensagem | — |
| Access token | JWT HS256, 15 min, claim `typ` dedicado, `sid` da sessão | `tokens.rs` (unit) |
| Revogação imediata | cada requisição confere a sessão no banco: logout/desativação valem na hora, não no vencimento do JWT | `login_logout_and_session_revocation`, `disabled_user_is_locked_out` |
| Refresh token | `<session>.<segredo 256 bits>`, só o SHA-256 é guardado; **rotação** a cada uso com compare-and-swap; reuso de token antigo revoga a sessão inteira | `refresh_rotates_and_detects_reuse` |
| Troca de senha | encerra todas as outras sessões | `password_change_signs_out_other_sessions` |
| WebSocket | token enviado **dentro** do socket (IDENTIFY), nunca na URL (não vaza em logs de proxy); sessão revogada fecha o socket (`4001`) | `invalid_token_is_rejected`, `logout_closes_the_socket` |
| Armazenamento no cliente | Windows: Credential Manager (DPAPI). Android: Keystore (react-native-keychain) | — |

`JWT_SECRET` precisa de ≥ 32 caracteres; no Docker/Pterodactyl, se vazio, é gerado e salvo em
`data/.jwt_secret` (permissão 600).

## Autorização

- Conversas/mensagens/anexos/calls: quem não é membro recebe **404** (não descobre que existe).
  Teste: `messaging.rs::non_members_cannot_see_conversations`.
- DMs só entre amigos; bloqueio congela a DM (mensagens, reações, calls, pedidos de amizade).
  Teste: `blocking_cuts_contact`.
- Grupos: só amigos podem ser adicionados; só o dono remove; dono saindo transfere a posse.
- **Calls**: token LiveKit só é emitido para membros da conversa, é **restrito à room** daquela
  call, sem `roomAdmin`/`roomCreate`/`roomList`, expira em 10 min. Membro removido do grupo é
  expulso da room via RoomService (`RemoveParticipant`), pois o LiveKit renova tokens de quem já
  está conectado. Testes: `non_member_cannot_get_a_token`, `removed_member_is_dropped_from_call`,
  `livekit::tests::join_token_is_room_scoped`.
- Webhook do LiveKit: JWT assinado com o segredo da API + claim `sha256` do corpo conferido em
  tempo constante. Teste: `livekit_webhook_reconciles_crashed_clients`.
- Admin: `is_admin` (primeiro usuário cadastrado, ou `nexus-server admin user promote`).

## Uploads

- Limite por arquivo (`MAX_UPLOAD_SIZE`), aplicado **durante** o streaming para disco
  (o arquivo nunca é bufferizado inteiro em memória); arquivo temporário apagado em erro.
- Nome interno: 128 bits aleatórios em hex; validado por regex antes de virar caminho →
  **path traversal impossível por construção**. O nome original só é usado para exibição e
  `Content-Disposition` (sanitizado).
- Tipo detectado pelos *magic bytes*, não pela extensão. Só PNG/JPEG/GIF/WebP são servidos
  inline; todo o resto vai como `application/octet-stream` + `attachment`.
- Cabeçalhos: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`.
- Download por URL assinada (HMAC-SHA256 com chave derivada, expira em 24 h) entregue apenas a
  membros. Teste: `attachments_upload_download_and_access_control`, `upload_size_limit`.
- Uploads nunca enviados são apagados após 24 h.

## Payloads e limites

- JSON limitado a 64 KB; mensagens até 4000 caracteres; até 10 anexos; reações validadas;
  usernames `[a-z0-9_.]{2,32}`; frames WebSocket até 16 KB; caracteres de controle removidos.
- Rate limit por IP (auth: 10/min) e por usuário (mensagens 5/s com burst 10, uploads 20/min,
  calls 20/min, pedidos de amizade 10/min). `TRUST_PROXY=true` só atrás de proxy confiável.
- CORS restrito às origens do app Tauri (+ `CORS_ORIGINS`).

## Logs

Nenhum token, senha ou assinatura é logado: o `TraceLayer` registra só método e **path** (sem
query string, que contém assinaturas de URL), e tokens nunca aparecem em URLs.

## Cliente desktop

- CSP restritiva no WebView (`script-src 'self' 'wasm-unsafe-eval'`).
- Mensagens renderizadas como nós de texto React (sem HTML) — sem XSS por markdown.
- Links abrem no navegador do sistema (plugin opener), nunca dentro do app.
- Permissões de mídia concedidas só ao conteúdo empacotado do app.

## Transporte

- Mídia WebRTC é sempre criptografada (DTLS-SRTP).
- API: use HTTPS. Sem proxy reverso, o servidor pode terminar TLS sozinho
  (`NEXUS_TLS_CERT`/`NEXUS_TLS_KEY`). Sinalização do LiveKit: use `wss://` atrás de um proxy
  com TLS quando possível (ver [LIVEKIT.md](LIVEKIT.md)).

## Pendências conhecidas

- Sem 2FA.
- Sem criptografia ponta a ponta de mensagens (o servidor lê o conteúdo; é self-hosted).
