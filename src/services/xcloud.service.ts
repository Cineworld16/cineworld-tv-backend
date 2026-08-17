import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { detectDuration, type Duration } from '../lib/havok-plans.js';

/**
 * Ativação de TV no painel XCloud (xc.productgid.com).
 *
 * ⚠️ A CONTA É COMPARTILHADA com um colega do Mateus, que também opera clientes dela.
 * Por isso este serviço é DELIBERADAMENTE limitado a LEITURA + CRIAÇÃO:
 *
 *   - Só faz GET e POST. Não existe função de editar (PUT/PATCH) nem apagar (DELETE).
 *   - Toda chamada passa por `api()`, que bloqueia qualquer método fora de GET/POST.
 *   - Todo dispositivo criado leva `remark = CINERUSH:<id>` pra ser auditável e distinguível
 *     dos dele.
 *   - Nunca listamos a base dele (não há função de listagem geral).
 *
 * Não relaxar essas travas sem falar com o Mateus.
 */

/**
 * Base da API do PAINEL (criar dispositivo). Precisa da sessão do revendedor.
 * O painel (panel.xtream.cloud) é só o front; a API mora neste host.
 */
const API = 'https://xc.productgid.com/provider';

/**
 * API PÚBLICA de playlist (injetar a M3U). Host diferente e SEM autenticação:
 * é gated só pelo device_key (confirmado — device_key inválido responde 404, não 401).
 * Por isso o passo 2 não toca na conta compartilhada do colega.
 */
const API_PUBLIC = 'https://api.xtream.cloud/api';

/** Versão que o painel manda no login. Mantido igual ao tráfego real do navegador. */
const PMS_VERSION = '1.19.8';

/** Duração do plano → período no formato do XCloud. A TV expira junto com o acesso. */
const PERIODO_POR_DURACAO: Record<Duration, string> = {
  mensal: '1 month',
  trimestral: '3 months',
  semestral: '6 months',
  anual: '1 year',
};

/**
 * Deriva o período da ativação a partir do texto do plano do assinante
 * (ex.: "Plano Anual" → "1 year"). Cai no XCLOUD_PERIOD se não reconhecer —
 * então o env é só o FALLBACK, não o valor fixo.
 */
export function periodoDoPlano(planoTexto: string | null | undefined): string {
  const dur = planoTexto ? detectDuration(planoTexto) : null;
  return dur ? PERIODO_POR_DURACAO[dur] : env.XCLOUD_PERIOD;
}

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // religa a cada 6h por precaução

interface Session {
  token: string;
  startedAt: Date;
}

let session: Session | null = null;
let logando: Promise<Session> | null = null;

function sessaoExpirada(): boolean {
  if (!session) return true;
  return Date.now() - session.startedAt.getTime() > SESSION_TTL_MS;
}

export function invalidarSessao(motivo: string): void {
  if (session) {
    logger.info({ motivo }, 'sessao XCloud invalidada');
    session = null;
  }
}

/**
 * Faz login e guarda o token. Concorrência: se duas vendas caírem juntas, as duas
 * esperam o MESMO login em vez de abrir dois (evita derrubar a sessão do colega).
 */
