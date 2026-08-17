import { chromium, type Browser, type Page } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Disfarce contra o bot-detection do Cloudflare — roda ANTES de qualquer script da página.
// String (não função) pra não depender da lib DOM no tsconfig. Só mascara sinais de
// automação; é aditivo, não altera o comportamento da página.
const STEALTH_JS = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [
    { name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' },
    { name: 'Microsoft Edge PDF Viewer' }, { name: 'WebKit built-in PDF' }
  ] });
  Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  try {
    const _q = navigator.permissions && navigator.permissions.query;
    if (_q) {
      navigator.permissions.query = function (p) {
        return p && p.name === 'notifications'
          ? Promise.resolve({ state: (window.Notification && Notification.permission) || 'default' })
          : _q.call(navigator.permissions, p);
      };
    }
  } catch (e) {}
  try {
    const _gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return _gp.call(this, p);
    };
  } catch (e) {}
`;

/** Proxy pro Playwright a partir de HAVOK_PROXY (http://user:pass@host:porta). Vazio = sem proxy. */
function buildProxy(): { server: string; username?: string; password?: string } | undefined {
  const raw = env.HAVOK_PROXY?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const proxy: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`, // host já inclui a porta
    };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    logger.warn('HAVOK_PROXY inválido (esperado http://user:pass@host:porta) — ignorando');
    return undefined;
  }
}

interface Session {
  browser: Browser;
  page: Page;
  token: string;
  startedAt: Date;
}

let session: Session | null = null;
let starting = false;

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // renova a cada 8h

function sessionExpired(): boolean {
  if (!session) return true;
  return Date.now() - session.startedAt.getTime() > SESSION_TTL_MS;
}

async function invalidateSession(): Promise<void> {
  if (session) {
    try {
      await session.browser.close();
    } catch {
      // ignore
    }
    session = null;
    logger.info('sessao Havok invalidada');
  }
}

async function startSession(): Promise<Session> {
  if (starting) {
    // espera outra chamada terminar
    for (let i = 0; i < 30 && starting; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (session) return session;
  }
  starting = true;
  logger.info('iniciando sessao Havok...');

  let browser: Browser | undefined;
  try {
    const proxy = buildProxy();
    if (proxy) logger.info({ server: proxy.server }, 'sessao Havok via proxy');
    browser = await chromium.launch({
      headless: true,
      proxy, // undefined = sem proxy (nada muda)
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
    });
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR',
      extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    });
    await context.addInitScript(STEALTH_JS);
    const page = await context.newPage();

    let token: string | null = null;
    let loginError: string | null = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/auth') || url.includes('/api/login')) {
        try {
          const json = (await response.json()) as {
            token?: string;
            access_token?: string;
            data?: { token?: string };
            message?: string;
          };
          const t = json?.token ?? json?.data?.token ?? json?.access_token;
          if (t && !token) token = `Bearer ${t}`;
          if (!t && response.status() >= 400 && json?.message) {
            loginError = json.message;
          }
        } catch {
          // ignore
        }
      }
    });

    logger.info('abrindo painel Havok...');
    await page.goto(env.HAVOK_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    // Espera o campo de senha aparecer — dá tempo do Cloudflare resolver o
    // desafio JS (o IP de datacenter do Railway às vezes cai no "Just a moment")
    // e do SPA (Vue) montar o form. Reload 1x se não aparecer.
    const passInput = page.locator('input[type="password"]').first();
    let passVisible = false;
    for (let tentativa = 1; tentativa <= 3 && !passVisible; tentativa++) {
      try {
        await passInput.waitFor({ state: 'visible', timeout: 45_000 });
        passVisible = true;
      } catch {
        const title = await page.title().catch(() => '?');
        logger.warn(
          { tentativa, title, url: page.url() },
          'campo senha nao apareceu, recarregando (Cloudflare?)',
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => undefined);
      }
    }
    if (!passVisible) {
      throw new Error('formulario de login Havok nao apareceu (Cloudflare/timeout)');
    }

    const userInput = page
      .locator('input[type="text"], input[type="email"], input[name="username"]')
      .first();
    await userInput.fill(env.HAVOK_USER);
    await passInput.fill(env.HAVOK_PASS);
    try {
      await page.locator('button[type="submit"]').first().click({ timeout: 5000 });
    } catch {
      await passInput.press('Enter');
    }

    // Espera o token chegar (via response listener) por até 20s
    for (let i = 0; i < 20 && !token; i++) {
      await page.waitForTimeout(1000);
    }

    if (!token) {
      if (loginError) {
        throw new Error(`login Havok recusado: ${loginError}`);
      }
      throw new Error('nao foi possivel obter token do Havok (login falhou?)');
    }

    session = { browser, page, token, startedAt: new Date() };
    logger.info('sessao Havok iniciada');
    return session;
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    starting = false;
  }
}

async function getSession(): Promise<Session> {
  if (!session || sessionExpired()) {
    await invalidateSession();
    return startSession();
  }
  return session;
}

export interface HavokCredential {
  usuario: string;
  senha: string;
}

