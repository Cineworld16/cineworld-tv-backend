export type SubscriberStatus =
  | 'pendente'
  | 'credenciais_preenchidas'
  | 'email_enviado'
  | 'cancelado'
  | 'reembolsado';

export interface OrderBump {
  id?: string;
  name?: string;
  offer_id?: string;
  price?: string | number;
}

export interface SubscriberPublic {
  id: string;
  nome: string;
  email: string;
  telefone: string | null;
  plano: string;
  order_bumps: OrderBump[];
  offer_id: string | null;
  product_id: string | null;
  transacao_kirvano_id: string;
  sale_type: 'ONE_TIME' | 'RECURRING' | null;
  payment_method: string | null;
  plan_recurrence: string | null;
  next_charge_date: string | null;
  valor_total: number | null;
  valor_total_raw: string | null;
  data_compra: string;
  status: SubscriberStatus;
  usuario: string | null;
  senha_preenchida: boolean;
  onboard_token: string | null;
  config_url: string | null; // link pronto do site de config (tutorial) pra mandar pro cliente
  data_envio_email: string | null;
  email_send_attempts: number;
  email_error_last: string | null;
  email_scheduled_at: string | null;
  email_retry_count: number;
  refunded_at: string | null;
  canceled_at: string | null;
  access_revoked_at: string | null;
  created_at: string;
  updated_at: string;
}
