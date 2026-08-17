/**
 * Formato do payload da Kirvano (documentado + observado).
 * Tudo opcional exceto `event` — a doc muda com o tempo, então tratamos defensivamente.
 */

export type KirvanoEvent =
  | 'SALE_APPROVED'
  | 'SALE_REFUSED'
  | 'SALE_REFUNDED'
  | 'SALE_CHARGEBACK'
  | 'SUBSCRIPTION_CANCELED'
  | 'PIX_GENERATED'
  | 'PIX_EXPIRED'
  | 'BANK_SLIP_GENERATED'
  | 'BANK_SLIP_EXPIRED'
  | (string & {});

export interface KirvanoCustomer {
  name?: string;
  document?: string;
  email?: string;
  phone_number?: string;
}

export interface KirvanoProduct {
  id?: string;
  name?: string;
  offer_id?: string;
  price?: string | number;
  photo?: string;
  is_order_bump?: boolean;
}

export interface KirvanoPlan {
  name?: string;
  charge_frequency?: string;
  /** 1 = primeira compra; 2,3… = renovações da assinatura recorrente. */
  charge_number?: number;
  next_charge_date?: string;
}

export interface KirvanoPayment {
  method?: string;
  brand?: string;
  installments?: number;
  finished_at?: string;
}

export interface KirvanoUtm {
  src?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
}

export interface KirvanoFiscal {
  net_value?: number;
  commission?: number;
  total_commissions?: number;
  affiliate_commission?: number;
  coproduction_commission?: number;
}

export interface KirvanoWebhookPayload {
  event: KirvanoEvent;
  sale_id?: string;
  checkout_id?: string;
  payment_method?: string;
  total_price?: string;
  type?: 'ONE_TIME' | 'RECURRING' | string;
  status?: string;
  created_at?: string;
  customer?: KirvanoCustomer;
  payment?: KirvanoPayment;
  products?: KirvanoProduct[];
  plan?: KirvanoPlan;
  utm?: KirvanoUtm;
  // Afiliados (a Kirvano manda no payload real, mesmo sem constar na doc).
  affiliateEmail?: string;
  affiliateCommission?: number;
  coproductionCommission?: number;
  commission?: number;
  fiscal?: KirvanoFiscal;
}
