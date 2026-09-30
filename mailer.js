const { Resend } = require('resend');

async function sendNotificationEmail({ type, titre, description, username }) {
  if (process.env.EMAIL_ENABLED !== 'true') return;
  if (!process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const label  = type === 'bug' ? '🐛 Bug' : '💡 Suggestion';
  const sentAt = new Date().toLocaleString('fr-CH', {
    timeZone: 'Europe/Zurich',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  await resend.emails.send({
    from:    'Grade <noreply@benross.ch>',
    to:      'benjamin.rossetti@eduvaud.ch',
    subject: `[Grade Support] ${label} : ${titre}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#7c3aed">Nouveau ticket support</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px;color:#666">Type</td><td style="padding:8px"><strong>${label}</strong></td></tr>
          <tr><td style="padding:8px;color:#666">Titre</td><td style="padding:8px"><strong>${titre}</strong></td></tr>
          <tr><td style="padding:8px;color:#666">Envoyé par</td><td style="padding:8px">${username}</td></tr>
          <tr><td style="padding:8px;color:#666">Date</td><td style="padding:8px">${sentAt}</td></tr>
        </table>
        <div style="background:#f9fafb;border-radius:8px;padding:16px;margin-top:16px">
          <p style="margin:0;color:#374151">${description.replace(/\n/g, '<br>')}</p>
        </div>
        <p style="margin-top:24px"><a href="https://notes.benross.ch/admin" style="background:#7c3aed;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Voir dans le panneau admin</a></p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail({ username, email, temp_password }) {
  if (process.env.EMAIL_ENABLED !== 'true') return;
  if (!process.env.RESEND_API_KEY || !email) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  return resend.emails.send({
    from:    'Grade <noreply@benross.ch>',
    to:      email,
    subject: '[Grade] Réinitialisation de ton mot de passe',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0a0a1a;color:#e2e8f0;border-radius:12px;padding:32px">
        <h2 style="color:#a78bfa;margin:0 0 16px">Réinitialisation de mot de passe</h2>
        <p>Bonjour <strong>${username}</strong>,</p>
        <p>Un administrateur a réinitialisé ton mot de passe sur <strong>Grade</strong>. Voici ton mot de passe temporaire :</p>
        <div style="background:#1a1a3a;border:1px solid #7c3aed;border-radius:8px;padding:16px 24px;font-size:1.3rem;font-family:monospace;letter-spacing:2px;color:#a78bfa;margin:20px 0;text-align:center">
          ${temp_password}
        </div>
        <p>Connecte-toi avec ce mot de passe sur <a href="https://notes.benross.ch" style="color:#a78bfa">notes.benross.ch</a>, puis tu devras immédiatement en choisir un nouveau.</p>
        <p style="color:#94a3b8;font-size:.85rem;margin-top:24px">Si tu n'as pas demandé de réinitialisation, contacte un administrateur.</p>
      </div>
    `,
  });
}

module.exports = { sendNotificationEmail, sendPasswordResetEmail };