/**
 * Cria um cliente no painel Havok e retorna usuário/senha gerados.
 * Retry 3x com renovação de sessão em caso de token expirado.
 */
export async function createHavokCustomer(
  packageId: string,
  attempt = 1,
): Promise<HavokCredential> {
  const MAX = 3;
  try {
    const { page, token } = await getSession();

    const result = await page.evaluate(
      async ({ packageId, token, serverId }) => {
        const usuario = Math.floor(1000000 + Math.random() * 9000000).toString();
        const senha = Math.floor(1000000 + Math.random() * 9000000).toString();

        const res = await fetch('/api/customers', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-app-version': '3.81',
            locale: 'pt',
            Authorization: token,
          },
          body: JSON.stringify({
            server_id: serverId,
            package_id: packageId,
            username: usuario,
            password: senha,
            connections: 3,
            bouquets: '',
            parent_can_edit_personal_data: 'YES',
          }),
        });

        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = await res.text();
        }
        return { status: res.status, data, usuario, senha };
      },
      { packageId, token, serverId: env.HAVOK_SERVER_ID },
    );

    if (result.status === 401) {
      logger.info('token Havok expirado, renovando...');
      await invalidateSession();
      if (attempt < MAX) return createHavokCustomer(packageId, attempt + 1);
      throw new Error('sessao Havok invalida apos renovacao');
    }

    if (result.status !== 200 && result.status !== 201) {
      throw new Error(
        `Havok retornou ${result.status}: ${JSON.stringify(result.data).slice(0, 300)}`,
      );
    }

    const data = result.data as { data?: { username?: string; password?: string } };
    const usuario = data?.data?.username ?? result.usuario;
    const senha = data?.data?.password ?? result.senha;

    logger.info({ packageId, usuario }, 'credencial Havok criada');
    return { usuario, senha };
  } catch (err) {
    if (attempt < MAX) {
      const wait = 2000 * attempt;
      logger.warn(
        { attempt, max: MAX, err: err instanceof Error ? err.message : String(err) },
        'createHavokCustomer falhou, retry',
      );
      await invalidateSession();
      await new Promise((r) => setTimeout(r, wait));
      return createHavokCustomer(packageId, attempt + 1);
    }
    throw err;
  }
}

export interface HavokDeleteResult {
  deleted: boolean;
  /** true = o cliente já não existia no Havok (idempotente, não é erro). */
  jaNaoExistia?: boolean;
}

/**
 * Exclui um cliente no Havok pelo usuário (revogação de cancelado/reembolsado).
 *
 * Fluxo confirmado por captura (2026-07-24):
 *   GET  /api/customers?username=X  → pega o `id` interno
 *   DELETE /api/customers/:id       → 200 {"deleted_at":...}
 *
 * Idempotente: se o cliente não existe mais, retorna jaNaoExistia (não lança).
 * Retry 3x com renovação de sessão em 401/erro.
 */
export async function deleteHavokCustomer(
  usuario: string,
  attempt = 1,
): Promise<HavokDeleteResult> {
  const MAX = 3;
  const user = usuario.trim();
  try {
    const { page, token } = await getSession();

    const result = await page.evaluate(
      async ({ user, token }) => {
        // 1) acha o id interno pelo username
        const buscar = await fetch(
          `/api/customers?page=1&username=${encodeURIComponent(user)}&perPage=10`,
          { headers: { Accept: 'application/json', Authorization: token }, credentials: 'include' },
        );
        if (buscar.status === 401) return { unauthorized: true as const };
        if (!buscar.ok) return { etapa: 'buscar', status: buscar.status };
        const lista = (await buscar.json()) as { data?: { id: string; username: string }[] };
        const arr = lista?.data ?? [];
        const cliente = arr.find((c) => c.username === user) ?? arr[0];
        if (!cliente) return { naoAchou: true as const };

        // 2) exclui pelo id
        const del = await fetch(`/api/customers/${cliente.id}`, {
          method: 'DELETE',
          headers: { Accept: 'application/json', Authorization: token },
          credentials: 'include',
        });
        if (del.status === 401) return { unauthorized: true as const };
        let data: unknown = null;
        try {
          data = await del.json();
        } catch {
          data = await del.text();
        }
        return { etapa: 'delete', status: del.status, id: cliente.id, data };
      },
      { user, token },
    );

    if ('unauthorized' in result && result.unauthorized) {
      logger.info('token Havok expirado (delete), renovando...');
      await invalidateSession();
      if (attempt < MAX) return deleteHavokCustomer(user, attempt + 1);
      throw new Error('sessao Havok invalida apos renovacao (delete)');
    }

    if ('naoAchou' in result && result.naoAchou) {
      logger.info({ usuario: user }, 'Havok: cliente ja nao existia (delete idempotente)');
      return { deleted: false, jaNaoExistia: true };
    }

    if (!('status' in result) || (result.status !== 200 && result.status !== 204)) {
      throw new Error(`Havok delete falhou: ${JSON.stringify(result).slice(0, 200)}`);
    }

    logger.info({ usuario: user, id: 'id' in result ? result.id : '?' }, 'cliente Havok excluido');
    return { deleted: true };
  } catch (err) {
    if (attempt < MAX) {
      const wait = 2000 * attempt;
      logger.warn(
        { attempt, max: MAX, err: err instanceof Error ? err.message : String(err) },
        'deleteHavokCustomer falhou, retry',
      );
      await invalidateSession();
      await new Promise((r) => setTimeout(r, wait));
      return deleteHavokCustomer(user, attempt + 1);
    }
    throw err;
  }
}

