# Benchmarks

Todos os números abaixo foram **medidos** nesta máquina com as ferramentas do repositório.
Nada é estimado. Onde as condições não são equivalentes, isso está dito.

## Máquina e método

- Windows 11 (build 26300), 24 núcleos lógicos, notebook ligado na tomada.
- App: build **release** (`npm run desktop:build`), WebView2 154.
- Servidor e LiveKit v1.13.9 rodando localmente (`scripts/dev-*.ps1`).
- Ferramenta: `scripts/perf-bench` (`nexus-bench`). Soma **o processo do app e todos os filhos**
  (no Nexus: os processos do WebView2; no Discord: os helpers do Electron).
  - **Privada**: memória comprometida exclusiva dos processos (sem páginas compartilhadas) — a
    métrica mais justa para comparar apps.
  - **Working set**: memória física mapeada, inclui DLLs compartilhadas com o Edge/sistema.
  - **CPU**: % de **um** núcleo somado na árvore (100% = um núcleo inteiro), média e p95.
- Participantes extras: `lk load-test` (CLI oficial do LiveKit) entrando na mesma room com áudio
  e/ou vídeo sintéticos; script `scripts/bench-calls.sh` (60 s de amostra após 20 s de
  aquecimento, 1 amostra/s). O script descarta o cenário se o app sair da call.

```bash
cargo build --release -p nexus-bench
nexus-bench startup --exe path\to\nexus-desktop.exe --runs 5
nexus-bench measure --process nexus-desktop.exe --duration 60 --label idle
LK=lk BENCH=nexus-bench EXPECT_IDENTITY=<id do usuário> bash scripts/bench-calls.sh <room>
```

## Resultados — app Windows (7 out 2026)

### Inicialização

| Medida | Resultado |
|---|---|
| Até a UI logada (sessão restaurada), 5 execuções | mediana **555 ms** (mín 462, máx 996 — a 1ª é a fria) |
| Até a tela de login (antes da otimização de GPU) | mediana 439 ms |
| Instalador NSIS | **1,91 MB** |
| Bundle JS inicial | 336 KB (LiveKit 528 KB carregado só ao entrar em call) |

### Memória e CPU

| Cenário | Working set (MB) | Privada (MB) | CPU média (% 1 núcleo) | CPU p95 |
|---|---|---|---|---|
| Aberto, logado, recém-iniciado | 338 | **145** | — | — |
| Aberto, DM aberta, após uma call (antes da correção) | 466 | 192 | 0,59 | 1,55 |
| Aberto, DM aberta, após uma call (com `AudioContext` liberado) | 416 | **173** | **0,52** | 6,19 |
| **0.2.0**: servidor aberto (canal #geral + lista de membros), com porta de depuração do WebView ligada | 418 | 176 | 1,03 | 6,18 |
| **0.2.0**: servidor aberto, sem porta de depuração (uso normal) | 358 | **154** | **0,23** | 1,55 |
| Call 2 pessoas (voz) | 460 | 192 | **8,1** | 18,6 |
| Call 5 pessoas (voz) | 473 | 198 | 11,2 | 18,6 |
| Call 10 pessoas (voz) | 488 | 206 | 15,4 | 21,7 |
| Call 2 pessoas (voz + vídeo 720p recebido) | 489 | 207 | 12,8 | 18,6 |
| Call 5 pessoas (voz + 4 vídeos) | 490 | 211 | 10,3 | 17,0 |

Em % da máquina (24 núcleos), a call de 10 pessoas usou **0,64%**.

Observações honestas:

- Durante as medições de call havia downloads/instalação do Android SDK em segundo plano. O
  número é por processo, mas contenção de CPU pode inflar levemente os valores.
- Os participantes do `lk load-test` publicam áudio sintético; voz real com DTX tende a gerar
  menos tráfego nos silêncios.
- Cada cenário foi medido uma vez (60 amostras). Variação entre execuções observada: a call de
  2 pessoas mediu 5,9% e 8,1% em duas séries diferentes.
- 0.2.0 (servidores + visual novo): numa amostra de 20 s por processo, o renderer ficou em 0,00%
  parado — as animações são só de transição (CSS `transform`/`opacity`), nada roda em loop. A
  primeira medição (1,03%) estava com `--remote-debugging-port`, que custa CPU e memória por si
  só; a segunda é a do app como o usuário roda.
- **Ainda não medido**: screen share 1080p30 (precisa de interação com o seletor de tela do
  Windows; medir manualmente com `nexus-bench measure` durante um compartilhamento).

### Otimizações validadas por medição

| Mudança | Antes | Depois |
|---|---|---|
| `--in-process-gpu` no WebView2 | 166 MB privados, 439 ms | 144 MB, 356 ms (tela de login) |
| LiveKit carregado sob demanda | bundle 864 KB | 336 KB |
| Fechar o `AudioContext` ao sair da call | 192 MB após call | 173 MB |
| Testado e **rejeitado**: `--renderer-process-limit=1` | 166 MB | 168 MB (sem ganho) |

Distribuição da memória no idle (tela de login, antes do `--in-process-gpu`): processo GPU 74 MB,
browser 37 MB, renderer 24 MB, rede 12 MB, storage 7 MB, Nexus.exe (Rust) **6 MB**.

## Comparação com o Discord

Medido com a mesma ferramenta, logo em seguida, com o Discord que já estava aberto nesta máquina:

| App | Working set (MB) | Privada (MB) | CPU média | p95 |
|---|---|---|---|---|
| Nexus (aberto, DM aberta) | 416–466 | **173–192** | 0,5–0,6% | 1,6–6,2% |
| Discord (aberto) | 1239 | **1022** | 14,5% | 17,1% |

**As condições não são equivalentes**: o Discord estava logado numa conta real (servidores,
canais, possivelmente em segundo plano com outras atividades), enquanto o Nexus tinha 5 usuários
de teste. A comparação justa é manual:

1. Feche ambos e abra só o app medido; espere 30 s.
2. Discord: abra uma DM e deixe na tela. Nexus: o mesmo.
3. `nexus-bench measure --process Discord.exe --duration 60 --label discord-idle`
4. `nexus-bench measure --process nexus-desktop.exe --duration 60 --label nexus-idle`
5. Para calls: mesma quantidade de pessoas, mesma câmera/tela, medir 60 s cada.
6. Discord minimiza para a bandeja como o Nexus; meça com as janelas no mesmo estado.

## Supressão de ruído

Ver [AUDIO.md](AUDIO.md#benchmark-medido): RNNoise custa **0,49% de um núcleo**, adiciona
**10 ms** de latência e **31 KiB** de memória; reduz 12–21 dB de ruído estacionário nas pausas.

## Servidor

Ainda não há benchmark de carga do servidor. Para a escala alvo (dezenas de usuários), os testes
de integração rodam 10 participantes por call e 2 calls simultâneas sem diferença perceptível.
O processo usa no máximo 4 threads de runtime.

## Próximas medições

- Screen share 1080p30 (CPU do encoder, com e sem H.264 em hardware).
- Repetir a série de calls com a máquina ociosa e 3 repetições por cenário.
- Comparação controlada com o Discord (procedimento acima).
- RAM/CPU do servidor sob carga sintética.
