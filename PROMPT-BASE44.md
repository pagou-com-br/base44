# Prompt: integração Pagou no Base44

Prompts para colar no chat do Base44 e integrar a API da Pagou (Pix, boleto e cartão de crédito) com backend functions, webhook assinado e reconciliação.

> Prefere não depender do chat? O código pronto e testado destes 4 prompts está neste repositório (`functions/`, `entities/`, `components/pagou/`). Veja o [README](README.md).

Baseado na documentação oficial em https://docs.pagou.com.br (revisada em 19/10/2026).

## Como usar

1. **Antes de tudo, no painel da Pagou:** gere a chave de **Sandbox** (https://docs.pagou.com.br/credenciais-de-acesso.md).
2. **No Base44:** confirme que o app tem **backend functions** habilitadas (exige plano que inclua backend functions). Sem elas, a integração não é segura: a chave da Pagou nunca pode ir para o navegador.
3. **Cadastre os segredos** em *Dashboard > Settings > Environment variables* (ou "Secrets"), **não no chat**:
   - `PAGOU_API_KEY` = chave de Sandbox
   - `PAGOU_BASE_URL` = `https://api.pagou.cloud`
   - `PAGOU_ENV` = `sandbox`
   - `PAGOU_WEBHOOK_URL` = fica em branco por enquanto; você preenche depois que a função `pagouWebhook` existir (passo 5 do Prompt 1)
4. **Cole os prompts em ordem**, um por vez. Só passe para o próximo depois de testar o anterior. Vibe coders perdem coerência com mudanças grandes; fatiar em 4 entregas evita retrabalho.
5. Se o Base44 tiver um campo de instruções permanentes do app (Knowledge / Custom instructions), cole lá o bloco **Regras permanentes** abaixo. Se não tiver, ele já vai dentro do Prompt 1.

Para produção: troque `PAGOU_API_KEY` pela chave de produção, `PAGOU_BASE_URL` para `https://api.pagou.com.br` e `PAGOU_ENV` para `production`. Nada no código muda.

---

## Regras permanentes

```text
REGRAS PAGOU (valem para todo o app, sempre):

1. A chave da Pagou só existe no backend, lida com Deno.env.get("PAGOU_API_KEY"). Nunca no frontend, nunca em entidade, nunca em log, nunca em resposta de função. Nunca escreva uma chave no código, nem como exemplo.
2. URL base vem de Deno.env.get("PAGOU_BASE_URL"). Nunca escreva api.pagou.com.br nem api.pagou.cloud fixo no código. Não existe "sandbox.api.pagou.com.br": esse endereço está errado.
3. Header de autenticação: X-API-KEY. Mande também User-Agent: "Base44-Pagou/2.0" e Content-Type: application/json quando houver corpo.
4. HTTP 201 NÃO é pagamento. Pedido só vira "pago" por webhook autenticado ou por consulta à API que retorne o estado de pago.
5. Pix e boleto: amount em REAIS (number com até 2 casas, ex.: 100.5). Cartão: value em CENTAVOS inteiros (ex.: 5000 = R$ 50,00). Guarde valores internamente em centavos inteiros e converta só na borda.
6. Criação de Pix e boleto NÃO tem idempotência. Nunca repita uma criação automaticamente. Em timeout, erro de rede ou 5xx: o resultado é INCERTO. Marque o registro como "uncertain" e reconcilie listando cobranças, nunca crie outra.
7. Cartão: toda criação leva header Idempotency-Key gerado uma vez por intenção de compra e salvo ANTES do envio. Repetição da mesma compra reusa a mesma chave e o mesmo corpo. Nova compra = nova chave.
8. Erros da Pagou não têm formato único: podem vir error (string), message, errors (array) ou code. Leia com checagem de tipo. Preserve code.
9. Campos opcionais: omita. Nunca mande null.
10. CPF/CNPJ e CEP: somente dígitos.
11. Nunca registre número de cartão, CVV, card_token, chave de API nem documento completo em log.
12. Na dúvida sobre um campo ou endpoint, pare e me pergunte. Não invente contrato. Referência: https://docs.pagou.com.br/llms.txt
```

---

## Prompt 1: fundação + Pix + webhook

```text
Quero integrar a API de pagamentos da Pagou (pagou.com.br) neste app, começando por Pix. Antes de escrever código, leia as regras abaixo e siga-as em todas as respostas.

[COLE AQUI O BLOCO "REGRAS PAGOU" INTEIRO, CASO NÃO ESTEJA NAS INSTRUÇÕES DO APP]

## Arquitetura

- Frontend chama SOMENTE backend functions via base44.functions.invoke(...). Nunca fetch direto na Pagou.
- Backend functions em Deno: Deno.serve + createClientFromRequest do SDK do Base44. Funções chamadas pelo usuário exigem base44.auth.me() e conferem que o pedido pertence ao usuário. Escritas em entidades pela integração usam base44.asServiceRole.
- Cada função é independente. Se o Base44 não permitir importar código entre funções, repita em cada função um helper pequeno pagouFetch(method, path, body?, extraHeaders?) que: monta a URL com PAGOU_BASE_URL, coloca X-API-KEY e User-Agent, aplica timeout de 30 s com AbortSignal.timeout(30000), devolve { ok, status, body, uncertain }. uncertain = true quando houve timeout, erro de rede ou status >= 500.

## Entidades

Crie (ou adapte, se já existir uma entidade de pedido) estas entidades:

1. PagouCharge
   - order_id (string, referência ao pedido do app)
   - user_email (string, dono)
   - method: "pix" | "boleto" | "card"
   - environment: "sandbox" | "production" (copiado de PAGOU_ENV no momento da criação)
   - amount_cents (number inteiro)
   - pagou_id (string, id retornado pela Pagou; vazio enquanto incerto)
   - status: "creating" | "pending" | "active" | "paid" | "canceled" | "refunded" | "partially_refunded" | "failed" | "expired" | "uncertain"
   - pagou_status_raw (string, último status numérico ou textual da Pagou)
   - pix_copy_paste (string), pix_qr_base64 (string), pix_expires_at (string ISO)
   - linked_qrcode_id (string, QR Code Pix vinculado ao boleto)
   - needs_review (boolean), refunded_amount_cents (number)
   - boleto_line (string), boleto_barcode (string), boleto_url (string), boleto_pdf_url (string)
   - idempotency_key (string, só cartão e simulação)
   - paid_amount_cents (number), paid_at (string ISO)
   - last_error_code (string), last_error_message (string)
   - created_window_start (string ISO, instante antes do POST, usado na reconciliação)

2. PagouWebhookEvent
   - event_key (string, chave de deduplicação: name + ":" + data.id + ":" + (data.transaction_id ou "-"))
   - name (string)
   - pagou_id (string)
   - payload (string, JSON bruto)
   - processed (boolean)
   - received_at (string ISO)
   - error (string)

PagouWebhookEvent e PagouCharge só podem ser lidas pelo dono (PagouCharge) ou por admin. O frontend nunca grava nelas.

## Função pagouCreatePix (POST /v1/pix)

Entrada do frontend: { order_id }. O valor NUNCA vem do frontend: leia o pedido no banco e calcule.
Fluxo:
1. auth.me(); carregue o pedido; confira dono e que não há PagouCharge pix "pending"/"active"/"paid"/"uncertain" para ele (se houver ativa, devolva a existente em vez de criar outra).
2. Crie PagouCharge com status "creating", created_window_start = agora.
3. POST /v1/pix com:
   {
     "amount": <reais, 2 casas>,
     "description": "Pedido <order_id>",
     "expiration": 3600,
     "payer": { "name": "<nome>", "document": "<cpf/cnpj só dígitos>" },
     "notification_url": Deno.env.get("PAGOU_WEBHOOK_URL"),   (omita o campo se a variável estiver vazia)
     "customer_code": "<order_id>",
     "metadata": [{ "key": "order_id", "value": "<order_id>" }]
   }
   Regras: expiration mínimo 60 segundos. amount > 0.
4. 201: grave pagou_id = body.id, status "active", pix_copy_paste = body.payload.data, pix_qr_base64 = body.payload.image. Devolva ao frontend só { charge_id, pix_copy_paste, pix_qr_base64, expires_in }.
5. 4xx: status "failed", grave code/mensagem. Devolva mensagem amigável.
6. uncertain: status "uncertain". NÃO repita. Devolva "Estamos confirmando seu Pix, aguarde" e deixe a reconciliação resolver.

## Função pagouChargeStatus (GET /v1/pix/{id})

Entrada: { charge_id }. Confere dono. Se a PagouCharge já está paid/canceled/refunded, devolve do banco sem chamar a Pagou. Senão consulta GET /v1/pix/{pagou_id} e aplica o mapa:
- status 1 = "pending", 2 = "active", 3 = "canceled", 4 = "paid", 5 = "refunded", 6 = investigar (grave pagou_status_raw = "6", não marque como pago).
Ao virar "paid" por consulta, confira body.amount contra amount_cents antes de liberar o pedido.
Respeite limite: o frontend chama esta função no máximo a cada 5 segundos e para depois de 10 minutos.

## Função pagouWebhook (pública, sem login)

Esta é a parte mais importante. Siga exatamente:
1. Aceite só POST.
2. Leia o corpo BRUTO com: const raw = new Uint8Array(await req.arrayBuffer()). NÃO faça req.json() antes de validar.
3. Headers obrigatórios: X-Pagou-Timestamp (segundos Unix, só dígitos) e X-Pagou-Signature (64 caracteres hex). Faltou ou formato errado: responda 401.
4. Rejeite se |agora - timestamp| > 300 segundos: 401.
5. Assinatura = HMAC-SHA256, chave = PAGOU_API_KEY, mensagem = bytes UTF-8 do timestamp concatenados com os bytes brutos do corpo, SEM separador. Use Web Crypto (crypto.subtle.importKey "raw" + HMAC SHA-256 + crypto.subtle.sign). Converta o resultado para hex minúsculo e compare com a assinatura recebida (em minúsculas) em TEMPO CONSTANTE (compare byte a byte acumulando com XOR, sem retornar cedo). Diferente: 401, sem tocar em nada.
6. Só agora: JSON.parse(new TextDecoder().decode(raw)). O envelope é { "name": "...", "data": { ... } }. O campo é "name", NÃO "event_name".
7. Monte event_key. Se já existe PagouWebhookEvent com esse event_key e processed = true: responda 200 sem reaplicar nada.
8. Grave PagouWebhookEvent (processed=false) ANTES de aplicar efeitos.
9. Aplique conforme name:
   - "qrcode.completed": localize PagouCharge por pagou_id = data.id. Confira data.amount (reais) contra amount_cents. Bateu: status "paid", paid_amount_cents, paid_at = agora, e marque o pedido como pago. Não bateu: não libere o pedido, grave last_error_code = "amount_mismatch".
   - "qrcode.refunded": data.amount é o valor DEVOLVIDO e pode ser parcial. Se igual ao pago: "refunded"; se menor: "partially_refunded".
   - "charge.created" e "charge.paid": deixe preparado com um TODO; serão implementados no Prompt 2.
   - Evento desconhecido: grave e responda 200.
   - PagouCharge não encontrada: grave o evento com error = "charge_not_found" e responda 200 (a reconciliação trata).
10. Um evento antigo nunca faz o pedido regredir (ex.: pedido "paid" não volta para "active").
11. Marque processed = true e responda EXATAMENTE status 200 (não 202, não 204). Se a gravação do evento falhar, responda 500 para a Pagou reenviar.
12. Responda rápido: a Pagou espera no máximo 30 s e reenvia até 10 vezes.
13. Nunca logue o corpo inteiro (tem CPF e dados bancários do pagador). Logue só name, data.id e event_key.

## Frontend

- Tela de pagamento Pix: QR Code com <img src="data:image/png;base64,{pix_qr_base64}">, botão "Copiar código Pix" com pix_copy_paste, contador de expiração, e polling em pagouChargeStatus a cada 5 s por até 10 min.
- Status em português: "Aguardando pagamento", "Pagamento confirmado", "Expirado", "Estamos confirmando seu pagamento".
- Layout mobile-first.
- Se o ambiente for sandbox, mostre um selo discreto "MODO TESTE" na tela de pagamento.

## Função pagouSimulate (só sandbox, só admin)

Para eu testar sem pagar de verdade:
- Recusa se PAGOU_ENV != "sandbox" ou PAGOU_BASE_URL != "https://api.pagou.cloud", e se o usuário não for admin.
- POST /v1/payment-simulations/pix/{pagou_id}, SEM corpo, com header Idempotency-Key = "sim-" + charge_id (salve na PagouCharge e reuse sempre a mesma).
- Sucesso é 202 com status "processing". Isso NÃO é pagamento: o pedido continua aguardando até o webhook ou a consulta mostrar status 4.
- Adicione um botão "Simular pagamento (teste)" visível só para admin em sandbox.

## Ao terminar

Me diga:
1. A URL pública exata da função pagouWebhook (a que aparece no painel de functions do Base44), para eu colocar em PAGOU_WEBHOOK_URL.
2. Quais entidades e funções você criou ou alterou.
3. Como eu testo o fluxo completo: criar Pix, simular, ver o webhook chegar e o pedido virar pago.

Não implemente boleto nem cartão ainda.
```

---

## Prompt 2: boleto

```text
Pix está funcionando. Agora adicione boleto, mantendo as REGRAS PAGOU.

## Função pagouCreateBoleto (POST /v1/charges)

Entrada: { order_id }. Valor do banco, nunca do frontend.
Mesma proteção contra duplicidade do Pix (não criar se já houver boleto ativo/pendente/incerto para o pedido).
Corpo:
{
  "amount": <reais, mínimo 5.00>,
  "description": "Pedido <order_id>",
  "due_date": "<YYYY-MM-DD, hoje ou futuro, em UTC; padrão hoje + 3 dias>",
  "grace_period": 7,                       (inteiro de 1 a 30)
  "payer": {
    "name": "...", "document": "<só dígitos>",
    "zip": "<8 dígitos>", "street": "...", "number": "<string>",
    "neighborhood": "...", "city": "...", "state": "<UF>"
  },
  "fine": 2,                               (percentual; opcional)
  "interest": 1,                           (percentual AO MÊS, não ao dia; opcional)
  "notification_url": PAGOU_WEBHOOK_URL,
  "customer_code": "<order_id>",
  "metadata": [{ "key": "order_id", "value": "<order_id>" }]
}
Todos os campos de endereço são strings. Valide antes de enviar e mostre erro claro no formulário (CEP, UF, CPF/CNPJ).
Se for usar desconto: discount = { type: "fixed" | "percentage", amount, limit_date } e limit_date não pode passar do vencimento.

O registro é ASSÍNCRONO: a resposta 201 traz o id, mas normalmente ainda não traz linha digitável. Grave pagou_id, status "pending" e:
- boleto_url = "https://fatura.pagou.com.br/boleto/" + id
- boleto_pdf_url = "https://fatura.pagou.com.br/boleto/pdf/" + id
Na tela, mostre "Gerando seu boleto..." até chegar a linha digitável.

## Webhook: complete os eventos de boleto

- "charge.created": registro disponível. Grave data.payload.line em boleto_line e data.payload.bar_code em boleto_barcode, status "active". Se vier Pix vinculado (data.payload.qrcode_id, data.payload.data, data.payload.image), grave data.payload.qrcode_id em linked_qrcode_id e também pix_copy_paste e pix_qr_base64 para oferecer "pagar com Pix" na mesma tela. charge.created NÃO é pagamento.
- "charge.paid": pagamento confirmado. data.amount.paid é o valor pago e data.amount.original o original (podem diferir por juros, multa ou desconto). Grave paid_amount_cents a partir de data.amount.paid e marque o pedido como pago.
Atenção: os nomes têm underscore (transaction_id, client_code, paid_in). Não existe "paidin".

## pagouChargeStatus para boleto (GET /v1/charges/{id})

Mapa de status: 1 "pending", 2 "active", 3 "canceled", 4 "paid", 5 "refunded", 6 "failed" (registro rejeitado), 7 investigar, 8 "paid" (com desconto), 9 "paid" (com multa ou juros).
Boleto com Pix vinculado: se o boleto aparecer cancelado (3), consulte também GET /v1/pix/{payload.qrcode_id}. O boleto pode ficar cancelado justamente porque foi pago pelo Pix. Só considere não pago se o Pix vinculado também não estiver em 4.

## Simulação em sandbox

Em pagouSimulate, adicione o caso boleto: POST /v1/payment-simulations/charges/{pagou_id} com corpo exato {"payment_method":"pix"} e Idempotency-Key fixa por cobrança. Só funciona quando o boleto está em status 2 e tem payload.qrcode_id. Não existe simulação de pagamento por linha digitável.

## Tela

Linha digitável com botão copiar, botões "Abrir boleto" e "Baixar PDF", vencimento, e o QR Code do Pix vinculado quando existir. Mobile-first.

Ao terminar, me diga como testar emissão, registro (charge.created) e pagamento simulado.
```

---

## Prompt 3: cartão de crédito

> Pré-requisito: a conta Pagou precisa ter **credenciamento de cartão aprovado** (painel da Pagou). Sem isso a API devolve `422 merchant_not_accredited`.

```text
Pix e boleto estão funcionando. Agora adicione cartão de crédito com checkout próprio, mantendo as REGRAS PAGOU.

## Frontend: tokenização (o número do cartão NUNCA sai do navegador em texto aberto)

Carregue estes scripts nesta ordem, na página de checkout:
<script src="https://cdn.jsdelivr.net/npm/node-forge@1.0.0/dist/forge.min.js" referrerpolicy="no-referrer"></script>
<script src="https://js.cel.cash/checkout-v2.min.js" referrerpolicy="no-referrer"></script>

Implemente a tokenização exatamente como na documentação oficial: https://docs.pagou.com.br/integracao-com-a-api/meio-de-pagamento-cartao-de-credito/tokenizando-um-cartao.md
Resumo:
- const lib = new window.BaasCard(producao); await lib._setPublicKey();   (producao = false em sandbox, true em produção. Obtenha esse booleano de uma função de backend que lê PAGOU_ENV.)
- const card = lib.newCard({ number: <só dígitos>, holder, expiresAt: "YYYY-MM", cvv }); card.validate(); const token = card.encrypt(lib._publicKey);
- Valide o token: string Base64, entre 64 e 16384 caracteres.
- Envie ao backend SOMENTE { order_id, card: { card_token: token, holder, expires_at: "YYYY-MM" }, installments }.
- Logo depois, apague número e CVV do estado e dos campos. Nunca guarde em localStorage, entidade, log ou analytics.
- Bloqueie duplo clique no botão Pagar enquanto a requisição estiver em andamento.

## Função pagouCreateCardCharge (POST /v1/creditcard/charges)

1. auth.me(), carregue o pedido, valor do banco.
2. Gere idempotency_key = crypto.randomUUID() e GRAVE na PagouCharge (status "creating") ANTES de chamar a Pagou.
3. Corpo:
{
  "customer": {
    "document": "<só dígitos>", "document_type": "cpf" | "cnpj",
    "name": "<mín. 3 caracteres>", "email": "...", "phone": "<10 a 14 dígitos>",
    "address": { "zip_code": "<8 dígitos>", "street": "...", "number": "...", "neighborhood": "...", "city": "...", "state": "<UF>" }
  },
  "card": { "card_token": "...", "holder": "...", "expires_at": "YYYY-MM" },
  "value": <CENTAVOS inteiros>,
  "installments": <1 a 12>,
  "payday": "<hoje em UTC, YYYY-MM-DD>",
  "description": "Pedido <order_id>",
  "antifraud": { "ip": "<IP real do comprador>" }
}
   antifraud.ip é obrigatório. Pegue do header x-forwarded-for (primeiro IP da lista) ou cf-connecting-ip da requisição recebida pela função. Nunca use o IP do servidor nem invente um.
   Header extra: Idempotency-Key: <a chave salva>.
4. Resposta 201: o resultado está em body.status (string), não no HTTP:
   - "captured" ou "settled": pago. Marque o pedido como pago. Não chame /capture.
   - "authorized": autorizado, captura ainda não confirmada. Status "pending" e consulte depois.
   - "pending": aguardando.
   - "failed": recusado. Mostre body.failure_reason de forma amigável e permita tentar com outro cartão (isso é NOVA compra: nova Idempotency-Key).
   Guarde também body.customer_id e body.card_id.
5. Erros:
   - 409 idempotency_in_progress / idempotency_outcome_unknown: NÃO crie outra cobrança, NÃO troque a chave. Status "uncertain".
   - 422 idempotency_key_conflict: bug nosso (mesma chave, corpo diferente). Não troque a chave; registre e investigue.
   - 422 merchant_not_accredited, card_expired, document_type_mismatch: mostre mensagem clara.
   - 400 installments_exceed_max: parcelas acima do permitido pela bandeira.
   - Timeout, rede ou 502: "uncertain". Se o usuário clicar de novo para a MESMA compra, reenvie com a MESMA chave e o MESMO corpo (inclusive o mesmo card_token). Para isso, guarde o corpo enviado (sem logar).

## pagouChargeStatus para cartão (GET /v1/creditcard/charges/{id})

Mapa: pending, authorized = "pending"; captured, settled = "paid"; canceled = "canceled"; failed = "failed"; reversed = "refunded"; charged_back = marcar para revisão manual do admin.
Cartão não tem webhook público: confirmação é pela resposta da criação e por consulta.

## Teste em sandbox

Cartão de teste para aprovação: 4111 1111 1111 1111, qualquer nome, validade futura, qualquer CVV, tokenizado com producao = false.

## Fora do escopo

Estorno, cancelamento, captura manual, retry e chargeback NÃO entram agora. Se precisar, me pergunte antes: são operações irreversíveis.

Ao terminar, me diga como testar uma aprovação e uma recusa.
```

---

## Prompt 4: reconciliação, painel admin e checklist

```text
Os três meios funcionam. Agora a camada que evita dinheiro perdido, mantendo as REGRAS PAGOU.

## Função pagouReconcile (só admin; e agendada a cada 15 minutos se o Base44 permitir automação agendada)

1. Para cada PagouCharge "uncertain" SEM pagou_id (Pix/boleto):
   - Liste GET /v1/pix (ou /v1/charges) com created_at_from = created_window_start menos 2 minutos e created_at_to = +10 minutos, formato UTC YYYY-MM-DDTHH:mm:ssZ (sem milissegundos), limit=100, offset=0 (offset é NÚMERO DA PÁGINA, começando em 0).
   - A listagem pode vir null: trate como lista vazia.
   - Encontre o registro com customer_code = order_id e mesmo valor. Achou: grave pagou_id e o status. Não achou depois de 1 hora: status "failed" com last_error_code = "not_found_after_uncertain". Só então o usuário pode gerar outro.
2. Para cada PagouCharge "uncertain" de cartão: consulte GET /v1/creditcard/charges?... pelo período ou, se tiver pagou_id, GET pelo id. Sem resolução: deixe para revisão manual.
3. Para cada PagouCharge "pending"/"active" com mais de 30 minutos: consulte pelo id e aplique o mapa de status (isso cobre webhook perdido).
4. Para cada PagouWebhookEvent com error = "charge_not_found": tente casar de novo.
5. Requisições espaçadas (máx. 5 por segundo). Em 429, respeite Retry-After.
6. Devolva um resumo: quantos resolvidos, quantos ainda pendentes.

## Painel admin "Pagamentos Pagou"

- Tabela de PagouCharge com filtros por status, método, ambiente e data. Destaque "uncertain" e "amount_mismatch" em vermelho.
- Botão "Reconciliar agora" (chama pagouReconcile).
- Botão "Consultar na Pagou" por linha (chama pagouChargeStatus).
- Lista dos últimos 100 PagouWebhookEvent (name, pagou_id, processed, error), sem mostrar o payload completo.
- Selo grande indicando SANDBOX ou PRODUÇÃO conforme PAGOU_ENV.

## Revisão final

Revise todo o código das funções Pagou e me confirme, item por item, com SIM/NÃO:
[ ] Nenhuma chave escrita no código; só Deno.env.get.
[ ] Nenhuma URL da Pagou fixa no código; só PAGOU_BASE_URL.
[ ] Frontend nunca chama a Pagou direto e nunca envia o valor da cobrança.
[ ] Webhook valida HMAC sobre timestamp + corpo bruto, janela de 5 min, comparação em tempo constante, antes do JSON.parse.
[ ] Webhook usa "name" (não "event_name") e responde exatamente 200.
[ ] Deduplicação por name + id + transaction_id; reenvio não paga duas vezes.
[ ] Nenhuma criação de Pix/boleto é repetida automaticamente.
[ ] Cartão: Idempotency-Key salva antes do envio e reusada só na mesma compra.
[ ] Pix/boleto em reais, cartão em centavos; nenhum float acumulado.
[ ] Nenhum log com cartão, CVV, token, chave ou payload completo.
[ ] Pedido só vira pago por webhook autenticado ou consulta com status de pago e valor conferido.
Qualquer NÃO: corrija e me mostre o que mudou.
```

---

## Ida para produção

1. Teste em sandbox: Pix simulado, boleto registrado + pago pelo Pix vinculado, cartão aprovado e recusado, webhook reenviado (não pode pagar duas vezes), webhook com assinatura errada (tem que dar 401).
2. Troque os três segredos (`PAGOU_API_KEY`, `PAGOU_BASE_URL=https://api.pagou.com.br`, `PAGOU_ENV=production`).
3. Faça **uma** compra real de valor baixo com cada meio e confirme no painel da Pagou.
4. Ao rotacionar a chave: cobranças antigas continuam assinadas com a chave antiga. Não troque a chave com cobranças em aberto sem planejar.

## Referências

- Documentação: https://docs.pagou.com.br
- Índice para agentes: https://docs.pagou.com.br/llms.txt
- Webhooks: https://docs.pagou.com.br/integracao-com-a-api/recebendo-webhooks.md
- Autenticação de webhooks: https://docs.pagou.com.br/integracao-com-a-api/autenticacao-de-webhooks.md
- Simulação em sandbox: https://docs.pagou.com.br/integracao-com-a-api/simulando-pagamentos-em-sandbox.md