export interface HavokRenewResult {
  renewed: boolean;
  expiresAt?: string | null;
}

/**
 * Renova um cliente no Havok MANTENDO usuário/senha (ação "Renovar" do reseller:
 * consome 1 crédito e estende o `expires_at` em +1 período do pacote atual).
 *
 * Fluxo confirmado por captura (2026-07-25):
 *   GET  /api/customers?username=X          → pega id + package_id + server_id
 *   POST /api/customers/:id/renew {pkg,srv} → 200, devolve o customer com novo expires_at
 * (mantém o mesmo user/senha). Retry 3x com renovação de sessão em 401.
 */
export async function renewHavokCustomer(usuario: string, attempt = 1): Promise<HavokRenewResult> {
  const MAX = 3;
  const user = usuario.trim();
  try {
    const { page, token } = await getSession();

    const result = await page.evaluate(
      async ({ user, token }) => {
        // 1) acha o customer pelo username
        const buscar = await fetch(
          `/api/customers?page=1&username=${encodeURIComponent(user)}&perPage=10`,
          { headers: { Accept: 'application/json', Authorization: token }, credentials: 'include' },
        );
        if (buscar.status === 401) return { unauthorized: true as const };
        if (!buscar.ok) return { etapa: 'buscar', status: buscar.status };
        const lista = (await buscar.json()) as {
          data?: { id: string; username: string; package_id?: string; server_id?: string }[];
        };
        const arr = lista?.data ?? [];
        const c = arr.find((x) => x.username === user) ?? arr[0];
        if (!c) return { naoAchou: true as const };

        // 2) renova pelo pacote atual (mantém usuário/senha, estende expires_at)
        const ren = await fetch(`/api/customers/${c.id}/renew`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: token,
          },
          credentials: 'include',
          body: JSON.stringify({ package_id: c.package_id, server_id: c.server_id }),
        });
        if (ren.status === 401) return { unauthorized: true as const };
        let data: unknown = null;
        try {
          data = await ren.json();
        } catch {
          data = await ren.text();
        }
        return { etapa: 'renew', status: ren.status, data };
      },
      { user, token },
    );

    if ('unauthorized' in result && result.unauthorized) {
      logger.info('token Havok expirado (renew), renovando sessao...');
      await invalidateSession();
      if (attempt < MAX) return renewHavokCustomer(usuario, attempt + 1);
      throw new Error('sessao Havok invalida apos renovacao (renew)');
    }
    if ('naoAchou' in result && result.naoAchou) {
      throw new Error(`Havok: cliente ${user} nao encontrado pra renovar`);
    }
    if (!('status' in result) || (result.status !== 200 && result.status !== 201)) {
      throw new Error(`Havok renew falhou: ${JSON.stringify(result).slice(0, 200)}`);
    }

    const data = (result as { data?: { data?: { expires_at?: string } } }).data;
    const expiresAt = data?.data?.expires_at ?? null;
    logger.info({ usuario: user, expiresAt }, 'cliente Havok renovado');
    return { renewed: true, expiresAt };
  } catch (err) {
    if (attempt < MAX) {
      const wait = 2000 * attempt;
      logger.warn(
        { attempt, max: MAX, err: err instanceof Error ? err.message : String(err) },
        'renewHavokCustomer falhou, retry',
      );
      await invalidateSession();
      await new Promise((r) => setTimeout(r, wait));
      return renewHavokCustomer(usuario, attempt + 1);
    }
    throw err;
  }
}

/** status pra /health/havok */
export function getHavokStatus() {
  return {
    session: session && !sessionExpired() ? 'ativa' : 'inativa',
    startedAt: session?.startedAt.toISOString() ?? null,
    proxy: !!buildProxy(), // true = HAVOK_PROXY configurado e válido
  };
}

/** aquece a sessão no boot (não bloqueia se falhar) */
export async function warmHavokSession(): Promise<void> {
  try {
    await getSession();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'warm-up da sessao Havok falhou (sera criada na 1a venda)',
    );
  }
}

/**
 * Keep-alive: mantém a sessão sempre quente pra entrega instantânea.
 * A cada 20min garante que há sessão viva (recria se caiu/expirou).
 * Se o warm-up do boot falhou (Cloudflare), tenta de novo aqui.
 */
export function startHavokKeepAlive(intervalMs = 20 * 60 * 1000): NodeJS.Timeout {
  logger.info({ intervalMs }, 'iniciando keep-alive da sessao Havok');
  return setInterval(() => {
    if (!session || sessionExpired()) {
      void warmHavokSession();
    }
  }, intervalMs);
}
