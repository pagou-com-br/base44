# Integração da API Pagou com Base44: Pagamentos via PIX e Boleto (Guia Passo a Passo)

## 1. O que são PIX e Boleto e por que são relevantes?

**PIX:** Pix é um meio de pagamento instantâneo criado pelo Banco Central do Brasil em 2020. Ele permite transferências e pagamentos eletrônicos em tempo real, 24 horas por dia, 7 dias por semana (inclusive feriados), com o dinheiro caindo na conta de destino na hora. A grande vantagem do Pix é a rapidez e disponibilidade contínua, diferentemente de métodos tradicionais como TED (que têm restrições de horário) ou boletos (que têm compensação mais lenta). Desde seu lançamento, o Pix teve adoção massiva: em 2023 consolidou-se como o meio de transação mais utilizado no país, com quase **42 bilhões de transações Pix no ano** – mais do que a soma de transações via cartão de crédito, débito, boletos e outros meios. Ou seja, aceitar Pix significa oferecer aos clientes um método de pagamento moderno, instantâneo e amplamente usado.

**Boleto Bancário:** O boleto bancário (ou simplesmente *boleto*) é um documento de cobrança muito tradicional e difundido no Brasil, utilizado como instrumento de pagamento de produtos ou serviços. Em termos simples, é um “carnê” ou fatura que o vendedor emite, e o cliente paga usando o código de barras ou linha digitável em bancos, lotéricas ou via internet banking. O boleto é considerado uma das formas de pagamento **mais acessíveis**, pois **qualquer pessoa** consegue utilizá-lo – mesmo quem não tem cartão de crédito ou conta digital avançada pode pagar um boleto em dinheiro ou via banco. Ele continua extremamente relevante: somente em 2024 foram emitidos cerca de **4,2 bilhões de boletos** no país, movimentando em torno de **R\$ 6,2 trilhões** em pagamentos. Portanto, oferecer boleto como opção de pagamento alcança clientes que preferem ou dependem desse meio, aumentando o alcance do seu negócio.

**Relevância para seu app:** Integrar Pix e Boleto na sua plataforma significa cobrir os principais meios de pagamento usados pelos brasileiros. O Pix atende à demanda por rapidez e conveniência (pagamento instantâneo via celular), enquanto o Boleto atende a quem precisa de um documento para pagar posteriormente ou utilizar canais tradicionais (como pagar na agência ou caixa eletrônico). Em suma, você melhora a experiência do cliente e potencialmente suas vendas ao suportar ambos os meios.

## 2. Visão geral da arquitetura da integração

A integração entre o Base44 (plataforma VibeCoding) e a API Pagou envolve dois fluxos principais: (a) **a solicitação de pagamento** da aplicação Base44 para a Pagou (quando o cliente inicia uma compra e o sistema gera um Pix ou boleto), e (b) **a notificação de pagamento** da Pagou de volta para sua aplicação (confirmando que o cliente pagou). Em outras palavras, sua aplicação chamará a API da Pagou para criar cobranças, e então a Pagou enviará **webhooks** (chamadas HTTP) para a sua aplicação informando eventos importantes, como a confirmação do pagamento de um Pix ou Boleto.

&#x20;*Fluxo da integração entre Base44 e Pagou.* Os números no diagrama correspondem aos passos: **(1)** A aplicação Base44 (seu backend) solicita a criação de um pagamento via API da Pagou (seja um Pix dinâmico ou um boleto bancário); **(2)** A Pagou retorna os dados da cobrança criada – por exemplo, os dados do QR Code Pix ou o ID (identificador) de um boleto; **(3)** Sua aplicação então exibe ao cliente as instruções de pagamento (como o QR Code para ser escaneado ou o boleto para ser pago); **(4)** O cliente efetua o pagamento – no caso do Pix, via app bancário escaneando o QR Code; no caso do boleto, pagando o documento em um banco, lotérica ou internet banking; **(5)** O sistema bancário confirma a liquidação do pagamento junto à Pagou (no Pix isso é instantâneo, no boleto pode demorar alguns dias até o banco compensar); **(6)** A Pagou envia uma notificação (*webhook*, um POST HTTP) para a URL de webhook configurada na sua aplicação Base44, informando que o pagamento foi realizado (evento de pagamento confirmado); **(7)** O código de webhook na sua aplicação Base44 recebe essa notificação e então atualiza o status da transação no seu sistema (por exemplo, marcando o pedido como pago e liberando o produto/serviço para o cliente).

**Componentes principais:** Nesta arquitetura, os componentes envolvidos são:

* **Sua aplicação (Base44):** é o app que você construiu na plataforma Base44. Nele você terá funções de backend (código) que fazem requisições à Pagou e recebem webhooks. Também é responsabilidade da sua aplicação armazenar o status do pedido e apresentar ao usuário as informações (exibir o QR Code ou boleto, e mais tarde informar que foi pago).
* **API Pagou:** é o serviço externo que processa a geração do Pix ou boleto e intermedia o pagamento. Sua aplicação se comunica com a API Pagou via HTTP (usando as credenciais da API).
* **Webhook Pagou:** é basicamente a Pagou chamando sua aplicação de volta. Quando algo acontece do lado da Pagou (por exemplo, um boleto foi pago ou um Pix compensado), a Pagou envia uma requisição HTTP POST para a URL de notificação que você especificou durante a criação da cobrança. Essa chamada contém dados sobre o evento (por exemplo, “boleto X pago às 15:00 de hoje”). Sua aplicação precisa ter um **endpoint HTTP público** para receber essas chamadas. “Público” significa acessível pela internet com HTTPS – falaremos disso adiante.
* **Cliente e Sistema Bancário:** embora de forma transparente, é bom entender que o cliente interage com o app bancário ou a rede bancária para efetivar o pagamento. No caso do Pix, o cliente usa o aplicativo do banco para ler o QR Code e transferir o valor. No caso do boleto, o cliente usa algum canal (agência, internet banking etc.) para pagar o boleto. O banco então comunica a Pagou quando o dinheiro for recebido. Essa parte ocorre nos bastidores, mas é útil saber para entender possíveis delays (ex.: um boleto pode levar 1-2 dias úteis para compensar).

**Eventos de webhook importantes:** A Pagou define eventos diferentes para Pix e boletos:

* Para **Pix**, os eventos de notificação principais são `qrcode.completed` (quando um QR Code Pix dinâmico foi pago, ou seja, pagamento confirmado) e `qrcode.refunded` (quando um Pix foi estornado, se aplicável). No contexto desta integração focaremos principalmente no `qrcode.completed` (pagamento realizado).
* Para **Boletos**, os eventos de webhook incluem `charge.created` e `charge.paid`. `charge.created` ocorre assim que o boleto é registrado/emitido com sucesso (a Pagou envia detalhes do boleto – código de barras, linha digitável – neste evento), e `charge.paid` ocorre quando o boleto foi **pago** e o pagamento confirmado pelo banco.

Resumindo a arquitetura: Sua aplicação cria um Pix ou boleto via API Pagou; em seguida, aguarda-se o cliente pagar; assim que pago, a Pagou notifica sua aplicação via webhook; seu código de webhook atualiza o status e você pode então confirmar ao cliente que o pagamento foi recebido. Tudo isso requer configurar corretamente as **credenciais** e a **URL de webhook** (veremos nos próximos passos), além de implementar duas funcionalidades principais no Base44: uma função para **gerar o Pix dinâmico** e/ou **boleto** quando necessário, e outra para **receber o webhook** de confirmação.

## 3. Configurando as credenciais da Pagou no Base44

Para que sua aplicação Base44 consiga conversar com a API Pagou, é necessário fornecer as credenciais de acesso da API. A Pagou utiliza autenticação via chave de API (*API Key*), fornecida no painel da Pagou para sua conta. Cada requisição que sua aplicação fizer precisa incluir essa chave.

