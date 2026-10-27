# Controle remoto assistido (Windows)

O controle começa **desligado**. Compartilhar a tela não concede entrada. O dono
libera solicitações no menu da própria transmissão e aprova cada pessoa novamente.
Não há acesso não supervisionado, senha permanente nem aceite automático.

## Uso

1. Compartilhe **uma janela** pelo seletor nativo do Nexus no Windows. Compartilhar
   um monitor ou usar o seletor do navegador permite assistir, mas não controlar.
2. No menu da transmissão, escolha **Liberar solicitações de controle** e leia o aviso.
3. Quem assiste usa o botão direito na transmissão e escolhe **Solicitar controle da janela**.
   Em servidor, o cargo/canal precisa de `REQUEST_CONTROL`, além de acesso à chamada.
   Em DM/grupo privado não há essa exigência de cargo. O aceite do dono sempre é obrigatório.
4. O dono confere nome, usuário e ID e escolhe separadamente movimento, cliques,
   rolagem e texto. Todas as opções começam desmarcadas. Pode delimitar a área por
   porcentagens ou usar os atalhos de metade esquerda, metade direita e centro.
   O retângulo limita **entrada**, não recorta o vídeo que as pessoas assistem.
5. O controlador ativa **Entrar no modo de controle**. O dono coloca a janela
   autorizada em primeiro plano e aguarda três segundos após seu último movimento/tecla.
   O modo é desativado no controlador quando sua janela perde foco.
6. **Esc**, fechar/clicar na barra nativa de emergência ou **Encerrar controle e
   solicitações** revogam o acesso. Para mudar permissões/área, encerre e aprove novamente.

## Proteções implementadas

- Permissão de solicitação (`1 << 18`) disponível em cargos e sobrescritas de
  canal/categoria; desabilitada em `@everyone` por padrão. Administrador/dono do
  servidor pode solicitar, mas não pode dispensar o consentimento do dono do PC.
- REST autenticado para cada operação; identidade deriva da sessão, não do corpo
  do pacote. Verificação de acesso, participação e permissões por comando.
  Eventos de entrada seguem somente para a sessão do dispositivo que aprovou.
- Uma solicitação/controlador por transmissão. Solicitações duram 30 segundos;
  intervalo mínimo de 30 segundos entre pedidos por transmissão. Sessão ativa
  dura no máximo cinco minutos e não pode ser estendida por heartbeat.
- Estado temporário em memória, apagado ao reiniciar o servidor. Limite de
  transmissões e limitação de frequência de comandos. Nenhum texto digitado é persistido.
- Mudanças de estado (liberar, pedir, aceitar, recusar, encerrar, revogar) são avisadas pelo
  gateway (`REMOTE_CONTROL_UPDATE`) a quem está na chamada; ninguém consulta o servidor
  repetidamente. Só o dono com controle liberado mantém um heartbeat (500 ms), cuja resposta já
  traz o próprio estado; o status completo é consultado nesses avisos e a cada 5 s como reserva.
- A checagem completa de permissão (chamada, membro, bloqueio, cargo/canal, dono transmitindo)
  vale por 1,5 s para os comandos seguintes e é renovada pelo heartbeat. Mudanças de cargos,
  sobrescritas ou membros do servidor a invalidam na hora; sair da chamada, parar a
  transmissão e encerrar a chamada revogam a sessão inteira.
- Lease no servidor de quatro segundos; lease nativo de dois segundos, renovado
  somente após heartbeat autenticado. Falha de rede, reconexão, fim da chamada,
  troca/fim da captura ou saída do participante invalidam o controle.
- Hooks nativos do Windows dão prioridade à entrada local antes de sua entrega.
  Qualquer ação local renova a pausa por três segundos e invalida a época de
  entrada. Há também verificação de `GetLastInputInfo` para entrada não observada: se o
  Windows registrou entrada mais de 50 ms depois da última vista pelos hooks (por exemplo,
  um hook removido pelo Windows por demora), o controle pausa.
  Não há fila de reprodução: no máximo um movimento e uma ação atômica em trânsito;
  cliques podem ultrapassar movimentos antigos, que são descartados pela sequência.
- Épocas de entrada também mudam a cada heartbeat (aproximadamente 500 ms), para
  descartar pacotes antigos. São aceitas a época atual e a anterior (o servidor só conhece a
  nova uma ida e volta depois), nunca uma anterior ao último uso local ou à revogação. Isso
  limita a idade de um pacote a cerca de dois heartbeats sem perder cliques legítimos.
  Sequências crescentes impedem repetição/reordenação.
