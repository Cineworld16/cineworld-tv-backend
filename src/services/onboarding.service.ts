import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../config/supabase.js';
import {
  DEVICE_LABELS,
  DEVICE_MENU,
  ONBOARDING,
  type Device,
  type OnboardingStep,
} from '../content/onboarding.js';
import { getCredentials, getSubscriber } from './subscribers.service.js';
import type {
  ButtonPayload,
  OnboardingAction,
  OnboardingStateRow,
  OutgoingMessage,
  ReplyButton,
} from '../types/onboarding.js';

const DEVICES = Object.keys(DEVICE_LABELS) as Device[];

// ── Payload dos botões: ob:<device>:<step>:<action> ────────────────────────
export function encodeButton(p: ButtonPayload): string {
  return `ob:${p.device}:${p.step}:${p.action}`;
}

export function parseButton(id: string): ButtonPayload | null {
  const m = /^ob:([a-z_]+|global):(\d+):([a-z]+)$/.exec(id.trim());
  if (!m) return null;
  const [, device, step, action] = m;
  const validAction: OnboardingAction[] = ['choose', 'next', 'back', 'done', 'handoff', 'restart'];
  if (!validAction.includes(action as OnboardingAction)) return null;
  if (device !== 'global' && !DEVICES.includes(device as Device)) return null;
  return {
    device: device as ButtonPayload['device'],
    step: Number.parseInt(step, 10),
    action: action as OnboardingAction,
  };
}

// ── Render de conteúdo ─────────────────────────────────────────────────────
function fill(text: string): string {
  return text.replaceAll('{{access_url}}', env.ACCESS_URL);
}

const HANDOFF_LABEL = 'Falar c/ atendente 👤';

/** Gera os botões do passo respeitando o limite de 3 do WhatsApp. */
function stepButtons(device: Device, stepIdx: number, total: number): ReplyButton[] {
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === total - 1;
  const btns: ReplyButton[] = [];

  if (!isFirst) {
    btns.push({ id: encodeButton({ device, step: stepIdx, action: 'back' }), label: '⬅️ Voltar' });
  }
  if (isLast) {
    btns.push({ id: encodeButton({ device, step: stepIdx, action: 'done' }), label: '✅ Deu certo' });
  } else {
    btns.push({ id: encodeButton({ device, step: stepIdx, action: 'next' }), label: 'Próximo ➡️' });
  }
  // atendente sempre disponível, mas só cabe se ainda houver espaço (máx 3)
  if (btns.length < 3) {
    btns.push({ id: encodeButton({ device, step: stepIdx, action: 'handoff' }), label: HANDOFF_LABEL });
  }
  return btns;
}

function renderStep(device: Device, stepIdx: number): OutgoingMessage {
  const steps = ONBOARDING[device];
  const step = steps[stepIdx] as OnboardingStep | undefined;
  if (!step) {
    // fora do range → trata como conclusão defensiva
    return completedMessage();
  }
  const total = steps.length;
  const linkLine = step.link ? `\n\n🔗 ${fill(step.link)}` : '';
  const header = `*Passo ${stepIdx + 1} de ${total}*\n\n`;
  return {
    kind: 'buttons',
    text: header + fill(step.text) + linkLine,
    buttons: stepButtons(device, stepIdx, total),
  };
}

interface WelcomeVars {
  nome?: string | null;
  usuario?: string | null;
  senha?: string | null;
}

/**
 * Mensagem inicial: credenciais (se disponíveis) + pergunta do dispositivo
 * como LISTA (menu). WhatsApp só permite 3 reply buttons, então 5 opções +
 * suporte vão numa list (até 10 linhas).
 */