**Obtenha a API Key:** No painel do Pagou (site da Pagou), procure pela seção de **Credenciais** ou **API**. Lá deve constar uma chave única (um token) associado à sua conta. Copie essa chave – ela será usada para autenticar as chamadas. Normalmente, a Pagou utiliza o cabeçalho HTTP `X-API-KEY` para receber essa credencial em cada requisição. Em outras palavras, em todas as chamadas à API (tanto para criar Pix quanto boletos, etc.), você enviará `X-API-KEY: SEU_TOKEN_AQUI` no header da requisição para se identificar.

**Ambiente Sandbox vs Produção:** A Pagou oferece dois ambientes de API – o **sandbox** (teste) e **produção**. No sandbox, você pode fazer testes sem transações financeiras reais; em produção, os pagamentos valem de verdade. As URLs de chamada mudam conforme o ambiente, por exemplo:

* Produção: `https://api.pagou.com.br/v1/pix` (para Pix) ou `.../v1/charges` (para boletos).
* Sandbox: `https://sandbox.api.pagou.com.br/v1/pix` ou `.../v1/charges` para boletos.

Você pode inicialmente usar o sandbox para testar sua integração sem medo de movimentar dinheiro real. A chave de API pode ser a mesma para sandbox e produção, ou haver chaves distintas – verifique no painel Pagou. De qualquer forma, a autenticação continua sendo via `X-API-KEY` no header. **Dica:** Mantenha sua chave **segura**. Evite expor a API Key diretamente no código-fonte. O ideal é armazená-la em uma variável de ambiente ou em uma configuração protegida do Base44, seguindo boas práticas de segurança. Assim, se você compartilhar o código, não arrisca vazar a credencial.

**Configurando no Base44:** No ambiente Base44 (VibeCoding), insira a API Key de forma que suas funções de backend possam usá-la:

* Se o Base44 tiver um local específico para variáveis de ambiente ou secrets (por exemplo, um arquivo de configuração, ou um painel de *Settings* onde você define chaves API), adicione a chave lá (com nome como `PAGOU_API_KEY`).
* Caso não haja um gerenciador de env separado, você pode temporariamente colocar a chave no código para testes, mas lembre de removê-la depois. Por exemplo, no código de requisição, você vai colocar `X-API-KEY: "sua_chave_aqui"` nos headers da requisição (explicado no próximo passo).
* Em projetos Node.js, uma prática comum é usar bibliotecas como `dotenv` ou variáveis de ambiente no host. No contexto do Base44, consulte a documentação de VibeCoding/Base44 para ver como lidar com segredos. Se não encontrar, mantenha a chave em um local central do código e evite duplicá-la em vários arquivos (facilita trocar em caso de necessidade de rodar em produção).

Certifique-se de usar a chave correta para o ambiente correto. Exemplo: em sandbox use a chave de sandbox (ou a mesma chave se for universal) e a URL sandbox; em produção, antes de ir ao ar, troque para a URL de produção e garanta que a chave está ativa para produção. Se a autenticação estiver correta, suas requisições à API Pagou retornarão sucesso (códigos 200/201). Se houver erro de autenticação (ex.: usar chave errada ou esquecer o header), a Pagou retornará erro **401 Unauthorized** indicando chave inválida ou ausente. Nesse caso, volte e confira a chave nas configurações do Pagou e se o header `X-API-KEY` está sendo enviado exatamente conforme esperado.

## 4. Ajustando a URL pública para o webhook (notification\_url)

Um ponto crucial na integração é configurar adequadamente a URL de notificação (webhook) para que a Pagou consiga avisar sua aplicação quando um pagamento for efetuado. Essa URL deve ser **pública e com HTTPS válido**, pois os servidores da Pagou precisarão acessá-la pela internet.

