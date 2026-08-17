import type { EmailVars } from './access-email.html.js';

function firstName(full: string): string {
  return (full.split(/\s+/)[0] || 'você').trim();
}

export function renderAccessEmailText(vars: EmailVars): string {
  // Caminho principal: só o link de configurar (login/senha ficam no site de config).
  // Fallback (sem configUrl): mostra as credenciais pra não deixar o cliente sem acesso.
  const accessSection = vars.configUrl
    ? `Seu acesso ao CINE RUSH TV está pronto! 🎉

É só abrir o link abaixo pra configurar no seu aparelho — lá estão o seu login, a senha e o passo a passo, tudo em um lugar só (leva uns 2 minutos):

⚙️ Configurar meu acesso:
${vars.configUrl}`
    : `Segue abaixo o seu acesso ao CINE RUSH TV:

🔗 URL: ${vars.accessUrl}
👤 Usuário: ${vars.usuario}
🔐 Senha: ${vars.senha}`;

  return `Olá, ${firstName(vars.nome)}! 👋

${accessSection}

Ficou com qualquer dúvida pra acessar ou configurar? Fala com a gente no WhatsApp:

👉 ${vars.supportUrl}

Nossa equipe terá prazer em ajudar.
`;
}
