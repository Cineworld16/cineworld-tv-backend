/**
 * Conteúdo dos passos do onboarding por dispositivo.
 * VERSIONADO — o serviço lê daqui, nada de passo hard-coded na lógica.
 *
 * Baseado no roteiro real do suporte humano CineWorld (2026-07-12).
 * ⚠️ Samsung/LG, TV Box e Web ainda são rascunho (não vieram no roteiro) —
 * o Mateus refina. iOS e Android TV/FireStick são os passos reais.
 *
 * Regras:
 * - Mensagens curtas, PT-BR, tom casual.
 * - NUNCA reexpor usuário/senha aqui — sempre "os do seu email".
 * - `{{access_url}}` vira o env ACCESS_URL em runtime (= http://seu-dns-de-acesso.exemplo).
 * - Botões (Voltar/Próximo/Deu certo/Atendente) são gerados pelo serviço
 *   conforme a posição do passo (limite de 3 botões do WhatsApp).
 */

export type Device =
  | 'samsung_lg'
  | 'androidtv_firestick'
  | 'tvbox'
  | 'android'
  | 'ios'
  | 'web';

export interface OnboardingStep {
  key: string;
  text: string;
  link?: string;
  media_url?: string;
}

export interface DeviceMeta {
  label: string;
  description: string;
}

export const DEVICE_LABELS: Record<Device, DeviceMeta> = {
  ios: { label: 'iPhone', description: 'iPhone ou iPad' },
  androidtv_firestick: {
    label: 'TV Android',
    description: 'Android TV, Fire Stick, TV Box',
  },
  samsung_lg: { label: 'TV Smart', description: 'Samsung ou LG (Tizen/webOS)' },
  android: { label: 'Android', description: 'Celular Android' },
  web: { label: 'Notebook / PC', description: 'Assistir no computador' },
  tvbox: { label: 'TV Box', description: 'Aparelho Android na TV' },
};

/**
 * Ordem e quais dispositivos aparecem no menu (5, conforme o suporte).
 * tvbox fica fora do menu (coberto por "TV Android"), mas o enum/conteúdo
 * continuam válidos caso queira reativar.
 */
export const DEVICE_MENU: Device[] = [
  'ios',
  'androidtv_firestick',
  'samsung_lg',
  'android',
  'web',
];

// Sequência de preenchimento Xtream, comum aos apps.
const preencherXtream: OnboardingStep = {
  key: 'preencher',
  text:
    `Agora é só preencher nessa sequência 👇\n\n` +
    `⬜ *Nome:* CineWorld (ou o que quiser)\n` +
    `👤 *Usuário:* o que te mandei aqui em cima\n` +
    `🔑 *Senha:* a que te mandei aqui em cima\n` +
    `🔗 *URL:* {{access_url}}`,
};

const carregando: OnboardingStep = {
  key: 'carregando',
  text:
    `Salve e aguarde alguns segundos enquanto carrega os canais. ⏳\n\n` +
    `Na primeira vez pode demorar um pouquinho. Quando aparecer a lista de canais, tá pronto! ✅`,
};

export const ONBOARDING: Record<Device, OnboardingStep[]> = {
  ios: [
    {
      key: 'download',
      text:
        `Baixe o app *VU IPTV Player* na App Store. 🍏\n\n` +
        `(Se preferir, o *Smarters Player Lite* também funciona.)`,
      link: 'https://apps.apple.com/app/id1628995509',
    },
    {
      key: 'login',
      text: `Abra o app e toque em *"Login with Xtream Codes API"*. 📲`,
    },
    preencherXtream,
    carregando,
  ],

  androidtv_firestick: [
    {
      key: 'downloader',
      text:
        `Na sua TV, abra a loja de apps e instale o app *Downloader*. 📺\n\n` +
        `Abra o Downloader e, na barra de busca, digite o código: *8621576*`,
    },
    {
      key: 'instala_9xtream',
      text: `Vai aparecer o app *9Xtream* pra baixar. Instale e abra ele. ⬇️`,
    },
    {
      key: 'login',
      text: `No 9Xtream, escolha adicionar usuário e preencha os campos na próxima etapa. 📝`,
    },
    preencherXtream,
    carregando,
  ],

  tvbox: [
    {
      key: 'download',
      text:
        `Na sua TV Box, abra a *Play Store* e instale o *IPTV Smarters Pro* (ou o *9Xtream*). 📦📺`,
      link: 'https://play.google.com/store/apps/details?id=com.nst.iptvsmarterspro',
    },
    {
      key: 'login',
      text: `Abra o app e escolha *"Login com Xtream Codes"*. 📝`,
    },
    preencherXtream,
    carregando,
  ],

  android: [
    {
      key: 'download',
      text:
        `No seu Android, instale o app pelo link abaixo. 📱\n\n` +
        `(Se preferir, procure *IPTV Smarters Pro* na Play Store.)`,
      link: 'https://aftv.news/9538197',
    },
    {
      key: 'login',
      text: `Abra o app e escolha *"Login com Xtream Codes"*. 📝`,
    },
    preencherXtream,
    carregando,
  ],

  samsung_lg: [
    {
      key: 'download',
      text:
        `Na sua Samsung/LG, abra a *loja de apps* e instale o *IBO Player Pro*. 📺\n\n` +
        `Abra o app e anote o *MAC* e a *Key* que aparecem na tela.`,
    },
    {
      key: 'ativar',
      text:
        `Pelo celular, acesse *iboplayer.com/device*, coloque o MAC e a Key e adicione a lista ` +
        `com o *usuário, senha e URL* (próxima etapa).`,
      link: 'https://iboplayer.com/device',
    },
    preencherXtream,
    carregando,
  ],

  web: [
    {
      key: 'acessar',
      text:
        `Pra assistir no computador, acesse *{{access_url}}* no navegador e entre ` +
        `com o *usuário e senha do seu email*. 💻`,
      link: '{{access_url}}',
    },
    carregando,
  ],
};
