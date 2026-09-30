// Configuration PM2 — exemple.
// Copier ce fichier en `ecosystem.config.js` et renseigner les vraies valeurs.
// `ecosystem.config.js` est ignoré par git (il contient des secrets).
//
//   cp ecosystem.config.example.js ecosystem.config.js
//   pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: 'grade',
      script: 'server.js',
      cwd: '/home/ubuntu/grade',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        // Secret de signature des JWT — générer avec :
        //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
        JWT_SECRET: 'changeme-generate-a-random-64-char-hex-string',
        DATABASE_PATH: '/home/ubuntu/grade/grades.db',
        // Envoi d'emails (optionnel) — via Resend (https://resend.com)
        EMAIL_ENABLED: 'false',
        RESEND_API_KEY: '',
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
