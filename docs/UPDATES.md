# Atualizações automáticas (GitHub Releases)

O projeto é aberto e as versões são publicadas como **GitHub Releases** em
[`zyypj/nexus`](https://github.com/zyypj/nexus/releases). Servidor, LiveKit, app Windows e app
Android se atualizam sozinhos a partir delas.

## Publicar uma versão

```bash
node scripts/release.mjs 0.2.0     # atualiza versões, Cargo.lock, commit e tag v0.2.0
git push origin HEAD v0.2.0         # dispara .github/workflows/release.yml
```

O workflow:

1. confere se a tag bate com as versões dos manifestos (`scripts/set-version.mjs --check`);
2. cria a release como **pré-release** (os updaters ignoram);
3. em paralelo: testa e compila o servidor (binário Linux estático, musl), o instalador Windows
   assinado + `latest.json`, e o APK Android;
4. promove a release a **latest** — a partir daí todos os clientes e servidores enxergam.

Assets publicados:

| Asset | Quem usa |
|---|---|
| `nexus-server-linux-x86_64.tar.gz` + `.sha256`, `VERSION` | egg Nexus (Pterodactyl) |
| `nexus-start.sh`, `livekit-start.sh`, `egg-*.json` | instalação dos eggs |
| `Nexus_<v>_x64-setup.exe` + `.sig`, `latest.json` | app Windows |
| `nexus-android.apk` | app Android |

## Servidor (Pterodactyl)

O egg usa a imagem genérica `ghcr.io/parkervcp/yolks:debian` — **não é preciso publicar imagem
Docker**. A cada start, `nexus-start.sh`:

1. lê `VERSION` da última release (ou da versão fixada em `NEXUS_VERSION`);
2. se for diferente da instalada, baixa o `.tar.gz`, **confere o SHA-256** e troca o binário
   (e o próprio launcher) de forma atômica;
3. se o GitHub estiver fora do ar ou o download falhar, **sobe a versão já instalada**.

Para atualizar: publique a release e reinicie o servidor no painel (ou agende um restart diário
em *Schedules*). Variáveis: `GITHUB_REPO` (padrão `zyypj/nexus`), `NEXUS_VERSION` (`latest` ou
`0.2.0`), `AUTO_UPDATE` (`1`/`0`). As migrations do banco rodam sozinhas na inicialização.

LiveKit: `livekit-start.sh` instala o binário **oficial** de `github.com/livekit/livekit`
conferindo o `checksums.txt` publicado por eles. `LIVEKIT_VERSION` vem fixado na versão testada
(1.13.9); use `latest` para acompanhar novas versões.

Testado localmente (`/d/nexus-build/ptero-test`): instalação inicial, "já atualizado", checksum
adulterado (recusado, mantém a versão atual), GitHub inacessível (sobe a versão instalada) e
download real do LiveKit 1.13.9 com verificação de checksum.

## App Windows

`tauri-plugin-updater`: o app baixa
`https://github.com/zyypj/nexus/releases/latest/download/latest.json`, confere a **assinatura
minisign** do instalador com a chave pública embutida em `tauri.conf.json` e instala em modo
passivo. Uma release sem assinatura válida é rejeitada.

- Procura atualizações 15 s após abrir e depois a cada 6 h.
- Com "Baixar atualizações automaticamente" (padrão), baixa em segundo plano; o usuário só clica
  em **Reiniciar e atualizar** (se estiver em chamada, o app pergunta antes).
- Configurações → Aplicativo → **Procurar atualizações** força uma checagem.

Chaves: a privada (com senha) fica **fora do repositório** e vai para os secrets do GitHub
`TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Se a chave for perdida, os
apps instalados não aceitam mais atualizações — guarde um backup. Os artefatos de update só são
gerados com `--config src-tauri/tauri.release.conf.json`, então builds locais não precisam da
chave.

## App Android

Sem Play Store: o app consulta `https://api.github.com/repos/zyypj/nexus/releases/latest`
(na abertura e a cada 6 h), compara com a própria versão e mostra
"Nexus X disponível — toque para atualizar". O APK é baixado pelo `DownloadManager` para a pasta
privada do app e entregue ao instalador do Android, que **sempre pede confirmação** e só aceita
um APK assinado com a **mesma chave** do instalado. Na primeira vez o Android pede para permitir
"instalar apps desconhecidos" para o Nexus.

Assinatura: configure os secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` e `ANDROID_KEY_PASSWORD`. Sem eles o CI assina com a chave de debug pública
do template (funciona, mas qualquer pessoa poderia gerar um APK "compatível"). Trocar de chave
depois exige desinstalar e reinstalar o app.

## Versões

`scripts/set-version.mjs` mantém iguais: `services/server/Cargo.toml`,
`apps/desktop/src-tauri/Cargo.toml`, `tauri.conf.json`, `apps/desktop/package.json`,
`apps/android/package.json` e `versionName`/`versionCode` do Android
(`versionCode = major*10000 + minor*100 + patch`).
