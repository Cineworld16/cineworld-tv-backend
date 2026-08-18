export interface EmailVars {
  nome: string;
  usuario: string;
  senha: string;
  accessUrl: string;
  supportUrl: string;
  whatsappIconUrl: string;
  configUrl?: string;
}

function firstName(full: string): string {
  return (full.split(/\s+/)[0] || 'você').trim();
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAccessEmailHtml(vars: EmailVars): string {
  const nome = escapeHtml(firstName(vars.nome));
  const usuario = escapeHtml(vars.usuario);
  const senha = escapeHtml(vars.senha);
  const accessUrl = escapeHtml(vars.accessUrl);
  const supportUrl = escapeHtml(vars.supportUrl);
  const whatsappIconUrl = escapeHtml(vars.whatsappIconUrl);
  const configUrl = vars.configUrl ? escapeHtml(vars.configUrl) : '';

  // Caminho principal: só o botão de configurar (login/senha ficam no site de config).
  const configSection = `
              <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#d4d4d8;">
                Seu acesso ao <strong>CINEWORLD</strong> está pronto! 🎉 É só clicar no botão abaixo pra configurar no seu aparelho — lá estão o seu login, a senha e o passo a passo, tudo em um lugar só.
              </p>
              <div style="text-align:center;margin:8px 0 24px;">
                <a href="${configUrl}" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#ec4899);color:#ffffff;text-decoration:none;font-weight:700;padding:16px 32px;border-radius:10px;font-size:17px;">
                  ⚙️ Configurar meu acesso
                </a>
                <div style="font-size:13px;color:#a1a1aa;margin-top:8px;">Leva uns 2 minutos, com tutorial pro seu aparelho.</div>
              </div>`;

  // Fallback: se não houver link de config, mostra as credenciais pra não deixar o cliente sem acesso.
  const credentialsSection = `
              <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#d4d4d8;">
                Segue abaixo o seu acesso ao <strong>CINEWORLD</strong>:
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1e1735;border:1px solid #2a2145;border-radius:12px;padding:20px;margin-bottom:24px;">
                <tr>
                  <td style="padding-bottom:14px;">
                    <div style="font-size:13px;color:#a1a1aa;margin-bottom:4px;">🔗 URL</div>
                    <div style="font-size:16px;font-weight:600;color:#ffffff;font-family:'SFMono-Regular',Consolas,Menlo,monospace;">
                      <a href="${accessUrl}" style="color:#ffffff;text-decoration:none;">${accessUrl}</a>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:14px;">
                    <div style="font-size:13px;color:#a1a1aa;margin-bottom:4px;">👤 Usuário</div>
                    <div style="font-size:18px;font-weight:600;color:#ffffff;font-family:'SFMono-Regular',Consolas,Menlo,monospace;">${usuario}</div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <div style="font-size:13px;color:#a1a1aa;margin-bottom:4px;">🔐 Senha</div>
                    <div style="font-size:18px;font-weight:600;color:#ffffff;font-family:'SFMono-Regular',Consolas,Menlo,monospace;">${senha}</div>
                  </td>
                </tr>
              </table>`;

  const accessSection = configUrl ? configSection : credentialsSection;

  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:#0a0713;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0713;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141024;border-radius:16px;padding:32px;">
          <tr>
            <td>
              <div style="font-size:20px;font-weight:800;letter-spacing:0.5px;background:linear-gradient(135deg,#a855f7,#ec4899);-webkit-background-clip:text;background-clip:text;color:transparent;">CINEWORLD</div>
            </td>
          </tr>
          <tr>
            <td style="padding-top:24px;">
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#ffffff;">Olá, ${nome}! 👋</h1>
              ${accessSection}

              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#d4d4d8;">
                Ficou com qualquer dúvida pra acessar ou configurar? Fala com a gente no WhatsApp:
              </p>

              <div style="text-align:center;margin:0 0 20px;">
                <a href="${supportUrl}" style="display:inline-block;background:#25D366;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;font-size:15px;">
                  <img src="${whatsappIconUrl}" width="20" height="20" alt="" style="display:inline-block;vertical-align:middle;margin-right:8px;border:0;">
                  <span style="vertical-align:middle;">Falar com o suporte</span>
                </a>
              </div>

              <p style="margin:0;font-size:14px;line-height:1.6;color:#a1a1aa;text-align:center;">
                Nossa equipe terá prazer em ajudar.
              </p>
            </td>
          </tr>
        </table>

        <div style="max-width:560px;padding:16px 8px;font-size:12px;color:#71717a;text-align:center;">
          CINEWORLD · Você recebeu esse email porque comprou um acesso.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