- Defesa nativa antes de cada lote de entrada e novamente nos hooks: janela
  selecionada em primeiro plano, área interna e autorizada, nenhuma outra janela
  sobre o ponto de entrada. A barra de título, as bordas, menus externos e outros
  diálogos não recebem controle. PID e criação do processo são conferidos a cada comando;
  a checagem completa do processo (lista de bloqueio, elevação, árvore do Nexus) roda no início
  e depois no máximo uma vez por segundo.
- Sem execução elevada/UIAccess. Nexus e sua árvore de processos são proibidos,
  assim como Gerenciador de Tarefas, UAC, ferramentas de sistema e terminais
  conhecidos. Área de trabalho protegida também é bloqueada. Falhas de verificação negam entrada.
- Não há API de arquivos, sincronização de clipboard, atalhos globais, teclas
  mantidas ou arrastar. Só o botão esquerdo, em pares de pressionar/soltar: menus, listas
  suspensas e janelas que o aplicativo abrir são janelas separadas e ficam bloqueadas para quem
  controla (um clique direito abriria um menu inutilizável na tela do dono); digitação usa
  Unicode imprimível, sem Enter/Tab/controles. Texto requer foco dentro da área
  autorizada; alguns aplicativos não aceitam esse modo restrito de digitação.
- Botão de emergência numa janela Win32 separada, sempre no topo, que funciona
  sem depender do renderizador React. Fechar o Nexus para a bandeja encerra
  a sessão nativa ativa; a minimização normal mantém a barra de emergência.

## Transporte e implantação

O cliente exige HTTPS para comandos de controle fora de localhost; o servidor
exige `NEXUS_PUBLIC_URL=https://...` (HTTP de loopback é permitido para desenvolvimento).
Use TLS no servidor ou um proxy HTTPS confiável e impeça acesso externo à porta
HTTP de origem. A URL pública configurada **não prova** que uma conexão chegou por
TLS; o proxy/isolamento da porta continua sendo responsabilidade da implantação.
Os comandos passam pelo servidor Nexus e não têm criptografia de ponta a ponta.
O servidor e sua administração fazem parte da confiança da instalação.

## Limites de segurança

Este recurso **não é uma sandbox de aplicativos e não oferece garantia contra
golpes**. Dentro da janela autorizada, cliques ou texto podem alterar/apagar dados,
usar o clipboard por menus do aplicativo, enviar conteúdo, baixar/executar arquivos
ou acionar funções perigosas. A lista de executáveis bloqueados é defesa adicional:
não identifica todas as ferramentas, versões renomeadas ou terminais embutidos.
Recurso a recurso, o aplicativo autorizado continua sendo uma superfície de risco.

Os bloqueios do Windows dependem do estado do desktop e dos hooks. `SendInput`
insere entrada no fluxo global do Windows; verificações em dois pontos reduzem
corridas, mas não constituem isolamento formal contra aplicativos locais maliciosos,
hooks de terceiros ou um sistema operacional comprometido. A área por porcentagens
acompanha redimensionamentos da janela e não representa uma ACL de documentos.
Não autorize navegadores/editores com contas e arquivos sensíveis abertos; nunca
prometa que o controlador ficará incapaz de causar danos dentro do app permitido.

Referências oficiais: [SendInput e UIPI](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput),
[hooks de teclado](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc),
[última entrada da sessão](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo).

## Validação

Testes automatizados cobrem consentimento/recusa, cargos/sobrescritas, revogação,
isolamento por sessão/dispositivo, repetição, expiração, fim de transmissão e
saída da chamada, invalidação durante troca de captura, renovação de lease,
prioridade de três segundos e limites de área/payload. O diálogo foi inspecionado
no navegador, incluindo autorização inicialmente desabilitada e área inválida.

**Ainda exige teste manual com dois PCs Windows antes de liberar em produção:**

- WGC e `SendInput` reais, DPI 100/150/200%, múltiplos monitores e coordenadas negativas;
- owner move/click/scroll/keyboard durante entrada remota contínua: parar imediatamente
  e só voltar três segundos após a última entrada, sem reproduzir comandos antigos;
- Esc, barra nativa e desconexão com Nexus minimizado/oculto, renderizador travado e rede interrompida;
- UAC, PC bloqueado, Gerenciador de Tarefas, Nexus/WebView2, aplicativos elevados,
  janelas sobrepostas, seletores de arquivo, menus e troca/redimensionamento/fechamento de janela;
- compatibilidade de texto e verificação de que nenhum botão/tecla fica pressionado;
- que `GetLastInputInfo` e o horário dos hooks andam juntos (mouse, teclado, touch e caneta):
  se não andarem, o controle fica pausado o tempo todo (falha bloqueando, não liberando);
- tentativa de abuso dentro do app permitido e revisão de segurança independente.

Android continua com visualização de tela; a interface de controle implementada
nesta alteração está no desktop. Nenhum teste automatizado substitui as etapas acima.
