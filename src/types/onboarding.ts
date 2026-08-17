import type { Device } from '../content/onboarding.js';

export type OnboardingStatus =
  | 'started'
  | 'choosing_device'
  | 'in_progress'
  | 'completed'
  | 'handoff';

export type OnboardingAction =
  | 'choose' // escolher dispositivo
  | 'next'
  | 'back'
  | 'done' // conclui (último passo)
  | 'handoff' // chamar atendente
  | 'restart'; // trocar dispositivo / recomeçar

export interface OnboardingStateRow {
  id: string;
  wa_id: string;
  subscriber_id: string | null;
  device: Device | null;
  current_step: number;
  status: OnboardingStatus;
  last_button_id: string | null;
  last_interaction_at: string;
  created_at: string;
  updated_at: string;
}

/** ID estruturado carregado em cada botão: ob:<device>:<step>:<action> */
export interface ButtonPayload {
  device: Device | 'global';
  step: number;
  action: OnboardingAction;
}

/** Botão de resposta (WhatsApp reply button) */
export interface ReplyButton {
  id: string; // ButtonPayload serializado
  label: string; // ≤ 20 chars (limite WhatsApp)
}

/** Linha de LIST message */
export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/** Mensagem de saída — representação device-agnostic que o adaptador renderiza. */
export type OutgoingMessage =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: ReplyButton[] }
  | {
      kind: 'list';
      text: string;
      buttonLabel: string;
      sections: { title: string; rows: ListRow[] }[];
    };
