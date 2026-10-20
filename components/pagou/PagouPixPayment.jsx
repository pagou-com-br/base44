import { useEffect, useState } from "react";
import { Check, Copy, Loader2, QrCode } from "lucide-react";
import { STATUS_LABEL, SandboxBadge, formatBRL, invokePagou, startPolling } from "./pagouClient";

// Tela de pagamento Pix. Props: orderId, isAdmin (mostra o simulador em Sandbox), onPaid.
export default function PagouPixPayment({ orderId, isAdmin = false, onPaid }) {
  const [charge, setCharge] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [simMsg, setSimMsg] = useState("");

  async function generate() {
    setLoading(true);
    setError("");
    const res = await invokePagou("pagouCreatePix", { order_id: orderId });
    setLoading(false);
    if (res.data.charge_id) setCharge(res.data);
    if (!res.ok) setError(res.data.message || "Não foi possível gerar o Pix.");
  }

  useEffect(() => {
    if (!charge?.charge_id) return undefined;
    if (charge.status === "paid") {
      onPaid?.(charge);
      return undefined;
    }
    return startPolling(charge.charge_id, (c) => {
      setCharge(c);
      if (c.status === "paid") onPaid?.(c);
    });
  }, [charge?.charge_id, charge?.status === "paid"]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(charge.pix_copy_paste);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Não foi possível copiar. Selecione o código manualmente.");
    }
  }

  async function simulate() {
    setSimMsg("Enviando simulação...");
    const res = await invokePagou("pagouSimulate", { charge_id: charge.charge_id });
    setSimMsg(res.data.message || (res.ok ? "Simulação aceita." : "Simulação recusada."));
  }

  const expiresAt = charge?.pix_expires_at ? new Date(charge.pix_expires_at).getTime() : 0;
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const expired = expiresAt > 0 && remaining === 0 && charge?.status !== "paid";

  if (!charge) {
    return (
      <div className="mx-auto w-full max-w-md space-y-3 p-4">
        <button
          onClick={generate}
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-3 font-medium text-white disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
          Pagar com Pix
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{formatBRL(charge.amount_cents)}</p>
        <SandboxBadge environment={charge.environment} />
      </div>

      <p className="text-base font-semibold">{expired ? "Pix expirado" : STATUS_LABEL[charge.status]}</p>

      {charge.status === "paid" && (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-800">
          <Check className="h-5 w-5" /> Recebemos seu pagamento.
        </div>
      )}

      {charge.status === "uncertain" && (
        <p className="text-sm text-gray-600">Aguarde alguns instantes. Não gere outro Pix para este pedido.</p>
      )}

      {charge.status === "active" && !expired && (
        <>
          {charge.pix_qr_base64 && (
            <img
              src={`data:image/png;base64,${charge.pix_qr_base64}`}
              alt="QR Code Pix"
              className="mx-auto h-56 w-56"
            />
          )}
          <div className="space-y-2">
            <p className="break-all rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-700">{charge.pix_copy_paste}</p>
            <button
              onClick={copy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-3 font-medium text-white"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Código copiado" : "Copiar código Pix"}
            </button>
          </div>
          <p className="text-center text-xs text-gray-500">
            Expira em {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
          </p>
        </>
      )}

      {charge.status === "failed" && <p className="text-sm text-red-600">{charge.failure_message || error}</p>}
      {error && charge.status !== "failed" && <p className="text-sm text-red-600">{error}</p>}

      {isAdmin && charge.environment === "sandbox" && charge.status === "active" && (
        <div className="border-t border-dashed border-gray-200 pt-3">
          <button onClick={simulate} className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm">
            Simular pagamento (teste)
          </button>
          {simMsg && <p className="mt-2 text-xs text-gray-500">{simMsg}</p>}
        </div>
      )}
    </div>
  );
}
