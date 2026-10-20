import { useEffect, useRef, useState } from "react";
import { Check, CreditCard, Loader2 } from "lucide-react";
import { STATUS_LABEL, SandboxBadge, formatBRL, invokePagou, startPolling } from "./pagouClient";

// Checkout de cartão com tokenização no navegador.
// https://docs.pagou.com.br/integracao-com-a-api/meio-de-pagamento-cartao-de-credito/tokenizando-um-cartao.md
// Número e CVV nunca saem do navegador em texto aberto e são apagados logo
// depois da tokenização. Só o objeto { card_token, holder, expires_at } fica
// em memória, para repetir a MESMA tentativa se a resposta vier incerta.

const SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/node-forge@1.0.0/dist/forge.min.js",
  "https://js.cel.cash/checkout-v2.min.js",
];
const TOKEN_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const libraries = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.referrerPolicy = "no-referrer";
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("script"));
    document.head.appendChild(el);
  });
}

async function getLibrary(production) {
  for (const src of SCRIPTS) await loadScript(src); // em ordem: forge antes do checkout
  if (typeof window.forge !== "object" || typeof window.BaasCard !== "function") {
    throw new Error("Biblioteca de pagamento indisponível.");
  }
  if (!libraries.has(production)) {
    const init = (async () => {
      const lib = new window.BaasCard(production);
      await lib._setPublicKey();
      if (typeof lib._publicKey !== "string" || lib._publicKey.length < 100) throw new Error("Biblioteca de pagamento indisponível.");
      return lib;
    })().catch((err) => {
      libraries.delete(production);
      throw err;
    });
    libraries.set(production, init);
  }
  return libraries.get(production);
}

async function tokenize(form, production) {
  const lib = await getLibrary(production);
  try {
    const card = lib.newCard({
      number: form.number.replace(/\D/g, ""),
      holder: form.holder,
      expiresAt: form.expiresAt,
      cvv: form.cvv,
    });
    card.validate();
    const token = card.encrypt(lib._publicKey);
    if (typeof token !== "string" || token.length < 64 || token.length > 16384 || !TOKEN_PATTERN.test(token)) {
      throw new Error("token");
    }
    return { card_token: token, holder: form.holder, expires_at: form.expiresAt };
  } catch {
    throw new Error("Confira os dados do cartão e tente novamente.");
  }
}

const EMPTY = { number: "", holder: "", month: "", year: "", cvv: "" };

export default function PagouCardForm({ orderId, amountCents, maxInstallments = 12, onPaid }) {
  const [form, setForm] = useState(EMPTY);
  const [installments, setInstallments] = useState(1);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [charge, setCharge] = useState(null);
  const attempt = useRef(null); // { key, card } da tentativa em curso

  useEffect(() => {
    invokePagou("pagouConfig").then((res) => {
      if (!res.ok) return setError("Pagamento com cartão indisponível no momento.");
      setConfig(res.data);
      getLibrary(res.data.production).catch(() => {}); // pré-carrega
    });
  }, []);

  useEffect(() => {
    if (!charge?.charge_id || charge.status !== "pending") return undefined;
    return startPolling(charge.charge_id, (c) => {
      setCharge(c);
      if (c.status === "paid") onPaid?.(c);
    });
  }, [charge?.charge_id, charge?.status]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function send() {
    const res = await invokePagou("pagouCreateCardCharge", {
      order_id: orderId,
      idempotency_key: attempt.current.key,
      installments,
      card: attempt.current.card,
    });
    if (res.data.charge_id) setCharge(res.data);
    if (res.data.status === "paid") {
      attempt.current = null;
      onPaid?.(res.data);
    } else if (res.data.status === "failed") {
      attempt.current = null; // nova tentativa = nova chave
      setError(res.data.failure_message || res.data.message || "Pagamento recusado.");
    } else if (res.data.status !== "uncertain" && !res.ok) {
      setError(res.data.message || "Não foi possível processar o pagamento.");
      if (res.status !== 409) attempt.current = null;
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (busy || !config) return;
    setBusy(true);
    setError("");
    try {
      if (!attempt.current) {
        const card = await tokenize(
          { number: form.number, holder: form.holder.trim(), expiresAt: `${form.year}-${form.month.padStart(2, "0")}`, cvv: form.cvv },
          config.production,
        );
        attempt.current = { key: crypto.randomUUID(), card };
        setForm((f) => ({ ...f, number: "", cvv: "" })); // apaga dados sensíveis
      }
      await send();
    } catch (err) {
      setError(err.message || "Não foi possível processar o pagamento.");
    } finally {
      setBusy(false);
    }
  }

  if (charge?.status === "paid") {
    return (
      <div className="mx-auto flex w-full max-w-md items-center gap-2 rounded-xl bg-green-50 p-4 text-green-800">
        <Check className="h-5 w-5" /> Pagamento confirmado.
      </div>
    );
  }

  const uncertain = charge?.status === "uncertain" && attempt.current;
  const years = Array.from({ length: 12 }, (_, i) => String(new Date().getFullYear() + i));

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-md space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{formatBRL(amountCents)}</p>
        {config && <SandboxBadge environment={config.environment} />}
      </div>

      {uncertain ? (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          Não recebemos a confirmação do pagamento. Toque em "Confirmar pagamento" para verificar sem cobrar de novo.
        </p>
      ) : (
        <>
          <input
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="Número do cartão"
            value={form.number}
            onChange={set("number")}
            className="w-full rounded-lg border border-gray-300 px-3 py-3"
            required
          />
          <input
            autoComplete="cc-name"
            placeholder="Nome impresso no cartão"
            value={form.holder}
            onChange={set("holder")}
            className="w-full rounded-lg border border-gray-300 px-3 py-3"
            required
          />
          <div className="grid grid-cols-3 gap-2">
            <select value={form.month} onChange={set("month")} className="rounded-lg border border-gray-300 px-2 py-3" required>
              <option value="">Mês</option>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select value={form.year} onChange={set("year")} className="rounded-lg border border-gray-300 px-2 py-3" required>
              <option value="">Ano</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <input
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder="CVV"
              value={form.cvv}
              onChange={set("cvv")}
              className="rounded-lg border border-gray-300 px-3 py-3"
              required
            />
          </div>
          <select
            value={installments}
            onChange={(e) => setInstallments(Number(e.target.value))}
            className="w-full rounded-lg border border-gray-300 px-3 py-3"
          >
            {Array.from({ length: maxInstallments }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}x de {formatBRL(Math.ceil(amountCents / n))}
              </option>
            ))}
          </select>
        </>
      )}

      {charge?.status === "pending" && <p className="text-sm text-gray-600">{STATUS_LABEL.pending}...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={busy || !config}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-3 font-medium text-white disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
        {uncertain ? "Confirmar pagamento" : "Pagar"}
      </button>
      {config?.environment === "sandbox" && (
        <p className="text-center text-xs text-gray-400">Teste: 4111 1111 1111 1111, validade futura, qualquer CVV.</p>
      )}
    </form>
  );
}
