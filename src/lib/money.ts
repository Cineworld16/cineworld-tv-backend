/**
 * Kirvano envia total_price como string "R$ 169,80".
 * Faz parse defensivo — retorna null se não conseguir.
 */
export function parseBRL(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');

  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