**O problema do URL padrão do Base44:** Em ambiente de desenvolvimento ou usando ferramentas no-code/low-code, muitas vezes a URL local ou padrão não é acessível externamente. Por exemplo, se sua aplicação estiver rodando localmente (localhost) ou em um sandbox interno do Base44, a Pagou não conseguirá enviar notificações, pois “[http://localhost”](http://localhost”) não é acessível de fora. Assim, você precisa fornecer um endereço que esteja publicado na web. No Base44, quando você implanta sua aplicação ou utiliza o modo de pré-visualização pública, é provável que tenha um domínio ou URL fornecido (às vezes algo como `https://<seu-projeto>.base44.io` ou uma URL customizada própria do seu app). **Use esse endereço público** para montar o webhook.

**Configurando o webhook (notification\_url):** A Pagou permite que você defina a URL de webhook a cada cobrança criada (no campo `notification_url` do payload). Vamos supor que você crie uma função de webhook no Base44 chamada `pagouWebhook` e que ao publicar sua aplicação ela fique acessível em `https://meuapp.base44.io/pagouWebhook` (endereço de exemplo). Nesse caso, **esse** é o URL que você deve fornecer no campo `notification_url` quando chamar a API Pagou para criar um Pix ou boleto. Assim, a Pagou saberá para onde enviar o POST de notificação.

No código de exemplo mais à frente, você verá `notification_url: "https://your-webhook.com/notifications"` – substitua pelo endereço real do seu webhook. Se o Base44 por padrão colocou um placeholder ou um caminho interno, altere para a URL completa. Algumas dicas:

* Inclua o protocolo **https\://** no início (HTTP simples não será aceito – a Pagou exige HTTPS com certificado válido).
* Certifique-se de que o domínio está correto e ativo. Teste acessando a URL do webhook no navegador (mesmo que retorne erro 405/501 porque não foi POST, pelo menos você valida que o domínio resolve).
* Evite URLs com IP ou localhost. Use um nome de domínio. Caso você esteja testando localmente e não tenha publicado no Base44, uma alternativa é usar ferramentas como **ngrok** para expor temporariamente seu endpoint local na web através de um túnel HTTPS. Mas, idealmente, teste em uma instância publicada do Base44.
* Verifique se no Base44 é necessário configurar alguma rota para a função ser acessível via web. Por exemplo, algumas plataformas exigem marcar a função como “exposta como endpoint”. No screenshot que você forneceu (menu de Functions com `createDynamicPix`, `pagouWebhook`, etc.), provavelmente cada função HTTP já fica exposta automaticamente em um path correspondente. Consulte a documentação do Base44 se for preciso ativar algo.

Resumidamente: **altere o valor padrão do `notification_url`** no seu código para uma URL pública e válida. Essa é uma etapa simples, mas se esquecida, resulta em nenhum webhook sendo recebido. A Pagou vai tentar enviar e falhará se a URL estiver inacessível ou incorreta. Além disso, sempre que criar uma cobrança, garanta que está passando a URL desejada naquela requisição (caso a API Pagou não tenha uma default persistente – pelo contexto, cada chamada POST inclui seu `notification_url`). Isso te dá flexibilidade de, por exemplo, ter URLs distintas para testar e para produção.

**Exemplo:** Suponha que seu app publicado tenha o domínio `https://loja123.base44.io`. Se sua função webhook está mapeada na raiz `/pagouWebhook`, use `https://loja123.base44.io/pagouWebhook` como `notification_url`. Ao criar um Pix ou boleto (POST na API Pagou), esse campo informará a Pagou onde te notificar. Veremos no passo 6 como implementar a lógica dentro desse webhook.

## 5. Criando uma função para gerar PIX dinâmico (passo a passo)

Agora entraremos na parte prática: configurar no Base44 a função (backend) que irá solicitar à Pagou a criação de um **Pix dinâmico**. Pix dinâmico significa um QR Code único gerado pela API para um pagamento específico (geralmente com valor definido e prazo de expiração). Diferente de um Pix estático (que pode ser reutilizado), o dinâmico traz mais segurança e informações específicas da transação.

Chamemos essa função de `createDynamicPix` (como no screenshot enviado). A função será responsável por, dado um pedido ou contexto de pagamento, montar a requisição para a API Pagou e obter de lá os detalhes do Pix (especialmente o código do Pix e a imagem do QR Code).

A seguir, um exemplo de código JavaScript (Node.js) para criar um Pix dinâmico via Pagou, junto com explicações de cada parte. Esse código pode ser adaptado dentro do Base44 (por exemplo, como uma função de ação quando o usuário clica em "Pagar com Pix").

```javascript
const fetch = require('node-fetch');  // Biblioteca para fazer requisições HTTP (se já houver fetch nativo no ambiente, pode usar diretamente)
const { validate } = require('jsonschema');  // (Opcional) Biblioteca para validar JSON conforme um schema

// 1. Esquema de validação do payload (opcional, para garantir que os dados enviados estão no formato correto)
const pixSchema = {
    type: 'object',
    required: ['amount', 'description', 'expiration', 'payer'],
    properties: {
        amount: { type: 'number', minimum: 0.01 },      // valor mínimo de 0.01 (R$0,01)
        description: { type: 'string', maxLength: 255 }, // descrição até 255 caracteres
        expiration: { type: 'integer', minimum: 60, maximum: 604800 }, // expiração entre 60 segundos (1 min) e 604800 (7 dias)
        metadata: {
            type: 'array',
            items: {
                type: 'object',
                required: ['key', 'value'],
                properties: {
                    key: { type: 'string' },
                    value: { type: 'string' }
                }
            }
        },
        payer: {
            type: 'object',
            required: ['name', 'document'],
            properties: {
                name: { type: 'string', maxLength: 100 }, 
                document: { type: 'string', pattern: '^\\d{11}|\\d{14}$' }
            }
        },
        notification_url: { type: 'string', format: 'uri' },
        customer_code: { type: 'string', maxLength: 50 }
    }
};

// 2. Monta o payload (dados do pagamento Pix a serem enviados para Pagou)
const payload = {
    amount: 50.00,                       // Valor em Reais (ex: 50.00 representa R$50,00)
    description: 'Pedido #12345',        // Descrição da cobrança para identificar
    expiration: 3600,                    // Tempo em segundos para expirar (ex: 3600 = 1 hora)
    metadata: [
        { key: 'order_id', value: '12345' },   // Metadados opcionais, como ID do pedido interno
        { key: 'cliente', value: 'João Silva' }
    ],
    payer: {
        name: 'João Silva',              // Nome do pagador (cliente)
        document: '12345678901'          // CPF ou CNPJ do pagador, apenas dígitos (11 ou 14 dígitos):contentReference[oaicite:24]{index=24}
    },
    notification_url: 'https://loja123.base44.io/pagouWebhook',  // URL pública configurada para receber o webhook:contentReference[oaicite:25]{index=25}
    customer_code: 'CUST-001'            // (Opcional) código interno do cliente, se aplicável
};

// (Validação opcional do payload antes de enviar, para evitar erros de requisição)
const validation = validate(payload, pixSchema);
if (!validation.valid) {
    console.error('Erro de validação dos dados do Pix:', validation.errors);
    throw new Error('Payload inválido para criação do Pix');
}

// 3. Envia a requisição HTTP POST para criar o Pix via API Pagou
fetch('https://sandbox.api.pagou.com.br/v1/pix', {   // use a URL de produção quando for o caso:contentReference[oaicite:26]{index=26}
    method: 'POST',
    headers: {
        'X-API-KEY': 'SUA_CHAVE_API_AQUI',           // sua API key Pagou para autenticação:contentReference[oaicite:27]{index=27}
        'Content-Type': 'application/json',
        'User-Agent': 'MinhaApp/1.0'                 // identificador da aplicação (opcional)
        // 'Idempotency-Key': '...opcional...'      // você pode enviar um Idempotency-Key para evitar duplicações (bom em casos de re-tentativa)
    },
    body: JSON.stringify(payload)
})
.then(response => {
    if (!response.ok) {
        // Se a resposta não for 201/200, lança um erro com detalhes
        return response.json().then(errBody => {
            throw new Error(`Erro ${response.status}: ${errBody.error || response.statusText}`);
        });
    }
    return response.json();  // parseia o JSON de resposta (dados do Pix criado)
})
.then(data => {
    console.log('Pix criado com sucesso!');
    console.log('ID do QRCode Pix:', data.id);
    console.log('Código Pix (copiar e colar):', data.payload.data);
    console.log('Imagem (Base64) do QRCode:', data.payload.image);
    // Aqui você pode armazenar esses dados ou retorná-los para o front-end.
})
.catch(error => {
    console.error('Erro na requisição Pix:', error);
});
```

Vamos dissecar o código acima em partes e explicar em termos simples o que cada etapa faz:

* **Importações:** As primeiras linhas importam bibliotecas úteis. `node-fetch` permite fazer chamadas HTTP de forma fácil (similar ao fetch do navegador). `jsonschema` não é obrigatória, mas o exemplo a utiliza para validar o payload. Em um contexto didático, podemos dizer que a validação checa se você não esqueceu nenhum campo obrigatório e se formatos estão corretos antes de enviar para a Pagou – isso evita receber erro 400 do servidor caso tenha algo errado. Por exemplo, ele verifica se `payer.document` bate com o padrão de CPF/CNPJ (11 ou 14 dígitos), se o valor não é negativo, etc.

* **Definição do *payload* do Pix:** O objeto `payload` contém todos os dados do pagamento Pix que serão enviados para a API Pagou. Vamos aos campos principais:

  * `amount`: valor em reais da cobrança. No exemplo, 50.00 representa R\$ 50,00. (A Pagou exige no mínimo R\$0,01 para Pix. No caso de boleto, o mínimo é R\$5,00, mas Pix pode ser centavos).
  * `description`: uma descrição do pagamento. Pode ser, por exemplo, o número do pedido ou o nome do produto/serviço. Isso ajuda a identificar do que se trata o Pix quando você ver os registros.
  * `expiration`: tempo em segundos para expiração do QR Code. No exemplo usamos 3600 (1 hora). Você pode ajustar conforme a necessidade – por exemplo, se quiser que o QR Code vença em 15 minutos, usaria 900 segundos. O mínimo suportado é 60 s e o máximo 7 dias (604800 s).
  * `metadata`: uma lista de pares chave/valor com informações extras. Não é obrigatório, mas é útil para vincular o pagamento a registros internos. No exemplo, colocamos `order_id` e `cliente`. A Pagou apenas guarda e devolve esses metadados para você (não influenciam no pagamento em si).
  * `payer`: os dados do pagador. Aqui incluem `name` (nome do cliente pagador) e `document` (CPF ou CNPJ). **Importante:** o CPF/CNPJ deve ser passado apenas com números, sem pontos ou traços, e deve ter 11 dígitos (CPF) ou 14 dígitos (CNPJ). Se enviar em formato inválido, a API retornará erro de validação (por ex, “CPF inválido”).
  * `notification_url`: é a URL do webhook discutida no passo anterior. Note que no exemplo colocamos `https://loja123.base44.io/pagouWebhook` – você deve inserir aqui a **URL pública real** que configurou para receber as notificações. Cada Pix criado com essa requisição ficará associado a essa URL de callback.
  * `customer_code`: campo opcional para um código de cliente interno. Não é crucial; use se fizer sentido para você (por exemplo, um identificador do cliente na sua base, caso queira reconciliação posterior).

  Montamos o payload em formato de objeto JavaScript e, antes de enviar, convertê-lo-emos em JSON string (com `JSON.stringify`).

* **Validação do payload (opcional):** O trecho com `validate(payload, pixSchema)` tenta validar o objeto payload contra o esquema definido. Isso é opcional, mas é uma boa prática para pegar erros antes de fazer a chamada. Por exemplo, se você esqueceu de colocar o campo `payer.document`, ou colocou um valor negativo em `amount`, essa validação acusará erro. No nosso guia, se você está preenchendo tudo direitinho, pode não se preocupar tanto com isso. Mas quisemos mostrar porque no exemplo de código da documentação isso aparece – é uma verificação extra para evitar erros 400 (Bad Request) na API. Em caso de falha, estamos dando um `console.error` e lançando exceção para interromper o fluxo.

* **Chamada `fetch` para a API Pagou:** Aqui fazemos o **POST HTTP** para o endpoint da Pagou que cria um Pix dinâmico. Repare nos detalhes:

  * A URL usada é `https://sandbox.api.pagou.com.br/v1/pix` porque estamos assumindo um teste em sandbox. Em produção, a URL base muda para `api.pagou.com.br`. Você pode tornar essa URL configurável (ex: usar uma variável de ambiente `PAGOU_URL_BASE`) para alternar facilmente entre sandbox e produção.
  * **Headers:** Incluímos os cabeçalhos necessários:

    * `X-API-KEY`: sua chave de API. **Substitua `'SUA_CHAVE_API_AQUI'` pela sua chave real** (ou melhor, use a variável de ambiente configurada no passo 3). Sem a chave correta, a Pagou retornará 401 Unauthorized.
    * `Content-Type: application/json`: indicando que estamos enviando JSON no body.
    * `User-Agent`: opcional, mas a doc recomenda identificar sua aplicação. Pode colocar um nome do seu sistema e versão (ex.: "MinhaLoja/1.0").
    * `Idempotency-Key`: este não é obrigatório, mas é **altamente recomendável** em aplicações reais. Trata-se de um UUID único por requisição que você gera (por ex., usando uma library ou função de GUID). Serve para, caso haja alguma falha de comunicação e você mande a mesma requisição novamente, a API Pagou reconheça e não crie cobranças duplicadas. No nosso exemplo, omitimos ou colocamos um fixo apenas para ilustrar. Em produção, gere um novo idempotency key para cada nova cobrança (mas se precisar repetir exata cobrança, reutilize o mesmo para não duplicar).
  * **Body:** passamos `body: JSON.stringify(payload)` – convertendo o objeto payload em uma string JSON para enviar na requisição.

* **Tratamento da resposta:** A chamada `fetch` retorna uma *Promise* que resolvemos encadeando `.then()`. Primeiro, verificamos se `response.ok` é true, ou seja, se o status HTTP é 200-299. A criação bem-sucedida de um Pix deve retornar **201 Created**. Se for outro status, entramos no bloco de erro: chamamos `response.json()` para tentar extrair a mensagem de erro e em seguida forçamos um throw de erro com essa mensagem. Assim, cai no nosso `.catch` depois com detalhes. Se `response.ok` estiver OK, fazemos `response.json()` para obter os dados retornados pela API Pagou.

* **Dados retornados (`data`):** No segundo `.then(data => { ... })`, temos acesso ao objeto retornado pela Pagou para o Pix gerado. Segundo a documentação, os principais campos que vêm são:

  * `data.id`: o identificador único do QR Code Pix gerado (um UUID). Você pode guardar este ID caso queira consultar o status via API mais tarde, ou para referência interna.
  * `data.payload.data`: o código representando o Pix (texto do QR Code em formato copia-e-cola – conhecido como código Pix copia e cola).
  * `data.payload.image`: uma string base64 que é a imagem do QR Code, já no formato que pode ser exibido em tela. Geralmente começa com `data:image/png;base64,....`. Você pode pegar essa string e colocar direto em uma tag `<img src="...">` no front-end para mostrar o QR Code ao usuário sem precisar gerar imagem por conta própria.
    Além disso, podem vir outros campos informativos (por exemplo, `expiration_date` ou `status` inicial do Pix, etc). Mas os principais para apresentar ao cliente são o QR code (imagem) e possivelmente o código em texto (para quem não consegue escanear, poder copiar e pagar manualmente no app bancário).

  No código, fazemos `console.log` desses campos para fins de depuração. No seu caso, você talvez não tenha um console visível ao usuário final, mas pode utilizar esses dados para:

  * Enviar a imagem do QR Code para a interface (por ex, via resposta HTTP se esta função for chamada de uma requisição do front-end, ou salvando em algum estado gerenciado pelo Base44 para o front mostrar).
  * Mostrar o código Pix em formato de texto também (é útil exibir um botão "Copiar código Pix" para o usuário, como alternativa ao QR).
  * Guardar o ID e metadata da transação em um banco de dados ou armazenamento interno, marcando o status como "Pendente". Assim, quando o webhook de confirmação chegar, você sabe qual transação fechar.

* **Tratamento de erros (.catch):** Se qualquer erro ocorrer na promessa – seja na comunicação (ex.: sem internet), ou um HTTP erro tratado acima – cai no `.catch` imprimindo o erro. Aqui você pode tomar ações adequadas: por exemplo, se for um erro 400, pode avisar o usuário "Falha ao gerar Pix, verifique os dados". Se for 401, conferir credenciais. Se for 500, tentar novamente ou alertar suporte. Em dev, esses logs ajudam a depurar.

Com essa função implementada e funcionando, ao chamá-la você deverá conseguir gerar um Pix dinâmico na Pagou. No sandbox, a resposta será imediata com o QR Code. **Exemplo de resultado esperado:** A API retorna `201 Created` e um JSON contendo o `id` do Pix, e dentro de `payload` os campos `data` (código Pix) e `image` (imagem do QR). Quando você usar esses valores para exibir ao cliente, ele poderá realizar o pagamento usando o app do banco. A partir daí, sua responsabilidade é aguardar o webhook de confirmação (próximo passo) para saber que foi pago.

*(Observação: a API Pagou também permite criar Pix com vencimento (due\_date) e outros features, mas para começar o Pix imediato/dinâmico simples já resolve o pagamento instantâneo. Você pode explorar depois o endpoint `/v1/pix/due` para QR Codes com data de vencimento, se precisar de cenários em que o Pix expira só em dias específicos.)*

## 6. Escutando notificações (webhook) e atualizando status da transação

Depois que um Pix ou um boleto foi criado e fornecido ao cliente, sua aplicação precisa ficar atenta para saber quando esse pagamento for concluído (pago). É aí que entram os **webhooks** da Pagou. Vamos configurar a função `pagouWebhook` (conforme ilustrado no screenshot) para receber essas notificações e tomar as ações necessárias.

**O que é o webhook?** Relembrando: é um endpoint HTTP na sua aplicação que a Pagou chamará automaticamente quando certos eventos ocorrerem, como o pagamento confirmado. No nosso caso:

* Se for Pix, quando o cliente pagar o QR Code, a Pagou envia um evento `qrcode.completed` para seu webhook contendo os detalhes da transação paga.
* Se for Boleto, haverá dois momentos: ao gerar o boleto, pode vir um `charge.created` com detalhes do boleto; e quando pago, um `charge.paid` indicando confirmação do pagamento.

Aqui nos concentraremos principalmente em tratar pagamento confirmado (Pix pago ou boleto pago), já que é o essencial para atualizar o status do pedido no sistema. Mas não esqueceremos do `charge.created` do boleto, porque é nele que chegam informações como código de barras e linha digitável que você pode querer armazenar/exibir.

**Implementação da função webhook no Base44:** Dependendo do stack que o Base44 usa, você implementará isso possivelmente como uma função handler HTTP. Em Node/Express seria algo como:

```javascript
// Exemplo didático de handler Express.js
app.post('/pagouWebhook', (req, res) => {
    const event = req.body;
    console.log('Webhook recebido:', event);

    // Verifica tipo de evento
    if (event.event_name === 'qrcode.completed' || event.name === 'charge.paid') {
        // Aqui extrai info relevante e atualiza status da transação local
        // Por exemplo, identificar o pedido pelo event.data.id ou metadata e marcar como pago.
        console.log('Pagamento confirmado para ID:', event.data.id);
        // ... (lógica de atualização do pedido no banco de dados da sua aplicação)
    } else if (event.name === 'charge.created') {
        // Boleto criado: você pode extrair a linha digitável e armazenar
        console.log('Boleto registrado. Linha:', event.data.payload.line);
        // ... (guardar linha digitável e código de barras se precisar)
    }

    // Retorna 200 OK para confirmar recebimento
    res.sendStatus(200);
});
```

No Base44, talvez você não escreva um app Express completo, mas o conceito é parecido: a função `pagouWebhook` deve ler o corpo da requisição (que será um JSON enviado pela Pagou) e tomar decisões baseadas nele. Vamos aos pontos importantes:

* **Ler o conteúdo do webhook:** A Pagou envia um JSON no corpo da requisição. No caso de Pix, a estrutura é como:

  ```json
  {
    "event_name": "qrcode.completed",
    "data": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "external_id": "ext-qr-12345",
      "transaction_id": "txn-789012",
      "e2e_id": "E123456789202401151030abcdef123456",
      "amount": 50.00,
      "payer": { ... },
      "description": "Payment for product or service"
    }
  }
  ```

  Já para boletos, o evento de pagamento tem formato:

  ```json
  {
    "name": "charge.paid",
    "data": {
      "id": "09cd8523-85e8-400f-9c06-3c1950714d6b",
      "transactionid": "a21b0b0f-e142-49e8-a81f-1095527f2ef2",
      "clientcode": "09cd8523-85e8-400f-9c06-3c1950714d6b",
      "amount": {
        "paid": 94.99,
        "original": 94.99
      },
      "paidin": "2025-07-23 08:00:06"
    }
  }
  ```

  E o de boleto criado (`charge.created`) contém os detalhes do boleto (veja \[39] acima). Note que para Pix o campo de evento é `event_name`, para boleto é `name` – mas os valores como "qrcode.completed" vs "charge.paid" identificam claramente o tipo. Sua função pode lidar com ambos.

* **Identificar o evento e agir:** No pseudocódigo acima, verificamos:

  * Se for um Pix pago (`event_name === 'qrcode.completed'`): significa que um daqueles Pix que você criou foi pago. Dentro de `data` você terá o `id` do Pix (que coincide com o ID retornado quando criou), o `amount` pago, possivelmente o `transaction_id` e `e2e_id` (identificadores de transação Pix), e os dados do pagador. O essencial: pegue o `data.id` ou algum identificador que associe a um pedido interno. Quando você criou o Pix, talvez tenha salvo o `id` dele junto do pedido no seu sistema, ou colocou o número do pedido em `metadata`. Aqui você vai usar essa referência para marcar aquele pedido como **pago**. Exemplo: se no metadata order\_id = 12345, você pode buscar o pedido 12345 no seu banco e marcar pago, ou se guardou a relação id do Pix -> pedido, use-a.
  * Se for um boleto pago (`name === 'charge.paid'`): similarmente, significa que um boleto previamente emitido foi pago. A estrutura traz `data.id` (UUID do boleto) e alguns detalhes como valor pago e data/hora. Use o ID ou clientcode para relacionar com o pedido. No momento de criar o boleto (veremos no próximo passo), você poderia ter salvo o ID do boleto retornado e associado ao pedido. Agora basta dar baixa naquele pedido.
  * Se for um boleto criado (`name === 'charge.created'`): esse chega logo após a criação do boleto, contendo a linha digitável e código de barras. Você pode usar isso para, por exemplo, armazenar no pedido e exibir para o cliente. Caso você tenha no front-end alguma forma de apresentar o boleto logo após gerar, pode ser interessante esperar esse webhook antes de dizer “boleto disponível”, pois ele garante que já tem os dados. Alternativamente, a API fornece URLs de PDF/HTML que podem estar acessíveis após a criação (comentaremos adiante). Mas é bom salvar esses dados se recebidos.

* **Atualizar o status interno:** Uma vez identificado o pagamento, faça as atualizações necessárias no seu sistema:

  * Marcar o pedido/fatura como **pago** no banco de dados ou estado do aplicativo.
  * Registrar a data do pagamento, valor pago etc. (o webhook de boleto fornece `paidin` com timestamp, o de Pix fornece `amount` e ids de transação, etc.).
  * Se for um app que notifica usuário (por exemplo, via e-mail ou update na tela em tempo real), esse é o momento de enviar uma notificação ao cliente confirmando pagamento recebido, liberar acesso a produto digital, etc.
  * O mais importante: assegurar que essa lógica seja **idempotente**, ou seja, se por acaso a Pagou enviar o mesmo webhook múltiplas vezes (o que pode acontecer se sua app não respondeu 200 rápido, ou em até 10 tentativas), você não processe duas vezes o mesmo pagamento. Uma forma simples é checar: “já marquei esse pedido como pago? então ignoro duplicata”. A Pagou tenta até 10 vezes em intervalos se não receber resposta 200 OK, então é crucial responder OK apenas após processar, e se repetir, não causar inconsistência.

* **Responder 200 OK:** Depois de processar, responda imediatamente com status **200 OK** à requisição do webhook. Isso sinaliza para a Pagou que você recebeu com sucesso. Se você não responder 200, ou demorar muito, ela tentará de novo (retries). Então, faça o processamento o mais rápido possível e responda. Se tiver algo que demore muito para fazer (ex: gerar um relatório), considere responder 200 e fazer essa parte de forma assíncrona, para não segurar a conexão. A documentação da Pagou enfatiza retornar 200 para confirmar e evitar reenvios.

**Segurança do webhook:** Uma observação – a Pagou inclui nos headers do webhook uma assinatura HMAC-SHA256 para você validar que a notificação veio deles e não de outra pessoa. Os headers `X-Pagou-Signature` e `X-Pagou-Timestamp` servem para você calcular um hash com sua API Key e conferir se bate, prevenindo tentativas maliciosas. Implementar a validação do webhook é uma boa prática (veja documentação Pagou sobre *Autenticação de Webhooks* para exemplos). Porém, para fins de começar a integração e sendo um guia a leigos, o principal é fazer funcionar. Então, inicialmente você pode não implementar a verificação de assinatura, **mas** tenha em mente para adicionar depois em produção, elevando a segurança. A Pagou indica que mesmo sem validar, eles enviam os webhooks – a validação fica por sua conta, se desejar.

**Testando localmente o webhook:** Uma dificuldade comum é testar o webhook sem ter que realmente pagar algo. Uma dica: use ferramentas como **Postman** ou cURL para simular a chamada da Pagou. Você pode copiar um exemplo de payload (como os mostrados acima ou da documentação Pagou) e fazer um POST manual para o endpoint do seu webhook com esse JSON. Verifique se sua função loga corretamente e atualiza o que deveria. Isso ajuda a depurar a lógica do webhook antes de realizar um pagamento real.

Recapitulando este passo: a função de webhook vai **receber** os eventos da Pagou e atualizar seu sistema. Ela deve lidar com pelo menos dois tipos de evento (`qrcode.completed` e `charge.paid`) para marcar pagamentos realizados. Ao final do processamento, retorna **HTTP 200 OK** rapidamente. Feito isso, a integração de notificação está completa: assim que um cliente pagar, em poucos segundos (no Pix, geralmente instantâneo; no boleto, quando o banco compensar, pode ser horas ou dias) sua aplicação será notificada e poderá tomar ação sem intervenção manual.

## 7. Criando boletos com a API Pagou (passo a passo)

Além do Pix, muitos negócios precisam oferecer Boleto como opção de pagamento. O processo é semelhante em conceito – você faz uma requisição para gerar o boleto e a Pagou retorna um ID; o cliente paga o boleto (normalmente até a data de vencimento); a Pagou envia webhook confirmando pagamento. Contudo, há algumas diferenças importantes nos campos e fluxo, que detalharemos agora.

No Base44, você pode ter uma função por exemplo chamada `createBoleto` (ou pode incorporar na mesma função de pagamento com uma condição Pix ou Boleto). Para clareza, vamos tratar separado. Ao gerar um boleto via API Pagou, o endpoint utilizado é `/v1/charges` (referente a *charge* de boleto) em vez de `/v1/pix`. A requisição deve conter diversos campos específicos de boleto, como data de vencimento, juros, multa etc. Vamos montar um payload de exemplo e explicar:

**Campos obrigatórios e importantes para boleto (payload do POST /v1/charges):**

```json
{
  "due_date": "2025-12-31",
  "grace_period": 5,
  "amount": 100.50,
  "description": "Pagamento do Pedido 12345",
  "payer": {
    "name": "João Silva",
    "document": "12345678901",
    "zip": "01234567",
    "street": "Rua das Flores",
    "city": "São Paulo",
    "state": "SP",
    "number": "123",
    "neighborhood": "Centro"
  },
  "fine": 2.0,
  "interest": 1.0,
  "discount": {
    "type": "fixed",
    "amount": 10.00,
    "limit_date": "2025-12-25"
  },
  "notification_url": "https://loja123.base44.io/pagouWebhook",
  "customer_code": "CUST-001"
}
```

Vamos entender cada campo:

* **due\_date:** Data de vencimento do boleto, formato YYYY-MM-DD. No exemplo, 31/12/2025. É até quando o cliente pode pagar sem estar vencido.
* **grace\_period:** Período de carência em dias após o vencimento em que ainda pode pagar antes de considerar inadimplente. No exemplo colocamos 5 dias. Durante esses dias após 31/12, o boleto ainda poderia ser pago (geralmente com multa/juros).
* **amount:** Valor do boleto em reais. No exemplo, R\$ 100,50. **Importante:** a API Pagou exige valor mínimo de R\$ 5,00 para boletos (boletos de valor menor não são usualmente permitidos pelo sistema bancário).
* **description:** Descrição do boleto, similar ao Pix – identifica o pagamento. Pode ser um texto tipo “Pagamento do pedido 12345”.
* **payer:** Objeto com dados completos do pagador (sacador). Diferente do Pix, aqui são exigidos mais campos de endereço:

  * `name` e `document` (nome e CPF/CNPJ do pagador).
  * `zip` (CEP, somente números, 8 dígitos).
  * `street`, `number`, `neighborhood`, `city`, `state` (endereço completo do pagador). Estado é a sigla de 2 letras (SP, RJ, etc). Esses dados são necessários porque boletos registrados exigem identificação do pagador (norma desde 2018, boletos *sem registro* não existem mais).
* **fine:** Percentual de multa por atraso (campo obrigatório). Ex: 2.0 representa 2%. Esse valor será aplicado sobre o principal em caso de pagamento após vencimento. Se não quiser cobrar multa, pode colocar 0.0 (segundo o schema, mínimo 0 é aceito). Use pelo menos 0.1 se a API exigir um valor >0.
* **interest:** Percentual de juros de mora ao mês por atraso. Ex: 1.0 representaria 1% ao mês. Também pode ser 0 se não quiser cobrar juros (ou 0.1 se precisar mínimo). Note: 1.0% a.m. equivale \~0,033% ao dia, aplicado pro-rata dias de atraso.
* **discount:** (Opcional) Estrutura para desconto por antecipação ou pagamento até certa data. No exemplo, definimos:

  * `type: "fixed"` – desconto de valor fixo (poderia ser "percentage" para percentual).
  * `amount: 10.00` – R\$ 10,00 de desconto.
  * `limit_date: "2025-12-25"` – se pago até 25/12/2025, o cliente paga R\$ 90,50 (100,50 - 10). Depois dessa data, o desconto não vale mais.
    Esse campo todo é opcional; se não quiser oferecer desconto, pode omitir ou passar amount 0.
* **notification\_url:** URL do webhook, igual explicamos antes. Coloque seu endpoint público (mesmo do Pix, pode usar o mesmo webhook para ambos tipos de evento).
* **customer\_code:** campo livre opcional, semelhante ao Pix.

Você envia essa estrutura em um POST para `https://sandbox.api.pagou.com.br/v1/charges` (ou produção quando for o caso), incluindo os headers `X-API-KEY` etc. A chamada é muito parecida com a do Pix em termos de implementação de código (pode até reutilizar a lógica do fetch, só mudando URL e payload). Não esquecer de passar `Content-Type: application/json` e autenticação do mesmo jeito.

**Resposta da criação do boleto:** Se tudo deu certo, a Pagou retorna **201 Created** e um JSON com o **ID do boleto** e alguns detalhes. Esse ID é um UUID como `09cd8523-85e8-400f-...`. Guarde esse ID – ele identifica unicamente o boleto. Note que diferentemente do Pix, a resposta imediata *não traz* o código de barras ou linha digitável. Isso acontece porque a geração completa do boleto (registro no banco) pode levar alguns segundos. A Pagou então envia via webhook `charge.created` essas informações assim que prontas. Ou seja, após o POST, você já tem um boleto criado, mas para obter os números exatos do boleto você espera o webhook ou consulta via GET /charges/{id} depois de alguns instantes.

**Obtendo código de barras/linha digitável:** Assim que receber o webhook `charge.created` no seu endpoint, você terá no payload JSON campos:

* `data.payload.bar_code` – a linha numérica do código de barras (geralmente 44 números).
* `data.payload.line` – a linha digitável completa do boleto (normalmente 47 números em grupos).
  Esses são os dados que o cliente usará para pagar, caso vá digitar o código ou precisar do boleto em si. A Pagou também fornece URLs para visualizar o boleto:
* URL para PDF: `https://fatura.pagou.com.br/boleto/pdf/{id}`
* URL para página HTML: `https://fatura.pagou.com.br/boleto/{id}`
  Onde `{id}` é o UUID do boleto retornado. Após a criação, em poucos segundos essas URLs passam a servir o boleto (PDF para impressão, HTML para visualizar em navegador). A documentação nota que pode não estar **imediatamente** disponível até o registro ser concluído – por isso aguardar o webhook de `charge.created` garante que já está pronto.

**O que fazer com os dados do boleto:**

* Você pode **exibir para o cliente** um botão/link de “Visualizar Boleto” usando a URL do PDF ou HTML fornecida. Por exemplo, após criar o boleto, montar um link para `fatura.pagou.com.br/boleto/pdf/ID`. Assim o cliente clica e baixa/imprime o boleto oficial.
* Mostrar a **linha digitável** no app para o cliente copiar e pagar via internet banking. Muitas pessoas preferem copiar e colar a linha no aplicativo do banco. Então, apresente a sequência numérica (os 47 dígitos) de forma clara e talvez até com um botão "Copiar código".
* Opcionalmente, você pode usar uma biblioteca para gerar um código de barras ou QR Code do boleto na sua interface, mas dado que a Pagou já dá o PDF com tudo, não é necessário.
* **Salvar no seu banco de dados** os detalhes: ID do boleto, vencimento, valor, linha digitável. Assim, se o cliente precisar da segunda via, você tem guardado. Se quiser reconciliar pagamentos manualmente, também tem referência.

**Webhook de pagamento do boleto:** Já cobrimos no passo anterior – quando o cliente pagar (provavelmente antes ou até a due\_date), a Pagou enviará um `charge.paid`. Ao recebê-lo, você marca o pedido como pago, tal como com o Pix. Você pode também conferir se o valor pago (`data.amount.paid`) bate com o esperado (em geral sim, mas caso tenha juros ou desconto diferentes do valor original, ali indica). O webhook traz `paidin` com a data/hora do pagamento confirmado. Você pode armazenar isso.

**Erros comuns na geração de boletos:** Alguns cuidados:

* CPF/CNPJ inválido ou faltando no payer resultará em erro 400 (Bad Request). Certifique-se de ter CPF/CNPJ válido e com 11/14 dígitos apenas números.
* Endereço incompleto no payer também pode gerar erro. Todos aqueles campos são obrigatórios conforme o schema (name, document, zip, street, city, state, number, neighborhood). Não deixe nenhum faltando.
* Valor abaixo de 5.00 dará erro (ex.: "amount must be >= 5").
* Formato de data due\_date inválido (deve ser YYYY-MM-DD) também dará erro 400.
* Chave API faltando ou errada dá 401 (como sempre).
* Se algum campo violar as regras (ex: state não em 2 letras, CEP não 8 dígitos), a API retorna mensagem de erro específica indicando o que corrigir. Olhe o corpo de erro JSON retornado para pistas.

**Exemplo de código (resumido) para criar boleto:** Seria análogo ao do Pix, algo como:

```javascript
const boletoPayload = { ...conforme definido acima... };
const res = await fetch('https://sandbox.api.pagou.com.br/v1/charges', { 
  method: 'POST',
  headers: {
    'X-API-KEY': API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(boletoPayload)
});
if (res.ok) {
   const data = await res.json();
   console.log("Boleto ID:", data.id);
   console.log("Status inicial:", res.status); // deve ser 201
   // Talvez data já contenha alguns detalhes básicos do boleto.
} else {
   const err = await res.json();
   console.error("Erro ao criar boleto:", res.status, err);
}
```

Após chamar isso, você teria `data.id` do boleto. Pode então apresentar uma mensagem ao usuário: "Boleto gerado! Use o link abaixo para visualizar." e mostrar o PDF/HTML link. Ou "Boleto gerado! Linha digitável: XXX" caso já tenha pelo webhook (talvez sua lógica espere o webhook chegar antes de confirmar a exibição – isso pode ser um pequeno desafio de UX, talvez mostrar um loading "Gerando boleto..." até o webhook chegar).

Uma estratégia: chamar a função de gerar boleto e, em seguida, **aguardar o webhook `charge.created`** para então liberar o botão de download do boleto. Como o webhook deve chegar em segundos, o usuário não sofre muito. Se preferir não depender disso, pode colocar um botão "Atualizar boleto" que tenta buscar via GET /charges/{id} depois de alguns segundos. A Pagou não detalhou se o GET /charges imediatamente após retorna a linha – possivelmente não imediatamente, mas após registro sim. De qualquer forma, o webhook resolve esse sincronismo.

Resumindo, criar boleto envolve um pouco mais de dados e tratamento do que Pix, mas a Pagou facilita provendo o PDF e fazendo reentregas via webhook. Depois de integrado, você terá a solução completa: ao selecionar pagamento por boleto, sua aplicação chama a função de geração de boleto, obtém o ID, espera detalhes e apresenta ao cliente. O cliente paga (geralmente no mesmo dia ou até a data de vencimento). Assim que pago, sua app é notificada e prossegue para concluir o pedido.

## 8. O que verificar em caso de erro ou falha de autenticação

Mesmo seguindo todos os passos, podem ocorrer erros. Aqui listamos problemas comuns na integração Pagou + Base44 e como solucioná-los:

**Erro 401 Unauthorized nas requisições à API Pagou:** Esse erro indica problema na autenticação. Verifique:

* Se o header `X-API-KEY` está sendo enviado corretamente em todas as chamadas.
* Se a chave usada é a correta (copie novamente do painel Pagou para ter certeza). As vezes um caractere faltando pode invalidar.
* Se você não confundiu ambientes: por exemplo, usando a chave de sandbox na URL de produção ou vice-versa. Lembre que sandbox e produção podem ter chaves diferentes, dependendo do sistema da Pagou.
* Caso a Pagou tenha um dashboard para gerenciar chaves, confira se a chave está **ativa** e se não requer alguma permissão especial (por exemplo, algumas APIs têm restrição de IP – não parece ser o caso da Pagou pelo que vimos, mas não custa checar configurações).
* Mensagem de erro: a documentação diz “`X-API-KEY` inválido ou ausente. Verificar chave em Configurações > API.”. Ou seja, é quase certo que ou está faltando o header, ou a string da chave está errada. Solução: corrigir e tentar novamente.

**Erro 400 Bad Request ao criar Pix ou Boleto:** O código 400 significa que a API rejeitou algo no seu payload (dados enviados). As causas mais frequentes:

* **Dados fora do formato ou faltando.** Por exemplo, CPF inválido, CEP faltando, nome muito longo, etc. A Pagou geralmente retorna no corpo do erro uma mensagem explicando. Exemplo: `{"error": "amount must be greater than or equal to 0.01"}`, indicando que você mandou um valor abaixo do mínimo. Ou `{"error": "document is not valid"}` em caso de CPF/CNPJ errado. Sempre imprima/logue o `errBody` da resposta de erro para ver a mensagem.
* **Campos obrigatórios ausentes.** Revise os required: para Pix, `amount`, `description`, `expiration`, `payer.name`, `payer.document` são obrigatórios. Para boleto, há vários obrigatórios (todos de payer + due\_date, amount, description, fine, interest, grace\_period). Se faltar algo, virá erro de validação. Solução: conferir o payload construído e preencher os campos necessários.
* **Valor fora dos limites.** Como citado: *amount* de boleto <5, *expiration* de Pix fora do intervalo (min 60s), *fine* ou *interest* negativos ou acima de 100 (porcentagem), etc. A doc lista os limites – use os valores dentro do range.
* **Formato de campo inválido.** Ex.: `due_date` não está em AAAA-MM-DD, ou CPF com pontos. Novamente, veja a mensagem de erro. A doc também exemplificou: “Payload inválido (ex.: CPF inválido, amount < 5, expiration fora do intervalo)”. Então esses são bons checks:

  * CPF/CNPJ deve ter só dígitos (11 ou 14).
  * CEP deve ter 8 dígitos.
  * state deve ser 2 letras.
  * amount de Pix >= 0.01; amount de boleto >= 5.00.
  * expiration Pix entre 60 e 604800.
  * etc.
* **Idempotency (409 Conflict):** Se você reutilizou um `Idempotency-Key` já usado recentemente para criar Pix/charge, a API pode retornar um resultado duplicado ou erro. Isso não é exatamente 400, mas vale notar. Solução: gere um novo Idempotency-Key para cada nova transação ou entenda que a duplicada significa que a requisição anterior já foi processada.

**Webhook não chegando:** Você percebe que pagamentos feitos não estão atualizando o status na aplicação.

* **Verifique o `notification_url` que você enviou no POST.** Está correto e público? Muitas vezes o erro está em um typo na URL, ou esquecimento de incluir `https://`. Por exemplo, se mandou `http://` em vez de `https://`, a Pagou pode nem ter tentado (pode exigir HTTPS). Ou se mandou um endereço errado, obviamente não chega. Solução: conferir nos logs das requisições enviadas qual URL foi cadastrada.
* **Ambiente de webhook em teste:** Se você está em sandbox, confira se a Pagou envia webhooks no sandbox. A maioria das APIs de pagamento envia webhooks tanto no sandbox quanto produção, mas sempre bom confirmar. Supondo que sim, talvez seu endpoint não esteja acessível publicamente (veja passo 4). Tente acessar a URL do webhook via navegador ou `curl` de um computador externo – se não resolver, a Pagou também não consegue acessar.
* **Logs e retentativas:** Veja se o Base44 ou seu servidor loga requisições recebidas. Pode ser que o webhook tenha chegado mas sua função deu erro e não completou. Lembre, se você não retornou 200 OK, a Pagou tentará de novo até 10 vezes. Então talvez ainda chegue. Verifique se sua função não está crashando por alguma exceção não tratada. Por exemplo, acessar uma propriedade inexistente do JSON poderia causar erro. Adicione logs no início da função webhook para confirmar entrada.
* **Certificado SSL válido:** Se você está usando um domínio próprio, verifique se o certificado HTTPS está ok (cadeado no navegador). A Pagou exige SSL válido – não vai funcionar com IP nem com certificados auto-assinados. Em dev, ngrok já cuida disso fornecendo um \*.ngrok.io válido.
* **Autenticação do webhook (opcional):** Se você habilitou alguma autenticação no seu endpoint (por exemplo, token ou Basic Auth), a Pagou não saberá disso a menos que você tenha incorporado no URL. A doc menciona somente assinatura HMAC deles, não credencial, então mantenha o endpoint aberto para Pagou ou implemente a verificação via assinatura. Não tente colocar usuário e senha no URL do webhook (a não ser que Pagou suportasse e enviasse – o que não é citado).

**Pagamento não confirmado (delay):** No caso de boleto, lembre-se que não é instantâneo. Se um cliente paga hoje, geralmente a confirmação (webhook) vem no próximo dia útil após a compensação. Não há erro aqui, é comportamento normal. Então não se alarme se um boleto pago não disparar webhook imediato – aguarde o tempo de liquidação bancária.

**Debug geral:** Uma estratégia boa em caso de problemas é usar ferramentas de inspeção:

* Use um **request bin** (serviço de coleta de webhooks) temporariamente para ver o que Pagou está enviando. Por exemplo, substitua `notification_url` por um endpoint do [WebhookRelay](https://webhookrelay.com) ou requestbin e veja se os eventos saem da Pagou.
* Verifique no painel Pagou (se houver seção de log/webhooks) se consta tentativas de envio e alguma mensagem de erro (algumas plataformas mostram).
* Teste chamadas manuais: por exemplo, use a mesma `X-API-KEY` e tente um GET em `/v1/charges/{id}` ou `/v1/pix/{id}` para ver se autentica. Se 401, algo errado com a key.
* Atualize sua função via console logs para imprimir todo o req.body recebido no webhook em um lugar que você consiga ver (monitor do Base44). Assim você sabe exatamente o conteúdo recebido.

Em resumo, ao enfrentar um erro, **observe as mensagens e códigos retornados**, pois a API Pagou fornece informações úteis para resolver (400 vs 401 vs 500 etc., e mensagens específicas). Ajuste o que for necessário (dados ou credenciais) e tente novamente. Após alguns ciclos de teste, sua integração deve ficar robusta.

## 9. Testando e validando a integração

Depois de implementar todas as partes (função de criar Pix, função de criar boleto, função de webhook, configuração de keys e URLs), é hora de testar a integração ponta a ponta. Recomenda-se seguir um roteiro de testes:

**Teste no ambiente sandbox da Pagou:**
Utilize o endpoint de sandbox para evitar transações reais. A Pagou permite simular a criação de transações sem custo. Faça o seguinte:

1. **Gerar um Pix de teste:** Acione a função `createDynamicPix` (por exemplo, através do front-end do seu app ou chamando a função diretamente no ambiente do Base44) com um valor simbólico (ex: R\$ 1,00). Verifique se a resposta aparece corretamente: código Pix e imagem base64. Tente escanear o QR Code com a câmera do seu celular ou app de banco (mesmo sem concluir o pagamento, só para ver se reconhece o valor e descrição – isso garante que o QR é válido). Como está em sandbox, mesmo que você tente pagar, provavelmente não vai concluir de verdade (o banco talvez nem reconheça o código sandbox ou, se reconhecer, será um ambiente fictício). O importante aqui é checar se **sua aplicação conseguiu obter o QR Code** e se nenhuma validação inicial falhou.
2. **Simular webhook Pix:** Já que no sandbox o Pix não será realmente pago, você pode simular o webhook. Como mencionado, copie o JSON de exemplo de um `qrcode.completed`, substitua os dados pelos do Pix que você gerou (pelo menos o `data.id` deve bater, e `event_name` = "qrcode.completed"), e use um cliente HTTP (Postman, curl) para enviar um POST ao seu endpoint `pagouWebhook`. Veja se sua função logou e processou como esperado (deveria marcar o status do pedido correspondente como pago). Observe se sua função respondeu 200 OK – no Postman você verá a resposta. Isso valida que a lógica do webhook está correta.
3. **Gerar um boleto de teste:** Chame a função de criação de boleto com dados fictícios (valor, pagador etc.). Use um CPF válido (pode ser o seu ou um gerado, contanto que seja verossímil). Verifique a resposta: deve retornar 201 e um ID de boleto. Como esse é sandbox, possivelmente a Pagou *ainda gera um boleto de verdade* em ambiente de testes – talvez até consiga acessar a URL PDF. Tente abrir `https://fatura.pagou.com.br/boleto/pdf/{id}` no navegador. Se abrir um PDF com “Boleto de teste” ou assim, ótimo. Se não abrir imediatamente, aguarde um pouco e tente de novo.
4. **Receber webhook de boleto criado:** Veja se seu webhook recebeu o evento `charge.created`. Ele deve chegar muito rápido (segundos) após criar o boleto. Nesse evento, verifique se sua função armazenou ou logou a linha digitável e demais detalhes. Confirme que a URL do boleto (PDF) está acessível. Isso garante que a emissão foi completada.
5. **Simular pagamento do boleto:** Novamente, em sandbox o boleto não será pago de verdade. Então simule o webhook: envie manualmente um JSON de `charge.paid` com o id do boleto que você gerou. Verifique se sua aplicação marcou o status como pago.
6. **Fluxo completo no front-end:** Se você tem uma interface (UI), faça um teste completo como se fosse um usuário: selecione um produto, escolha pagar com Pix, acione o pagamento. O app deve chamar a função de Pix, obter o QR e exibir para você. Imite o pagamento (nesse ponto, como não dá para concluir no sandbox, apenas avance simulando). Depois, escolha pagar com boleto, veja se gera o PDF/linha, etc. Embora não finalize, você valida que a UX está funcionando até onde dá no sandbox.

**Teste em produção com valor baixo:** Uma vez satisfeito no sandbox, é altamente recomendável fazer um **teste real em produção** antes de colocar para os clientes. Para isso, troque a URL da API para produção e use sua chave de produção:

* Gere um Pix de, por exemplo, R\$0,50 (ou o mínimo permitido). Pegue o QR Code e **pague de verdade** usando seu app bancário. Certifique-se de usar um valor que não te faça falta, pois este dinheiro vai para a conta ligada ao Pagou (depois você pode sacar ou se for sua conta, retorna). Ao pagar, veja se em poucos segundos sua aplicação recebe o webhook `qrcode.completed`. O pedido deve marcar como pago automaticamente. Verifique no dashboard Pagou se aparece a transação. Se tudo ocorreu, parabéns – Pix integrado 100%.
* Gere um boleto de valor baixo (ex: R\$ 5,00). Pode colocar sua própria informação de pagador. Pegue o PDF, veja se parece ok (será um boleto real). Vá no seu internet banking (ou app) e tente pagar este boleto. Como é valor pequeno, o custo é baixo. Pague. Normalmente, boletos pagos em horário comercial de dia útil confirmam no mesmo dia ou no próximo. Assim que for compensado, seu webhook deve receber `charge.paid`. Cheque se veio e se o status atualizou. Pronto, boleto integrado e testado.

**Validação de ponta a ponta:** Após esses testes, você deve ter confiança de que:

* Sua aplicação consegue criar pagamentos via Pagou (Pix e boleto).
* O cliente consegue visualizar as instruções de pagamento (QR code, linha digitável ou PDF do boleto).
* Os eventos de confirmação chegam e são devidamente tratados (status atualizado sem intervenção manual).
* Nenhum erro crítico está ocorrendo (autenticação, validação etc. resolvidos).

**Checklist final em produção:**

* Remova ou proteja qualquer log sensível (não deixe API Keys expostas em logs).
* Assegure que a chave de API de produção está sendo usada e não a de sandbox.
* Verifique limites: por exemplo, Pagou pode ter limites de valores ou quantidade – se for relevante, confirme no contrato/plano.
* Documente para sua equipe de suporte o fluxo: às vezes é útil ter logs armazenados das transações (ex: guardar no banco um registro de cada Pix/boleto gerado, com seu status).
* Configure notificações ou monitoramento: por exemplo, se um webhook não acontecer em X dias (boleto não pago), talvez alertar o cliente ou cancelar pedido. Isso já é lógica de negócio além da integração, mas importante para fechamento de ciclo.

Com tudo isso, sua integração Pagou <-> Base44 estará completa. Você conseguirá oferecer aos clientes **PIX** (pagamento instantâneo) e **Boleto** (pagamento acessível) de forma integrada no seu app, com confirmação automática. Boa sorte e bons pagamentos!

**Referências:** Documentação oficial da API Pagou foi utilizada para embasar os passos acima, incluindo detalhes dos endpoints de Pix, endpoints de boleto, estrutura de webhooks e tratamentos de erro. Confira [a documentação da Pagou](https://docs.pagou.com.br/integracao-com-a-api) para informações adicionais e atualizações futuras.
