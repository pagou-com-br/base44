// Chamadas às backend functions da Pagou. O navegador nunca fala com a Pagou.
import { base44 } from "@/api/base44Client";

export async function invokePagou(name, payload = {}) {
  try {
    const res = await base44.functions.invoke(name, payload);
    return { ok: true, status: res?.status ?? 200, data: res?.data ?? {} };
  } catch (err) {
    const status = err?.response?.status ?? err?.status ?? 0;
    const data = err?.response?.data ?? err?.data ?? {};
    return { ok: false, status, data: typeof data === "object" && data ? data : {} };
  }
}

export function formatBRL(cents) {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export const STATUS_LABEL = {
  creating: "Gerando cobrança",
  uncertain: "Estamos confirmando seu pagamento",
  pending: "Aguardando pagamento",
  active: "Aguardando pagamento",
  paid: "Pagamento confirmado",
  partially_refunded: "Parcialmente estornado",
  refunded: "Estornado",
  canceled: "Cancelado",
  failed: "Não foi possível concluir",
  expired: "Expirado",
};

export const FINAL = ["paid", "partially_refunded", "refunded", "canceled", "failed"];

// Polling com intervalo fixo e prazo máximo; para sozinho em status final.
export function startPolling(chargeId, onUpdate, { intervalMs = 5000, maxMs = 10 * 60_000 } = {}) {
  const started = Date.now();
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    const res = await invokePagou("pagouChargeStatus", { charge_id: chargeId });
    if (stopped) return;
    if (res.ok) onUpdate(res.data);
    if ((res.ok && FINAL.includes(res.data.status)) || Date.now() - started > maxMs) return;
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function SandboxBadge({ environment }) {
  if (environment !== "sandbox") return null;
  return (
    <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
      MODO TESTE
    </span>
  );
}
