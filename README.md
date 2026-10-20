# Pagou + Base44

Integração da API da [Pagou](https://pagou.com.br) com apps [Base44](https://base44.com): Pix, boleto (com Pix vinculado) e cartão de crédito, com webhook assinado, reconciliação e painel admin.

Duas formas de usar:

1. **Copiar o código pronto** deste repositório para o seu app (recomendado: é o que está testado).
2. **Pedir ao Base44** para construir a partir do [PROMPT-BASE44.md](PROMPT-BASE44.md), em 4 etapas.

Baseado na documentação oficial: https://docs.pagou.com.br

## Como funciona

```
Navegador (React)                 Backend functions (Deno)              Pagou
-----------------                 ------------------------              -----
PagouPixPayment     --invoke-->   pagouCreatePix         --X-API-KEY--> POST /v1/pix
PagouBoletoPayment  --invoke-->   pagouCreateBoleto      ------------>  POST /v1/charges
PagouCardForm                     pagouCreateCardCharge  ------------>  POST /v1/creditcard/charges
  (tokeniza o cartão)  --token--> 
polling             --invoke-->   pagouChargeStatus      ------------>  GET  /v1/{pix|charges|creditcard/charges}/{id}
PagouAdminPanel     --invoke-->   pagouReconcile         ------------>  GET  listagens (nunca cria)
                                  pagouSimulate (Sandbox) ----------->  POST /v1/payment-simulations/...
                                  pagouWebhook           <--HMAC------  qrcode.completed, qrcode.refunded,
                                                                        charge.created, charge.paid
```

Regras que o código garante (e os testes conferem):

- A chave da Pagou só existe no backend, em variável de ambiente.
- O valor cobrado vem do pedido no banco, nunca do navegador.
- Pedido só vira pago por **webhook com assinatura válida** ou por **consulta** à Pagou, e só se o valor bater.
- Webhook: assinatura HMAC-SHA256 sobre `timestamp + corpo bruto`, janela de 5 minutos, comparação em tempo constante, deduplicação, resposta exatamente `200`.
- Pix e boleto nunca são recriados automaticamente. Timeout ou erro 5xx deixa a cobrança como `uncertain` e a reconciliação resolve.
- Cartão usa `Idempotency-Key`. O token do cartão nunca é gravado: guardamos o resto do corpo e um hash, e a repetição remonta exatamente os mesmos bytes.
- Status nunca regride (um evento atrasado não "despaga" um pedido).
- Logs não contêm chave, cartão, token nem o payload do pagador.

## Estrutura

| Caminho | O que é |
| --- | --- |
| `functions/*.ts` | As 8 backend functions, cada uma autocontida (o Base44 publica cada função isolada). |
| `shared/pagou.ts` | Fonte do código comum. `npm run sync` copia para dentro de cada função. |
| `entities/*.json` | `PagouCharge`, `PagouWebhookEvent` e um `Order` de exemplo. |
| `components/pagou/*.jsx` | Telas de Pix, boleto, cartão e o painel admin. |
| `tests/` | 50 testes com Base44 e Pagou simulados. Nenhum toca a rede. |
| `PROMPT-BASE44.md` | Prompts para o Base44 construir tudo pelo chat. |

## Instalação no Base44

**Pré-requisito:** plano do Base44 com **backend functions**. Sem elas não há como esconder a chave da Pagou.

### 1. Segredos

Em *Dashboard > Settings > Environment variables*:

| Variável | Valor |
| --- | --- |
| `PAGOU_API_KEY` | Chave de Sandbox (painel da Pagou) |
| `PAGOU_BASE_URL` | `https://api.pagou.cloud` |
| `PAGOU_ENV` | `sandbox` |
| `PAGOU_WEBHOOK_URL` | URL pública da função `pagouWebhook` (passo 3) |
| `PAGOU_CRON_SECRET` | Opcional. 32+ caracteres aleatórios, para a reconciliação agendada |
| `PAGOU_API_KEY_PREVIOUS` | Opcional. Chave antiga durante uma rotação (o webhook aceita as duas) |
| `PAGOU_BOLETO_DUE_DAYS` | Opcional. Dias até o vencimento (padrão 3) |
| `PAGOU_BOLETO_GRACE_DAYS` | Opcional. Tolerância após o vencimento, 1 a 30 (padrão 7) |
| `PAGOU_BOLETO_FINE_PERCENT` | Opcional. Multa em % |
| `PAGOU_BOLETO_INTEREST_MONTHLY_PERCENT` | Opcional. Juros em % **ao mês** |

A integração se recusa a rodar se `PAGOU_BASE_URL` não corresponder a `PAGOU_ENV`. Isso evita usar a chave de um ambiente na URL do outro.

### 2. Entidades

Crie `PagouCharge` e `PagouWebhookEvent` com os esquemas de `entities/`. Confira no painel de segurança do Base44 que:
- `PagouCharge`: o dono lê as próprias; só admin escreve.
- `PagouWebhookEvent`: só admin lê (guarda CPF e dados bancários do pagador).

### 3. Funções

Em *Dashboard > Code > Functions*, crie cada função com o **mesmo nome do arquivo** e cole o conteúdo de `functions/`. Depois copie a URL pública de `pagouWebhook` para `PAGOU_WEBHOOK_URL`.

### 4. Adapte o pedido

O único trecho que depende do seu app é o **adaptador do pedido** no bloco compartilhado (`loadOrderForUser`, `markOrderPaid`, `markOrderRefunded`). Ele espera uma entidade `Order` com os campos de `entities/Order.example.json`. Se o seu pedido tem outro nome ou outros campos, ajuste o adaptador em `shared/pagou.ts`, rode `npm run sync` e cole as funções de novo.

> O `total_cents` do pedido precisa ser calculado no backend. Se o navegador pode criar o pedido com o total que quiser, a integração cobra esse total.

### 5. Telas

Copie `components/pagou/` para `src/components/pagou/` e use:

```jsx
<PagouPixPayment orderId={order.id} isAdmin={user.role === "admin"} onPaid={...} />
<PagouBoletoPayment orderId={order.id} isAdmin={user.role === "admin"} onPaid={...} />
<PagouCardForm orderId={order.id} amountCents={order.total_cents} onPaid={...} />
<PagouAdminPanel />
```

### 6. Reconciliação agendada (opcional)

Se o seu plano tiver automações agendadas, chame `pagouReconcile` a cada 15 minutos com o header `X-Cron-Secret: <PAGOU_CRON_SECRET>`. Sem isso, use o botão "Reconciliar agora" do painel.

## Testes

```bash
npm test
```

Roda sem chave e sem rede: o Base44 e a Pagou são simulados em memória. Cobre criação, resultado incerto sem repetição, idempotência do cartão, assinatura do webhook (inclusive corpo alterado, timestamp velho e rotação de chave), deduplicação, valor divergente, devolução parcial, boleto pago pelo Pix vinculado e reconciliação.

Exige Node 22.18 ou mais novo (roda TypeScript direto).

### Testar no Sandbox

1. Com os segredos de Sandbox, gere um Pix e use **Simular pagamento (teste)** (só admin).
2. Boleto: espere a linha digitável e simule o pagamento pelo Pix vinculado.
3. Cartão: `4111 1111 1111 1111`, validade futura, qualquer CVV. Exige credenciamento de cartão aprovado na Pagou.

A simulação responde `202`, o que **não** é pagamento: o pedido vira pago quando o webhook chega.

## Produção

1. Troque `PAGOU_API_KEY`, `PAGOU_BASE_URL=https://api.pagou.com.br` e `PAGOU_ENV=production`.
2. Faça uma compra real de valor baixo com cada meio e confira no painel da Pagou.
3. Ao trocar a chave, coloque a antiga em `PAGOU_API_KEY_PREVIOUS` até as cobranças antigas fecharem: elas continuam assinadas com a chave antiga.

Fora do escopo (são operações irreversíveis, feitas pelo painel da Pagou): estorno, cancelamento, captura manual, nova tentativa de cartão e chargeback.

## Mapa de status

| Pagou | Local |
| --- | --- |
| Pix `1` / `2` / `3` / `4` / `5` | `pending` / `active` / `canceled` / `paid` / `refunded` |
| Boleto `4`, `8`, `9` | `paid` (8 com desconto, 9 com multa ou juros) |
| Boleto `6` | `failed` (registro rejeitado) |
| Boleto `3` com Pix vinculado em `4` | `paid` |
| Cartão `captured`, `settled` | `paid` |
| Cartão `authorized`, `pending` | `pending` |
| Cartão `charged_back`, `unknown`; Pix `6`; boleto `7` | sem mudança, marcado para revisão |

## O que mudou em relação à versão 1

A versão anterior deste repositório era só um guia em texto, com erros que quebravam a integração:

- **URL de Sandbox errada:** usava `sandbox.api.pagou.com.br`, que não existe. O correto é `https://api.pagou.cloud`.
- **Nomes de campo errados no webhook:** lia `event_name` (o correto é `name`) e `paidin` (o correto é `paid_in`). Com isso, o webhook nunca reconhecia o evento.
- **Segurança fraca:** tratava a validação da assinatura como opcional e sugeria pôr a chave no código.
- **Cobertura incompleta:** não tinha cartão, idempotência, reconciliação nem simulação.

## Referências

- [Documentação da API](https://docs.pagou.com.br) · [índice para agentes](https://docs.pagou.com.br/llms.txt)
- [Autenticação de webhooks](https://docs.pagou.com.br/integracao-com-a-api/autenticacao-de-webhooks.md)
- [Simulando pagamentos em Sandbox](https://docs.pagou.com.br/integracao-com-a-api/simulando-pagamentos-em-sandbox.md)
- [SDK do Base44](https://www.npmjs.com/package/@base44/sdk)