async function login(): Promise<Session> {
  if (logando) return logando;

  logando = (async () => {
    logger.info('XCloud: fazendo login...');
    const res = await fetch(`${API}/provider/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // pms_version é enviado pelo painel; mandamos igual pra não destoar do tráfego normal
      body: JSON.stringify({
        email: env.XCLOUD_USER,
        password: env.XCLOUD_PASS,
        pms_version: PMS_VERSION,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const texto = await res.text();
    if (!res.ok) {
      throw new Error(`XCloud login ${res.status}: ${texto.slice(0, 200)}`);
    }

    // O painel guarda em cookie `xcloud_token`; a API devolve o token no corpo.
    let token: string | undefined;
    try {
      const j = JSON.parse(texto) as {
        token?: string;
        access_token?: string;
        data?: { token?: string };
      };
      token = j.token ?? j.access_token ?? j.data?.token;
    } catch {
      // corpo não-JSON — cai no cookie abaixo
    }
    if (!token) {
      const setCookie = res.headers.get('set-cookie') ?? '';
      token = /xcloud_token=([^;]+)/.exec(setCookie)?.[1];
    }
    if (!token) {
      throw new Error('XCloud: login sem token na resposta nem no cookie');
    }

    session = { token, startedAt: new Date() };
    logger.info('XCloud: sessao iniciada');
    return session;
  })();

  try {
    return await logando;
  } finally {
    logando = null;
  }
}

async function getSessao(): Promise<Session> {
  if (!session || sessaoExpirada()) {
    invalidarSessao('expirada');
    return login();
  }
  return session;
}

/**
 * Chamada autenticada com religação automática.
 * Se o colega logar e derrubar nossa sessão (o painel faz isso), o 401 dispara
 * um login novo e a chamada é refeita UMA vez.
 */
async function api(
  metodo: 'GET' | 'POST',
  path: string,
  body?: unknown,
  jaTentou = false,
): Promise<{ status: number; data: unknown }> {
  // trava dura: nada de editar/apagar na conta de outra pessoa
  if (metodo !== 'GET' && metodo !== 'POST') {
    throw new Error(`XCloud: metodo ${String(metodo)} bloqueado por seguranca`);
  }

  const { token } = await getSessao();
  const res = await fetch(`${API}${path}`, {
    method: metodo,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      cookie: `xcloud_token=${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if ((res.status === 401 || res.status === 403) && !jaTentou) {
    invalidarSessao(`http ${res.status}`);
    return api(metodo, path, body, true);
  }

  let data: unknown = null;
  const texto = await res.text();
  try {
    data = JSON.parse(texto);
  } catch {
    data = texto;
  }
  return { status: res.status, data };
}

export interface DeviceInfo {
  existe: boolean;
  plataforma?: string;
  jaAtivo?: boolean;
}

/**
 * Confere se a chave que o cliente digitou existe de verdade.
 * É o que permite responder "código inválido, confere na TV" antes de gastar crédito.
 * 404 = não existe. 200 = existe.
 */
export async function validarDeviceKey(deviceKey: string): Promise<DeviceInfo> {
  const chave = deviceKey.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(chave)) return { existe: false };

  const { status, data } = await api(
    'GET',
    `/provider_devices/get_device?device_key=${encodeURIComponent(chave)}`,
  );
  if (status === 404) return { existe: false };
  if (status !== 200) {
    throw new Error(`XCloud get_device ${status}`);
  }

  const d = (data ?? {}) as {
    platform?: string;
    status?: string;
    data?: { platform?: string; status?: string };
  };
  const info = d.data ?? d;
  return {
    existe: true,
    plataforma: info.platform,
    jaAtivo: info.status === 'active' || info.status === 'Active',
  };
}

export interface AtivarInput {
  deviceKey: string;
  /** M3U completa do assinante — gerada do Havok, aponta pro NOSSO servidor. */
  playlistUrl: string;
  /** id do assinante, pra rastreabilidade nos logs. */
  subscriberId: string;
  /** texto do plano comprado (ex.: "Plano Anual") — define quanto a TV fica ativa. */
  plano?: string | null;
}

export interface AtivarResult {
  ok: true;
  deviceKey: string;
  expiraEm?: string;
}

/**
 * Calcula a data de expiração a partir de XCLOUD_PERIOD.
 * O painel manda ISO no corpo (o "1 month" da tela é só rótulo), então convertemos aqui.
 */
export function calcularExpiracao(periodo: string, agora = new Date()): string {
  const m = /^(\d+)\s*(day|days|dia|dias|month|months|mes|meses|year|years|ano|anos)$/i.exec(
    periodo.trim(),
  );
  const d = new Date(agora);
  if (!m) {
    d.setMonth(d.getMonth() + 1); // fallback seguro: 1 mês
    return d.toISOString();
  }
  const n = Number(m[1]);
  const unidade = m[2].toLowerCase();
  if (/^(day|days|dia|dias)$/.test(unidade)) d.setDate(d.getDate() + n);
  else if (/^(year|years|ano|anos)$/.test(unidade)) d.setFullYear(d.getFullYear() + n);
  else d.setMonth(d.getMonth() + n);
  return d.toISOString();
}

/**
 * PASSO 1 de 2 — cria o dispositivo.
 *
 * Formato CONFIRMADO por captura real do painel (2026-07-20), resposta `"Success"`:
 *   POST /provider_devices/add_device
 *   {device_key, activation_type, uses_own_playlist, auto_renew, expired_date}
 *
 * `uses_own_playlist: true` porque a playlist é NOSSA e não está na lista de DNS da
 * conta — ela é injetada no passo 2 (ver `injetarPlaylist`). É o fluxo do tutorial oficial.
 */
export async function criarDispositivo(
  deviceKey: string,
  periodo: string = env.XCLOUD_PERIOD,
): Promise<{ expiraEm: string }> {
  const chave = deviceKey.trim().toUpperCase();
  const expiraEm = calcularExpiracao(periodo);

  const corpo = {
    device_key: chave,
    activation_type: 'active', // ativa na hora (o outro valor é 'free_trial')
    uses_own_playlist: true, // nós fornecemos a M3U no passo 2
    auto_renew: false,
    expired_date: expiraEm, // ISO — casa com a duração do plano comprado
  };

  logger.info({ deviceKey: chave, periodo, expiraEm }, 'XCloud: criando dispositivo');
  const { status, data } = await api('POST', '/provider_devices/add_device', corpo);

  if (status !== 200 && status !== 201) {
    logger.warn(
      { status, resposta: JSON.stringify(data).slice(0, 400), enviado: corpo },
      'XCloud: criacao recusada',
    );
    throw new Error(`XCloud add_device ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  }

  logger.info({ deviceKey: chave }, 'XCloud: dispositivo criado');
  return { expiraEm };
}

/**
 * PASSO 2 de 2 — injeta a M3U do assinante no dispositivo.
 *
 * Formato CONFIRMADO por captura real (2026-07-24), resposta `"Playlist added successfully"`:
 *   PUT https://api.xtream.cloud/api/device/add_playlist
 *   {device_key, playlist}
 *
 * É PÚBLICO (sem auth) — não usa a sessão do painel. device_key inválido → 404
 * "Device not found". A playlist tem que ser uma URL Xtream com get.php + user + pass.
 */
export async function injetarPlaylist(deviceKey: string, playlistUrl: string): Promise<void> {
  const chave = deviceKey.trim().toUpperCase();

  logger.info({ deviceKey: chave }, 'XCloud: injetando playlist');
  const res = await fetch(`${API_PUBLIC}/device/add_playlist`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ device_key: chave, playlist: playlistUrl }),
    signal: AbortSignal.timeout(30_000),
  });

  const texto = await res.text();
  if (!res.ok) {
    logger.warn({ deviceKey: chave, status: res.status, resposta: texto.slice(0, 200) },
      'XCloud: injecao de playlist recusada');
    throw new Error(`XCloud add_playlist ${res.status}: ${texto.slice(0, 150)}`);
  }
  logger.info({ deviceKey: chave }, 'XCloud: playlist injetada');
}

/**
 * Exclui um device no XCloud (revogação de cancelado/reembolsado).
 *
 * ⚠️ ENDPOINT AINDA NÃO CAPTURADO. Como a conta é COMPARTILHADA com o colega,
 * só apagamos device_key que está no NOSSO banco (nunca os dele). Assim que a
 * chamada de exclusão for capturada no painel, preencher aqui. Enquanto isso,
 * lança erro — o revoke.service trata (loga e deixa pendente pra revisão manual).
 */
export async function deleteXcloudDevice(deviceKey: string): Promise<void> {
  void deviceKey;
  throw new Error('XCloud delete ainda nao implementado (falta capturar o endpoint no painel)');
}

/** Executa os dois passos: cria o aparelho e aponta pra playlist do assinante. */
export async function ativarDispositivo(input: AtivarInput): Promise<AtivarResult> {
  const chave = input.deviceKey.trim().toUpperCase();
  const periodo = periodoDoPlano(input.plano); // a TV expira junto com o plano comprado
  const { expiraEm } = await criarDispositivo(chave, periodo);
  await injetarPlaylist(chave, input.playlistUrl);
  logger.info(
    { deviceKey: chave, subscriberId: input.subscriberId, plano: input.plano, periodo },
    'XCloud: TV ativada',
  );
  return { ok: true, deviceKey: chave, expiraEm };
}

/** Monta a M3U padrão Xtream Codes a partir da credencial do Havok. */
export function montarPlaylistUrl(usuario: string, senha: string): string {
  const base = env.ACCESS_URL.replace(/\/+$/, '');
  return `${base}/get.php?username=${encodeURIComponent(usuario)}&password=${encodeURIComponent(
    senha,
  )}&type=m3u_plus&output=mpegts`;
}

/** status pra /health/xcloud */
export function getXcloudStatus() {
  return {
    enabled: env.XCLOUD_ENABLED,
    sessao: session && !sessaoExpirada() ? 'ativa' : 'inativa',
    startedAt: session?.startedAt.toISOString() ?? null,
    periodo: env.XCLOUD_PERIOD,
    somenteCriacao: true, // este serviço nunca edita nem apaga
  };
}