export function deviceListMessage(vars: WelcomeVars = {}): OutgoingMessage {
  const nome = vars.nome ? vars.nome.split(/\s+/)[0] : null;
  const saudacao = nome ? `Olá, ${nome}! 👋` : 'Olá! 👋';

  const credsBlock =
    vars.usuario && vars.senha
      ? `\n\nSeu acesso ao *CineRush TV*:\n👤 *Usuário:* ${vars.usuario}\n🔑 *Senha:* ${vars.senha}`
      : '';

  const rows = DEVICE_MENU.map((d) => ({
    id: encodeButton({ device: d, step: 0, action: 'choose' }),
    title: DEVICE_LABELS[d].label,
    description: DEVICE_LABELS[d].description,
  }));
  // opção fixa de suporte humano no fim do menu
  rows.push({
    id: encodeButton({ device: 'global', step: 0, action: 'handoff' }),
    title: 'Falar com atendente 👤',
    description: 'Prefiro que alguém me ajude',
  });

  return {
    kind: 'list',
    text:
      `${saudacao}${credsBlock}\n\n` +
      `Bora deixar tudo pronto? 🍿\n` +
      `Em qual aparelho você vai assistir?`,
    buttonLabel: 'Escolher aparelho',
    sections: [{ title: 'Onde vai assistir?', rows }],
  };
}

function completedMessage(): OutgoingMessage {
  return {
    kind: 'buttons',
    text:
      '🎉 Prontinho! Tá tudo configurado. Bom filme! 🍿\n\n' +
      'Qualquer coisa, é só chamar aqui.',
    buttons: [
      { id: encodeButton({ device: 'global', step: 0, action: 'handoff' }), label: HANDOFF_LABEL },
    ],
  };
}

function handoffMessage(): OutgoingMessage {
  return {
    kind: 'text',
    text: 'Beleza! 👤 Já chamei um atendente pra te ajudar. É só aguardar aqui que já te respondem.',
  };
}

function alreadyCompletedMessage(): OutgoingMessage {
  return {
    kind: 'buttons',
    text: 'Seu acesso já está configurado por aqui. 😉 Precisa de ajuda com outra coisa?',
    buttons: [
      { id: encodeButton({ device: 'global', step: 0, action: 'restart' }), label: '🔄 Refazer setup' },
      { id: encodeButton({ device: 'global', step: 0, action: 'handoff' }), label: HANDOFF_LABEL },
    ],
  };
}

// ── Estado (Supabase) ──────────────────────────────────────────────────────
async function loadState(waId: string): Promise<OnboardingStateRow | null> {
  const { data, error } = await supabaseAdmin
    .from('onboarding_state')
    .select('*')
    .eq('wa_id', waId)
    .maybeSingle();
  if (error) {
    logger.error({ err: error.message, waId }, 'onboarding: loadState falhou');
    return null;
  }
  return (data as OnboardingStateRow | null) ?? null;
}

async function patchState(waId: string, patch: Partial<OnboardingStateRow>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('onboarding_state')
    .update({ ...patch, last_interaction_at: new Date().toISOString() })
    .eq('wa_id', waId);
  if (error) logger.error({ err: error.message, waId }, 'onboarding: patchState falhou');
}

/**
 * Inicia (ou reabre) o onboarding para um wa_id.
 * Idempotente: se já existe registro `completed`, NÃO reinicia — retorna null
 * (o disparo pós-email não deve reenviar o fluxo).
 */
/** Busca nome + credenciais do assinante pra montar a mensagem de boas-vindas. */
async function welcomeVarsFor(subscriberId: string | null): Promise<WelcomeVars> {
  if (!subscriberId) return {};
  try {
    const sub = await getSubscriber(subscriberId);
    const vars: WelcomeVars = { nome: sub.nome };
    if (sub.senha_preenchida) {
      const creds = await getCredentials(subscriberId);
      vars.usuario = creds.usuario;
      vars.senha = creds.senha;
    }
    return vars;
  } catch (err) {
    logger.warn(
      { subscriberId, err: err instanceof Error ? err.message : String(err) },
      'onboarding: nao consegui carregar credenciais p/ welcome',
    );
    return {};
  }
}

export async function startOnboarding(
  waId: string,
  subscriberId: string | null,
): Promise<OutgoingMessage | null> {
  const existing = await loadState(waId);
  if (existing?.status === 'completed') {
    logger.info({ waId }, 'onboarding: ja completed, nao reinicia');
    return null;
  }

  const resolvedSubId = subscriberId ?? existing?.subscriber_id ?? null;

  if (existing) {
    await patchState(waId, {
      subscriber_id: resolvedSubId,
      status: 'choosing_device',
      device: null,
      current_step: 0,
    });
  } else {
    const { error } = await supabaseAdmin.from('onboarding_state').insert({
      wa_id: waId,
      subscriber_id: subscriberId,
      status: 'choosing_device',
      current_step: 0,
    });
    if (error) {
      logger.error({ err: error.message, waId }, 'onboarding: insert state falhou');
      return null;
    }
  }

  const vars = await welcomeVarsFor(resolvedSubId);
  return deviceListMessage(vars);
}

export interface HandoffSignal {
  waId: string;
  subscriberId: string | null;
  device: Device | null;
  step: number;
}

/**
 * Roteia um clique de botão. Retorna a próxima mensagem (ou null se nada a enviar).
 * Idempotente: clique de step diferente do current_step reenvia o passo correto,
 * sem avançar duas vezes.
 */
export async function handleButtonClick(
  waId: string,
  buttonId: string,
  onHandoff?: (s: HandoffSignal) => void | Promise<void>,
): Promise<OutgoingMessage | null> {
  const payload = parseButton(buttonId);
  if (!payload) {
    logger.warn({ waId, buttonId }, 'onboarding: button id invalido');
    return null;
  }

  const state = await loadState(waId);
  if (!state) {
    // clicou sem estado (ex: fluxo expirou/nunca começou) → recomeça a seleção
    await startOnboarding(waId, null);
    return deviceListMessage();
  }

  // dedup de clique idêntico repetido (mesmo botão em sequência)
  if (state.last_button_id === buttonId && payload.action !== 'handoff') {
    logger.info({ waId, buttonId }, 'onboarding: clique duplicado ignorado');
    return null;
  }
  await patchState(waId, { last_button_id: buttonId });

  // handoff funciona em QUALQUER etapa
  if (payload.action === 'handoff') {
    await patchState(waId, { status: 'handoff' });
    if (onHandoff) {
      await onHandoff({
        waId,
        subscriberId: state.subscriber_id,
        device: state.device,
        step: state.current_step,
      });
    }
    return handoffMessage();
  }

  // já concluído → não reinicia sozinho (só via restart explícito)
  if (state.status === 'completed' && payload.action !== 'restart') {
    return alreadyCompletedMessage();
  }

  if (payload.action === 'restart') {
    await patchState(waId, { status: 'choosing_device', device: null, current_step: 0 });
    const vars = await welcomeVarsFor(state.subscriber_id);
    return deviceListMessage(vars);
  }

  if (payload.action === 'choose') {
    const device = payload.device;
    if (device === 'global') return deviceListMessage();
    await patchState(waId, { device, status: 'in_progress', current_step: 0 });
    return renderStep(device, 0);
  }

  // ── next / back / done — exigem device escolhido ──
  const device = state.device;
  if (!device) {
    return deviceListMessage();
  }

  // IDEMPOTÊNCIA: o botão carrega o step em que foi renderizado. Se não bate com
  // o current_step do banco, é clique fora de ordem/atrasado → reenvia o passo
  // correto SEM avançar.
  if (payload.step !== state.current_step) {
    logger.info(
      { waId, payloadStep: payload.step, dbStep: state.current_step },
      'onboarding: clique fora de ordem, reenviando passo atual',
    );
    return renderStep(device, state.current_step);
  }

  const steps = ONBOARDING[device];
  const lastIdx = steps.length - 1;

  if (payload.action === 'done') {
    await patchState(waId, { status: 'completed' });
    return completedMessage();
  }

  if (payload.action === 'next') {
    const nextIdx = state.current_step + 1;
    if (nextIdx > lastIdx) {
      await patchState(waId, { status: 'completed' });
      return completedMessage();
    }
    await patchState(waId, { current_step: nextIdx });
    return renderStep(device, nextIdx);
  }

  if (payload.action === 'back') {
    const prevIdx = Math.max(0, state.current_step - 1);
    await patchState(waId, { current_step: prevIdx });
    return renderStep(device, prevIdx);
  }

  return null;
}
