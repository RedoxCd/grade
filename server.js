const http = require('http');
const express = require('express');
const { Server: IOServer } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { sendNotificationEmail, sendPasswordResetEmail } = require('./mailer');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const cookieParser = require('cookie-parser');

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'grades.db');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const SSO_SECRET = process.env.SSO_SECRET || 'dev-sso-secret-change-in-prod';
const SSO_COOKIE = 'benross_sso';
const PORT = process.env.PORT || 3000;

// Compte partagé benross.ch : pose un cookie inter-sous-domaines (grade/reveo)
// en plus du token JWT normal, pour permettre la connexion automatique entre les deux apps.
function setSsoCookie(res, user) {
  const t = jwt.sign({ id: user.id, username: user.username }, SSO_SECRET, { expiresIn: '30d' });
  res.cookie(SSO_COOKIE, t, { domain: '.benross.ch', httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000 });
}
function clearSsoCookie(res) {
  res.clearCookie(SSO_COOKIE, { domain: '.benross.ch', path: '/' });
}

function main() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  function run(sql, params = []) { return db.prepare(sql).run(...params); }
  function get(sql, params = []) { return db.prepare(sql).get(...params) ?? null; }
  function all(sql, params = []) { return db.prepare(sql).all(...params); }
  function exec(sql)              { return db.exec(sql); }

  // ── Init schema ──────────────────────────────────────────────────────────────
  exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subjects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL CHECK(year BETWEEN 1 AND 4),
  trimester   INTEGER NOT NULL CHECK(trimester BETWEEN 1 AND 4),
  name        TEXT    NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS grades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  value       REAL    NOT NULL CHECK(value BETWEEN 1 AND 6),
  weight      REAL    NOT NULL CHECK(weight > 0),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS future_tests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  weight      REAL    NOT NULL CHECK(weight > 0),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL CHECK(year BETWEEN 1 AND 4),
  trimester   INTEGER NOT NULL CHECK(trimester BETWEEN 1 AND 4),
  name        TEXT    NOT NULL,
  periods     INTEGER NOT NULL CHECK(periods > 0),
  success     INTEGER NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cg_subjects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL CHECK(year BETWEEN 1 AND 4),
  name        TEXT    NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cg_tests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cg_subject_id   INTEGER NOT NULL REFERENCES cg_subjects(id) ON DELETE CASCADE,
  semester        INTEGER NOT NULL CHECK(semester BETWEEN 1 AND 2),
  name            TEXT    NOT NULL,
  points_obtained REAL    NOT NULL CHECK(points_obtained >= 0),
  points_total    REAL    NOT NULL CHECK(points_total > 0),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cg_futures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cg_subject_id INTEGER NOT NULL REFERENCES cg_subjects(id) ON DELETE CASCADE,
  semester      INTEGER NOT NULL CHECK(semester BETWEEN 1 AND 2),
  name          TEXT    NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cg_petits_tests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cg_subject_id   INTEGER NOT NULL REFERENCES cg_subjects(id) ON DELETE CASCADE,
  semester        INTEGER NOT NULL CHECK(semester BETWEEN 1 AND 2),
  name            TEXT    NOT NULL,
  points_obtained REAL    NOT NULL CHECK(points_obtained >= 0),
  points_total    REAL    NOT NULL CHECK(points_total > 0),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS matieres (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nom         TEXT    NOT NULL,
  couleur     TEXT    NOT NULL DEFAULT '#6366f1',
  date_debut  TEXT,
  date_fin    TEXT
);

CREATE TABLE IF NOT EXISTS creneaux (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matiere_id  INTEGER NOT NULL REFERENCES matieres(id) ON DELETE CASCADE,
  jour        INTEGER NOT NULL,
  heure_debut TEXT    NOT NULL,
  heure_fin   TEXT    NOT NULL,
  salle       TEXT
);

CREATE TABLE IF NOT EXISTS devoirs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matiere_id  INTEGER REFERENCES matieres(id) ON DELETE SET NULL,
  titre       TEXT    NOT NULL,
  description TEXT,
  deadline    TEXT,
  priorite    TEXT    NOT NULL DEFAULT 'moyenne',
  statut      TEXT    NOT NULL DEFAULT 'todo',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL CHECK(type IN ('bug', 'suggestion', 'reset')),
  titre       TEXT    NOT NULL,
  description TEXT    NOT NULL,
  statut      TEXT    NOT NULL DEFAULT 'ouvert',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT    NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
  `);

  // Migration 1: drop old flat CG tables if subject-based schema not yet created
  if (!get("SELECT name FROM sqlite_master WHERE type='table' AND name='cg_subjects'")) {
    db.exec('DROP TABLE IF EXISTS cg_futures');
    db.exec('DROP TABLE IF EXISTS cg_tests');
  }

  // Migration 2: remove points_total from cg_futures (no longer needed)
  const cgFutCols = all("PRAGMA table_info(cg_futures)");
  if (cgFutCols.some(c => c.name === 'points_total')) {
    db.exec(`
      CREATE TABLE cg_futures_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        cg_subject_id INTEGER NOT NULL REFERENCES cg_subjects(id) ON DELETE CASCADE,
        semester      INTEGER NOT NULL CHECK(semester BETWEEN 1 AND 2),
        name          TEXT    NOT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO cg_futures_new SELECT id, cg_subject_id, semester, name, created_at FROM cg_futures;
      DROP TABLE cg_futures;
      ALTER TABLE cg_futures_new RENAME TO cg_futures;
    `);
  }

  // Migration 3: add target to subjects
  const subjCols = all('PRAGMA table_info(subjects)');
  if (!subjCols.some(c => c.name === 'target')) {
    db.exec('ALTER TABLE subjects ADD COLUMN target REAL DEFAULT 4.0');
  }

  // Migration 4: add target_s1/target_s2 to cg_subjects
  const cgSubjCols = all('PRAGMA table_info(cg_subjects)');
  if (!cgSubjCols.some(c => c.name === 'target_s1')) {
    db.exec('ALTER TABLE cg_subjects ADD COLUMN target_s1 REAL DEFAULT 4.0');
    db.exec('ALTER TABLE cg_subjects ADD COLUMN target_s2 REAL DEFAULT 4.0');
  }

  // Migration 5b: add is_petit_test to cg_futures
  const cgFutCols2 = all('PRAGMA table_info(cg_futures)');
  if (!cgFutCols2.some(c => c.name === 'is_petit_test')) {
    db.exec('ALTER TABLE cg_futures ADD COLUMN is_petit_test INTEGER NOT NULL DEFAULT 0');
  }

  // Migration 6: add date_test, note, time_test to future_tests
  const futTestsMigCols = all('PRAGMA table_info(future_tests)');
  if (!futTestsMigCols.some(c => c.name === 'date_test')) {
    db.exec('ALTER TABLE future_tests ADD COLUMN date_test TEXT');
  }
  if (!futTestsMigCols.some(c => c.name === 'note')) {
    db.exec('ALTER TABLE future_tests ADD COLUMN note REAL');
  }
  if (!futTestsMigCols.some(c => c.name === 'time_test')) {
    db.exec('ALTER TABLE future_tests ADD COLUMN time_test TEXT');
  }

  // Migration 5: add comment to grades, cg_tests, cg_petits_tests
  const gradesCols = all('PRAGMA table_info(grades)');
  if (!gradesCols.some(c => c.name === 'comment')) {
    db.exec("ALTER TABLE grades ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
  }
  const cgtCols = all('PRAGMA table_info(cg_tests)');
  if (!cgtCols.some(c => c.name === 'comment')) {
    db.exec("ALTER TABLE cg_tests ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
  }
  const cgptCols = all('PRAGMA table_info(cg_petits_tests)');
  if (!cgptCols.some(c => c.name === 'comment')) {
    db.exec("ALTER TABLE cg_petits_tests ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
  }

  // Migration: add role, banned, reset_requested to users
  const usersCols = all('PRAGMA table_info(users)');
  if (!usersCols.some(c => c.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!usersCols.some(c => c.name === 'banned')) {
    db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
  }
  if (!usersCols.some(c => c.name === 'reset_requested')) {
    db.exec('ALTER TABLE users ADD COLUMN reset_requested INTEGER NOT NULL DEFAULT 0');
  }
  if (!usersCols.some(c => c.name === 'reset_message')) {
    db.exec("ALTER TABLE users ADD COLUMN reset_message TEXT NOT NULL DEFAULT ''");
  }
  if (!usersCols.some(c => c.name === 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
  if (!usersCols.some(c => c.name === 'full_name')) {
    db.exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''");
  }
  if (!usersCols.some(c => c.name === 'last_login')) {
    db.exec('ALTER TABLE users ADD COLUMN last_login DATETIME');
  }
  if (!usersCols.some(c => c.name === 'avatar')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  }
  if (!usersCols.some(c => c.name === 'allow_admin_view')) {
    db.exec('ALTER TABLE users ADD COLUMN allow_admin_view INTEGER NOT NULL DEFAULT 0');
  }
  if (!usersCols.some(c => c.name === 'admin_view_granted_at')) {
    db.exec('ALTER TABLE users ADD COLUMN admin_view_granted_at DATETIME');
  }

  // Migration: add 'reset' to tickets.type CHECK constraint
  const ticketCheck = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='tickets'");
  if (ticketCheck && !ticketCheck.sql.includes("'reset'")) {
    exec(`
      CREATE TABLE tickets_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT    NOT NULL CHECK(type IN ('bug', 'suggestion', 'reset')),
        titre       TEXT    NOT NULL,
        description TEXT    NOT NULL,
        statut      TEXT    NOT NULL DEFAULT 'ouvert',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO tickets_new SELECT * FROM tickets;
      DROP TABLE tickets;
      ALTER TABLE tickets_new RENAME TO tickets;
    `);
  }

  const app = express();
  const httpServer = http.createServer(app);
  const io = new IOServer(httpServer, { cors: { origin: false } });

  // Socket.io auth: validate JWT on every connection
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Non authentifié'));
    try { socket.user = jwt.verify(token, SECRET); next(); }
    catch { next(new Error('Token invalide')); }
  });

  const userSockets = new Map(); // userId → Set<socket>

  io.on('connection', socket => {
    const uid = socket.user.id;
    // Reject banned/deleted users immediately on (re)connect
    const uCheck = get('SELECT banned FROM users WHERE id = ?', [uid]);
    if (!uCheck || uCheck.banned) {
      socket.emit('force-logout', !uCheck ? 'deleted' : undefined);
      socket.disconnect();
      return;
    }
    if (!userSockets.has(uid)) userSockets.set(uid, new Set());
    userSockets.get(uid).add(socket);

    socket.on('disconnect', () => {
      userSockets.get(uid)?.delete(socket);
      if (userSockets.get(uid)?.size === 0) userSockets.delete(uid);
    });

    socket.on('join-ticket', ticketId => {
      const tid = parseInt(ticketId);
      const ticket = get('SELECT user_id FROM tickets WHERE id = ?', [tid]);
      if (!ticket) return;
      const u = get('SELECT role FROM users WHERE id = ?', [socket.user.id]);
      if (ticket.user_id !== socket.user.id && u?.role !== 'admin') return;
      socket.join(`ticket-${tid}`);
    });
  });

  app.set('trust proxy', 1); // behind nginx
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '250kb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── Rate limiting ──────────────────────────────────────────────────────────────
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de requêtes, réessayez dans 15 minutes' },
  }));
  const limiterAuth = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes' },
  });

  // ── Validation helpers ────────────────────────────────────────────────────────
  const checkValidation = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    next();
  };

  const vName      = body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Nom invalide (1–100 caractères)');
  const vNameOpt   = body('name').optional().trim().isLength({ min: 1, max: 100 }).withMessage('Nom invalide (1–100 caractères)');
  const vEmail     = body('email').trim().isEmail().withMessage('Adresse email invalide');
  const vPassword  = body('password').isLength({ min: 6, max: 128 }).withMessage('Mot de passe : 6–128 caractères requis');
  const vUsername  = body('username').trim()
    .isLength({ min: 1, max: 50 }).withMessage("Nom d'utilisateur requis (1–50 caractères)")
    .matches(/^[\w.\-]+$/).withMessage("Nom d'utilisateur invalide (lettres, chiffres, _ - .)");
  const vYear      = body('year').isInt({ min: 1, max: 4 }).toInt().withMessage('Année invalide (1–4)');
  const vTrimester = body('trimester').isInt({ min: 1, max: 4 }).toInt().withMessage('Trimestre invalide (1–4)');
  const vSemester  = body('semester').isInt({ min: 1, max: 2 }).toInt().withMessage('Semestre invalide (1–2)');
  const vWeight    = body('weight').isFloat({ min: 0.1, max: 100 }).toFloat().withMessage('Poids invalide (0.1–100%)');
  const vValue     = body('value').isFloat({ min: 1, max: 6 }).toFloat().withMessage('Note invalide (1–6)');
  const vPeriods   = body('periods').isInt({ min: 1, max: 10000 }).toInt().withMessage('Périodes invalides (1–10000)');
  const vObt       = body('points_obtained').isFloat({ min: 0 }).toFloat().withMessage('Points obtenus invalides (≥ 0)');
  const vTot       = body('points_total').isFloat({ min: 0.1 }).toFloat().withMessage('Points totaux invalides (> 0)');
  const vComment   = body('comment').optional({ nullable: true }).trim().isLength({ max: 500 }).withMessage('Commentaire trop long (max 500 caractères)');
  const vTargetOpt = body('target').optional().isFloat({ min: 1, max: 6 }).toFloat().withMessage('Objectif invalide (1–6)');

  // ── Auth middleware ───────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
    try {
      req.user = jwt.verify(header.slice(7), SECRET);
      const u = get('SELECT banned FROM users WHERE id = ?', [req.user.id]);
      if (!u || u.banned) return res.status(401).json({ error: 'Compte banni' });
      next();
    } catch {
      res.status(401).json({ error: 'Token invalide ou expiré' });
    }
  }

  // ── Auth routes ───────────────────────────────────────────────────────────────
  app.post('/api/register', limiterAuth, [
    vUsername, vEmail, vPassword,
    body('full_name').optional().trim().isLength({ max: 100 }).withMessage('Nom trop long (max 100 caractères)'),
  ], checkValidation, (req, res) => {
    const { username, email, password, full_name = '' } = req.body ?? {};
    if (!username?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Nom, email et mot de passe requis' });

    try {
      const hash = bcrypt.hashSync(password, 10);
      const { lastInsertRowid: id } = run(
        'INSERT INTO users (username, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
        [username.trim(), email.trim().toLowerCase(), hash, (full_name || '').trim()]
      );
      const token = jwt.sign({ id, username: username.trim() }, SECRET, { expiresIn: '30d' });
      setSsoCookie(res, { id, username: username.trim() });
      res.status(201).json({ token, username: username.trim(), full_name: (full_name || '').trim() });
    } catch (e) {
      if (e.message.includes('UNIQUE'))
        return res.status(409).json({ error: 'Nom d\'utilisateur ou email déjà utilisé' });
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  app.post('/api/login', limiterAuth, [vUsername, body('password').isLength({ min: 1, max: 128 }).withMessage('Mot de passe requis')], checkValidation, (req, res) => {
    const { username, password } = req.body ?? {};
    const user = get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Identifiants incorrects' });
    if (user.banned) return res.status(403).json({ error: 'Compte banni. Contacte un administrateur.' });
    run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '30d' });
    setSsoCookie(res, { id: user.id, username: user.username });
    res.json({ token, username: user.username, full_name: user.full_name || '', must_change_password: !!user.must_change_password });
  });

  // ── SSO benross.ch (partagé avec reveo.benross.ch) ─────────────────────────────
  app.post('/api/logout', (req, res) => { clearSsoCookie(res); res.json({ ok: true }); });

  app.get('/api/sso/exchange', (req, res) => {
    const c = req.cookies?.[SSO_COOKIE];
    if (!c) return res.status(401).json({ error: 'Pas de session partagée' });
    let payload;
    try { payload = jwt.verify(c, SSO_SECRET); } catch { return res.status(401).json({ error: 'Session partagée invalide' }); }
    const user = get('SELECT id, username, full_name, banned FROM users WHERE id = ?', [payload.id]);
    if (!user || user.banned) return res.status(401).json({ error: 'Compte introuvable ou banni' });
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username, full_name: user.full_name || '' });
  });

  app.post('/api/request-password-reset', limiterAuth, [
    body('username').isLength({ min: 1, max: 32 }).trim(),
    body('email').isEmail().normalizeEmail(),
    body('message').isLength({ min: 1, max: 500 }).trim(),
  ], checkValidation, (req, res) => {
    const { username, email, message } = req.body;
    const u = get('SELECT id, username, email FROM users WHERE username = ?', [username]);
    if (!u || u.email.toLowerCase() !== email.toLowerCase())
      return res.status(403).json({ error: 'Nom d\'utilisateur ou adresse email incorrects.' });
    const temp = 'Grade#' + crypto.randomBytes(5).toString('hex');
    const hash = bcrypt.hashSync(temp, 10);
    run("UPDATE users SET password_hash = ?, must_change_password = 1, reset_requested = 0, reset_message = '' WHERE id = ?", [hash, u.id]);
    const { lastInsertRowid: ticketId } = run(
      "INSERT INTO tickets (user_id, type, titre, description) VALUES (?, 'reset', 'Réinitialisation de mot de passe', ?)",
      [u.id, message]
    );
    const autoMsg = `Ton mot de passe a été réinitialisé automatiquement.\n\nUn mot de passe temporaire a été envoyé à l'adresse email de ton compte.\n\nConnecte-toi avec ce mot de passe, tu devras immédiatement en choisir un nouveau.`;
    const adminUser = get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const senderId = adminUser ? adminUser.id : u.id;
    run('INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)', [ticketId, senderId, autoMsg]);
    sendPasswordResetEmail({ username: u.username, email: u.email, temp_password: temp }).catch(err => console.error('Email reset error:', err.message));
    res.json({ ok: true, ticket_id: ticketId });
  });

  // Lecture publique des messages d'un ticket reset (pas d'auth requise)
  app.get('/api/reset-messages/:ticketId', (req, res) => {
    const tid = parseInt(req.params.ticketId);
    const ticket = get("SELECT id FROM tickets WHERE id = ? AND type = 'reset'", [tid]);
    if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
    const msgs = all(`
      SELECT m.message, m.created_at,
        CASE WHEN u.role = 'admin' THEN 1 ELSE 0 END as is_admin,
        u.username
      FROM ticket_messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.ticket_id = ? ORDER BY m.created_at ASC
    `, [tid]);
    res.json(msgs);
  });

  app.post('/api/change-password', auth, [
    body('new_password').isLength({ min: 6, max: 128 }).withMessage('Le mot de passe doit contenir au moins 6 caractères'),
    body('current_password').optional().isLength({ min: 1, max: 128 }),
  ], checkValidation, (req, res) => {
    const { new_password, current_password } = req.body;
    const u = get('SELECT password_hash, must_change_password FROM users WHERE id = ?', [req.user.id]);
    if (!u.must_change_password) {
      if (!current_password) return res.status(400).json({ error: 'Le mot de passe actuel est requis.' });
      if (!bcrypt.compareSync(current_password, u.password_hash))
        return res.status(403).json({ error: 'Mot de passe actuel incorrect.' });
    }
    const hash = bcrypt.hashSync(new_password, 10);
    run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, req.user.id]);
    res.json({ ok: true });
  });

  // ── Profile ───────────────────────────────────────────────────────────────────
  app.get('/api/profile', auth, (req, res) => {
    const u = get('SELECT id, username, email, full_name, role, created_at, last_login, avatar, allow_admin_view, admin_view_granted_at FROM users WHERE id = ?', [req.user.id]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const nb_subjects = (get('SELECT COUNT(*) AS n FROM subjects WHERE user_id = ?', [req.user.id]) || {n:0}).n;
    const nb_grades   = (get('SELECT COUNT(*) AS n FROM grades g JOIN subjects s ON g.subject_id = s.id WHERE s.user_id = ?', [req.user.id]) || {n:0}).n;
    const nb_projects = (get('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?', [req.user.id]) || {n:0}).n;
    const nb_cg_tests = (get('SELECT COUNT(*) AS n FROM cg_tests ct JOIN cg_subjects cs ON ct.cg_subject_id = cs.id WHERE cs.user_id = ?', [req.user.id]) || {n:0}).n;
    const allGrades   = all('SELECT g.value, g.weight FROM grades g JOIN subjects s ON g.subject_id = s.id WHERE s.user_id = ?', [req.user.id]);
    const totalW      = allGrades.reduce((s, g) => s + g.weight, 0);
    const global_avg  = totalW > 0 ? allGrades.reduce((s, g) => s + g.value * g.weight, 0) / totalW : null;
    res.json({ ...u, stats: { nb_subjects, nb_grades, nb_projects, nb_cg_tests, global_avg } });
  });

  app.patch('/api/profile', auth, [
    body('full_name').optional().trim().isLength({ max: 100 }).withMessage('Nom trop long (max 100 caractères)'),
    body('email').optional().trim().isEmail().withMessage('Adresse email invalide'),
  ], checkValidation, (req, res) => {
    const { full_name, email } = req.body ?? {};
    if (full_name !== undefined)
      run('UPDATE users SET full_name = ? WHERE id = ?', [(full_name || '').trim(), req.user.id]);
    if (email !== undefined) {
      const existing = get('SELECT id FROM users WHERE email = ? AND id != ?', [email.trim().toLowerCase(), req.user.id]);
      if (existing) return res.status(409).json({ error: 'Email déjà utilisé par un autre compte' });
      run('UPDATE users SET email = ? WHERE id = ?', [email.trim().toLowerCase(), req.user.id]);
    }
    res.json({ ok: true });
  });

  app.patch('/api/profile/admin-access', auth, (req, res) => {
    const u = get('SELECT id, allow_admin_view FROM users WHERE id = ?', [req.user.id]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const newVal = u.allow_admin_view ? 0 : 1;
    run('UPDATE users SET allow_admin_view = ?, admin_view_granted_at = ? WHERE id = ?',
      [newVal, newVal ? new Date().toISOString() : null, req.user.id]);
    res.json({ allow_admin_view: newVal, admin_view_granted_at: newVal ? new Date().toISOString() : null });
  });

  app.patch('/api/profile/avatar', auth, (req, res) => {
    const { avatar } = req.body ?? {};
    if (avatar === null || avatar === undefined) {
      run('UPDATE users SET avatar = NULL WHERE id = ?', [req.user.id]);
      return res.json({ ok: true });
    }
    if (typeof avatar !== 'string' || !avatar.startsWith('data:image/') || avatar.length > 200000)
      return res.status(400).json({ error: 'Image invalide ou trop volumineuse' });
    run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.user.id]);
    res.json({ ok: true });
  });

  // ── Stats charts ─────────────────────────────────────────────────────────────
  app.get('/api/stats/evolution', auth, (req, res) => {
    const uid = req.user.id;
    const { year, trimester } = req.query;

    const byTrimester = all(`
      SELECT s.year, s.trimester,
             ROUND(SUM(g.value * g.weight) / SUM(g.weight), 3) AS avg,
             COUNT(g.id) AS nb
      FROM grades g JOIN subjects s ON g.subject_id = s.id
      WHERE s.user_id = ?
      GROUP BY s.year, s.trimester ORDER BY s.year, s.trimester
    `, [uid]);

    const bySubject = all(`
      SELECT s.name,
             ROUND(SUM(g.value * g.weight) / SUM(g.weight), 3) AS avg,
             COUNT(g.id) AS nb
      FROM grades g JOIN subjects s ON g.subject_id = s.id
      WHERE s.user_id = ?
        AND (? IS NULL OR s.year = ?)
        AND (? IS NULL OR s.trimester = ?)
      GROUP BY s.id ORDER BY avg DESC
    `, [uid, year ?? null, year ?? null, trimester ?? null, trimester ?? null]);

    res.json({ byTrimester, bySubject });
  });

  app.get('/api/stats/evolution/cg', auth, (req, res) => {
    const uid = req.user.id;
    const { year } = req.query;

    const bySemester = all(`\n      SELECT year, semester, ROUND(AVG(grade), 3) AS avg, COUNT(*) AS nb\n      FROM (\n        SELECT cs.year, t.semester, (t.points_obtained * 1.0 / t.points_total) * 5 + 1 AS grade\n        FROM cg_tests t JOIN cg_subjects cs ON t.cg_subject_id = cs.id\n        WHERE cs.user_id = ? AND t.points_total > 0\n        UNION ALL\n        SELECT cs.year, pt.semester, (pt.points_obtained * 1.0 / pt.points_total) * 5 + 1 AS grade\n        FROM cg_petits_tests pt JOIN cg_subjects cs ON pt.cg_subject_id = cs.id\n        WHERE cs.user_id = ? AND pt.points_total > 0\n      )\n      GROUP BY year, semester ORDER BY year, semester\n    `, [uid, uid]);

    const bySubject = all(`
      SELECT name, ROUND(AVG(grade), 3) AS avg, COUNT(*) AS nb
      FROM (
        SELECT cs.id, cs.name, (t.points_obtained * 1.0 / t.points_total) * 5 + 1 AS grade
        FROM cg_tests t JOIN cg_subjects cs ON t.cg_subject_id = cs.id
        WHERE cs.user_id = ? AND t.points_total > 0 AND (? IS NULL OR cs.year = ?)
        UNION ALL
        SELECT cs.id, cs.name, (pt.points_obtained * 1.0 / pt.points_total) * 5 + 1 AS grade
        FROM cg_petits_tests pt JOIN cg_subjects cs ON pt.cg_subject_id = cs.id
        WHERE cs.user_id = ? AND pt.points_total > 0 AND (? IS NULL OR cs.year = ?)
      )
      GROUP BY id, name ORDER BY avg DESC
    `, [uid, year ?? null, year ?? null, uid, year ?? null, year ?? null]);

    res.json({ bySemester, bySubject });
  });

  app.get('/api/stats/summary', auth, (req, res) => {
    const uid = req.user.id;
    // Info avg per year
    const infoByYear = all(`
      SELECT s.year, ROUND(SUM(g.value * g.weight) / NULLIF(SUM(g.weight),0), 3) AS avg
      FROM grades g JOIN subjects s ON g.subject_id = s.id
      WHERE s.user_id = ? GROUP BY s.year`, [uid]);
    // CG avg per year+semester
    const cgByYearSem = all(`
      SELECT year, semester, ROUND(AVG(grade), 3) AS avg FROM (
        SELECT cs.year, t.semester, (t.points_obtained * 1.0 / t.points_total) * 5 + 1 AS grade
        FROM cg_tests t JOIN cg_subjects cs ON t.cg_subject_id = cs.id
        WHERE cs.user_id = ? AND t.points_total > 0
        UNION ALL
        SELECT cs.year, pt.semester, (pt.points_obtained * 1.0 / pt.points_total) * 5 + 1 AS grade
        FROM cg_petits_tests pt JOIN cg_subjects cs ON pt.cg_subject_id = cs.id
        WHERE cs.user_id = ? AND pt.points_total > 0
      ) GROUP BY year, semester`, [uid, uid]);
    // Projects per year
    const projByYear = all(`
      SELECT year,
        ROUND(CAST(SUM(CASE WHEN success=1 THEN periods ELSE 0 END) AS REAL) / NULLIF(SUM(periods),0) * 100, 1) AS pct
      FROM projects WHERE user_id = ? AND periods > 0 GROUP BY year`, [uid]);

    const years = [1,2,3,4];
    const summary = years.map(y => {
      const info = infoByYear.find(r => r.year === y);
      const cgs1 = cgByYearSem.find(r => r.year === y && r.semester === 1);
      const cgs2 = cgByYearSem.find(r => r.year === y && r.semester === 2);
      const proj = projByYear.find(r => r.year === y);
      return { year: y, info_avg: info?.avg ?? null, cg_s1: cgs1?.avg ?? null, cg_s2: cgs2?.avg ?? null, proj_pct: proj?.pct ?? null };
    });
    res.json(summary);
  });

  app.get('/api/stats/personal', auth, (req, res) => {
    const uid = req.user.id;
    const base = get(`
      SELECT COUNT(*) AS total, MAX(g.value) AS best, MIN(g.value) AS worst,
             ROUND(AVG(g.weight), 1) AS avg_weight
      FROM grades g JOIN subjects s ON g.subject_id = s.id WHERE s.user_id = ?`, [uid]);
    const bestSubj = get(`
      SELECT s.name, ROUND(SUM(g.value*g.weight)/SUM(g.weight),2) AS avg
      FROM grades g JOIN subjects s ON g.subject_id = s.id WHERE s.user_id = ?
      GROUP BY s.id ORDER BY avg DESC LIMIT 1`, [uid]);
    const worstSubj = get(`
      SELECT s.name, ROUND(SUM(g.value*g.weight)/SUM(g.weight),2) AS avg
      FROM grades g JOIN subjects s ON g.subject_id = s.id WHERE s.user_id = ?
      HAVING COUNT(*) >= 2 GROUP BY s.id ORDER BY avg ASC LIMIT 1`, [uid]);
    const totalSubj = get(`SELECT COUNT(DISTINCT s.id) AS n FROM subjects s WHERE s.user_id = ?`, [uid]);
    const totalCGTests = get(`
      SELECT COUNT(*) AS n FROM (
        SELECT t.id FROM cg_tests t JOIN cg_subjects cs ON t.cg_subject_id = cs.id WHERE cs.user_id = ?
        UNION ALL
        SELECT pt.id FROM cg_petits_tests pt JOIN cg_subjects cs ON pt.cg_subject_id = cs.id WHERE cs.user_id = ?
      )`, [uid, uid]);
    res.json({
      total_grades: base?.total ?? 0,
      best_grade:   base?.best  ?? null,
      worst_grade:  base?.worst ?? null,
      avg_weight:   base?.avg_weight ?? null,
      best_subject: bestSubj  ?? null,
      worst_subject: worstSubj ?? null,
      total_subjects: totalSubj?.n ?? 0,
      total_cg_tests: totalCGTests?.n ?? 0,
    });
  });

  app.get('/api/ping', auth, (req, res) => res.json({ ok: true }));

  // ── Subjects ──────────────────────────────────────────────────────────────────
  app.get('/api/subjects', auth, (req, res) => {
    const { year, trimester } = req.query;
    const rows = all(
      `SELECT * FROM subjects WHERE user_id = ?
       AND (? IS NULL OR year = ?) AND (? IS NULL OR trimester = ?)
       ORDER BY name`,
      [req.user.id, year ?? null, year ?? null, trimester ?? null, trimester ?? null]
    );
    res.json(rows);
  });

  app.post('/api/subjects', auth, [vName, vYear, vTrimester], checkValidation, (req, res) => {
    const { name, year, trimester } = req.body ?? {};
    if (!name?.trim() || !year || !trimester)
      return res.status(400).json({ error: 'Nom, année et trimestre requis' });
    try {
      const { lastInsertRowid: id } = run(
        'INSERT INTO subjects (user_id, year, trimester, name) VALUES (?, ?, ?, ?)',
        [req.user.id, year, trimester, name.trim()]
      );
      res.status(201).json({ id, name: name.trim(), year, trimester });
    } catch (e) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  app.delete('/api/subjects/:id', auth, (req, res) => {
    const s = get('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!s) return res.status(404).json({ error: 'Matière introuvable' });
    run('DELETE FROM subjects WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.patch('/api/subjects/:id', auth, [vNameOpt, vTargetOpt], checkValidation, (req, res) => {
    const s = get('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!s) return res.status(404).json({ error: 'Matière introuvable' });
    const body = req.body ?? {};
    if ('target' in body) {
      const t = parseFloat(body.target);
      if (isNaN(t) || t < 1 || t > 6) return res.status(400).json({ error: 'Objectif invalide (1–6)' });
      run('UPDATE subjects SET target = ? WHERE id = ?', [t, req.params.id]);
    } else {
      if (!body.name?.trim()) return res.status(400).json({ error: 'Nom requis' });
      run('UPDATE subjects SET name = ? WHERE id = ?', [body.name.trim(), req.params.id]);
    }
    res.json({ ok: true });
  });

  // ── Grades ────────────────────────────────────────────────────────────────────
  function ownsSubject(subjectId, userId) {
    return get('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subjectId, userId]);
  }

  app.get('/api/subjects/:id/detail', auth, (req, res) => {
    if (!ownsSubject(req.params.id, req.user.id))
      return res.status(404).json({ error: 'Matière introuvable' });
    const grades  = all('SELECT * FROM grades       WHERE subject_id = ? ORDER BY created_at', [req.params.id]);
    const futures = all('SELECT * FROM future_tests WHERE subject_id = ? ORDER BY created_at', [req.params.id]);
    res.json({ grades, futures });
  });

  app.post('/api/subjects/:id/grades', auth, [vName, vValue, vWeight, vComment], checkValidation, (req, res) => {
    if (!ownsSubject(req.params.id, req.user.id))
      return res.status(404).json({ error: 'Matière introuvable' });
    const { name, value, weight, comment = '' } = req.body ?? {};
    if (!name?.trim() || value == null || !weight)
      return res.status(400).json({ error: 'Nom, note et poids requis' });
    if (value < 1 || value > 6)
      return res.status(400).json({ error: 'La note doit être entre 1 et 6' });
    if (weight <= 0 || weight > 100)
      return res.status(400).json({ error: 'Le poids doit être entre 0 et 100%' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO grades (subject_id, name, value, weight, comment) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, name.trim(), value, weight, comment.trim()]
    );
    res.status(201).json({ id, name: name.trim(), value, weight, comment: comment.trim() });
  });

  app.delete('/api/grades/:id', auth, (req, res) => {
    const g = get(
      'SELECT g.id FROM grades g JOIN subjects s ON g.subject_id = s.id WHERE g.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!g) return res.status(404).json({ error: 'Note introuvable' });
    run('DELETE FROM grades WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.patch('/api/grades/:id', auth, [
    vNameOpt,
    body('value').optional().isFloat({ min: 1, max: 6 }).toFloat().withMessage('Note invalide (1–6)'),
    body('weight').optional().isFloat({ min: 0.1, max: 100 }).toFloat().withMessage('Poids invalide (0.1–100%)'),
    vComment,
  ], checkValidation, (req, res) => {
    const g = get(
      'SELECT g.id FROM grades g JOIN subjects s ON g.subject_id = s.id WHERE g.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!g) return res.status(404).json({ error: 'Note introuvable' });
    const { name, value, weight, comment } = req.body ?? {};
    if (comment !== undefined && name === undefined) {
      run('UPDATE grades SET comment = ? WHERE id = ?', [(comment ?? '').trim(), req.params.id]);
      return res.json({ ok: true });
    }
    if (!name?.trim() || value == null || !weight)
      return res.status(400).json({ error: 'Champs manquants' });
    if (value < 1 || value > 6) return res.status(400).json({ error: 'Note invalide (1–6)' });
    if (weight <= 0 || weight > 100) return res.status(400).json({ error: 'Poids invalide' });
    run('UPDATE grades SET name = ?, value = ?, weight = ?, comment = ? WHERE id = ?',
      [name.trim(), value, weight, (comment ?? '').trim(), req.params.id]);
    res.json({ ok: true });
  });

  // ── Future tests ──────────────────────────────────────────────────────────────
  app.post('/api/subjects/:id/future', auth, [vName, vWeight], checkValidation, (req, res) => {
    if (!ownsSubject(req.params.id, req.user.id))
      return res.status(404).json({ error: 'Matière introuvable' });
    const { name, weight, date_test, note, time_test } = req.body ?? {};
    if (!name?.trim() || !weight)
      return res.status(400).json({ error: 'Nom et poids requis' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO future_tests (subject_id, name, weight, date_test, note, time_test) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, name.trim(), weight, date_test || null, note ?? null, time_test || null]
    );
    res.status(201).json({ id, name: name.trim(), weight, date_test: date_test || null, note: note ?? null, time_test: time_test || null });
  });

  app.delete('/api/future/:id', auth, (req, res) => {
    const f = get(
      'SELECT f.id FROM future_tests f JOIN subjects s ON f.subject_id = s.id WHERE f.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!f) return res.status(404).json({ error: 'Test introuvable' });
    run('DELETE FROM future_tests WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.patch('/api/future/:id', auth, [
    vNameOpt,
    body('weight').optional().isFloat({ min: 0.1, max: 100 }).toFloat().withMessage('Poids invalide'),
    body('note').optional({ nullable: true }).isFloat({ min: 1, max: 6 }).toFloat().withMessage('Note invalide (1–6)'),
  ], checkValidation, (req, res) => {
    const f = get(
      'SELECT f.id FROM future_tests f JOIN subjects s ON f.subject_id = s.id WHERE f.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!f) return res.status(404).json({ error: 'Test introuvable' });
    const { name, weight, date_test, note, time_test } = req.body ?? {};
    if (name !== undefined || weight !== undefined) {
      if (!name?.trim() || !weight || weight <= 0)
        return res.status(400).json({ error: 'Champs invalides' });
      run('UPDATE future_tests SET name = ?, weight = ? WHERE id = ?', [name.trim(), weight, req.params.id]);
    }
    if (date_test !== undefined)
      run('UPDATE future_tests SET date_test = ? WHERE id = ?', [date_test || null, req.params.id]);
    if (note !== undefined)
      run('UPDATE future_tests SET note = ? WHERE id = ?', [note ?? null, req.params.id]);
    if (time_test !== undefined)
      run('UPDATE future_tests SET time_test = ? WHERE id = ?', [time_test || null, req.params.id]);
    res.json({ ok: true });
  });

  // ── Tests : création globale & liste à venir ──────────────────────────────────
  app.post('/api/tests', auth, (req, res) => {
    const { subject_id, date_test, time_test, weight, note, name } = req.body ?? {};
    if (!subject_id || !weight || +weight <= 0)
      return res.status(400).json({ error: 'Matière et coefficient requis' });
    const subj = get('SELECT id, name FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.user.id]);
    if (!subj) return res.status(404).json({ error: 'Matière introuvable' });
    const w = parseFloat(weight);
    if (isNaN(w) || w <= 0 || w > 100) return res.status(400).json({ error: 'Coefficient invalide (0.1–100)' });
    const n = (note != null && note !== '') ? parseFloat(note) : null;
    if (n !== null && (isNaN(n) || n < 1 || n > 6)) return res.status(400).json({ error: 'Note invalide (1–6)' });
    const testName = name?.trim() || (date_test ? `Test du ${date_test}` : 'Test');
    const { lastInsertRowid: id } = run(
      'INSERT INTO future_tests (subject_id, name, weight, date_test, note, time_test) VALUES (?, ?, ?, ?, ?, ?)',
      [subject_id, testName, w, date_test || null, n, time_test || null]
    );
    res.status(201).json(get(
      'SELECT f.*, s.name AS subject_name FROM future_tests f JOIN subjects s ON f.subject_id = s.id WHERE f.id = ?', [id]
    ));
  });

  app.get('/api/tests-upcoming', auth, (req, res) => {
    res.json(all(`
      SELECT f.*, s.name AS subject_name, s.year, s.trimester
      FROM future_tests f JOIN subjects s ON f.subject_id = s.id
      WHERE s.user_id = ? AND f.date_test IS NOT NULL AND f.date_test >= date('now')
      ORDER BY f.date_test ASC`, [req.user.id]));
  });

  // ── Projects ──────────────────────────────────────────────────────────────────
  app.get('/api/projects', auth, (req, res) => {
    const { year } = req.query;
    const rows = all(
      `SELECT * FROM projects WHERE user_id = ?
       AND (? IS NULL OR year = ?)
       ORDER BY created_at`,
      [req.user.id, year ?? null, year ?? null]
    );
    res.json(rows);
  });

  app.post('/api/projects', auth, [vName, vPeriods, vYear, vTrimester], checkValidation, (req, res) => {
    const { name, periods, year, trimester } = req.body ?? {};
    if (!name?.trim() || !periods || !year || !trimester)
      return res.status(400).json({ error: 'Champs manquants' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO projects (user_id, year, trimester, name, periods) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, year, trimester, name.trim(), periods]
    );
    res.status(201).json({ id, name: name.trim(), periods, year, trimester, success: 0 });
  });

  app.patch('/api/projects/:id', auth, [
    vNameOpt,
    body('periods').optional().isInt({ min: 1, max: 10000 }).toInt().withMessage('Périodes invalides (1–10000)'),
    body('success').optional().isBoolean().toBoolean().withMessage('success invalide'),
  ], checkValidation, (req, res) => {
    const p = get('SELECT id FROM projects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Projet introuvable' });
    if ('name' in (req.body ?? {})) {
      const { name, periods } = req.body;
      if (!name?.trim() || !periods || periods < 1)
        return res.status(400).json({ error: 'Champs invalides' });
      run('UPDATE projects SET name = ?, periods = ? WHERE id = ?', [name.trim(), +periods, req.params.id]);
    } else {
      run('UPDATE projects SET success = ? WHERE id = ?', [req.body.success ? 1 : 0, req.params.id]);
    }
    res.json({ ok: true });
  });

  app.delete('/api/projects/:id', auth, (req, res) => {
    const p = get('SELECT id FROM projects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!p) return res.status(404).json({ error: 'Projet introuvable' });
    run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ── Culture Générale ──────────────────────────────────────────────────────────
  app.get('/api/cg', auth, (req, res) => {
    const { year } = req.query;
    const subjects = all(
      'SELECT * FROM cg_subjects WHERE user_id = ? AND (? IS NULL OR year = ?) ORDER BY name',
      [req.user.id, year ?? null, year ?? null]
    );
    for (const s of subjects) {
      s.tests        = all('SELECT * FROM cg_tests        WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
      s.futures      = all('SELECT * FROM cg_futures      WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
      s.petits_tests = all('SELECT * FROM cg_petits_tests WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
    }
    res.json(subjects);
  });

  app.post('/api/cg/subjects', auth, [vName, vYear], checkValidation, (req, res) => {
    const { name, year } = req.body ?? {};
    if (!name?.trim() || !year) return res.status(400).json({ error: 'Nom et année requis' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO cg_subjects (user_id, year, name) VALUES (?, ?, ?)',
      [req.user.id, year, name.trim()]
    );
    res.status(201).json({ id, year: +year, name: name.trim(), tests: [], futures: [], petits_tests: [] });
  });

  app.delete('/api/cg/subjects/:id', auth, (req, res) => {
    const s = get('SELECT id FROM cg_subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!s) return res.status(404).json({ error: 'Matière introuvable' });
    run('DELETE FROM cg_subjects WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.patch('/api/cg/subjects/:id', auth, [
    vNameOpt,
    body('target_s1').optional().isFloat({ min: 1, max: 6 }).toFloat().withMessage('Objectif S1 invalide (1–6)'),
    body('target_s2').optional().isFloat({ min: 1, max: 6 }).toFloat().withMessage('Objectif S2 invalide (1–6)'),
  ], checkValidation, (req, res) => {
    const s = get('SELECT id FROM cg_subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!s) return res.status(404).json({ error: 'Matière introuvable' });
    const body = req.body ?? {};
    if ('target_s1' in body || 'target_s2' in body) {
      const key = 'target_s1' in body ? 'target_s1' : 'target_s2';
      const t = parseFloat(body[key]);
      if (isNaN(t) || t < 1 || t > 6) return res.status(400).json({ error: 'Objectif invalide (1–6)' });
      const safeCol = key === 'target_s1' ? 'target_s1' : 'target_s2';
      run(`UPDATE cg_subjects SET ${safeCol} = ? WHERE id = ?`, [t, req.params.id]);
    } else {
      if (!body.name?.trim()) return res.status(400).json({ error: 'Nom requis' });
      run('UPDATE cg_subjects SET name = ? WHERE id = ?', [body.name.trim(), req.params.id]);
    }
    res.json({ ok: true });
  });

  app.post('/api/cg/subjects/:id/tests', auth, [vSemester, vName, vObt, vTot, vComment], checkValidation, (req, res) => {
    const s = get('SELECT id FROM cg_subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!s) return res.status(404).json({ error: 'Matière introuvable' });
    const { semester, name, points_obtained, points_total, comment = '' } = req.body ?? {};
    if (!name?.trim() || !semester || points_obtained == null || !points_total)
      return res.status(400).json({ error: 'Champs manquants' });
    if (points_obtained < 0 || points_obtained > points_total)
      return res.status(400).json({ error: 'Points obtenus invalides' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO cg_tests (cg_subject_id, semester, name, points_obtained, points_total, comment) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, semester, name.trim(), points_obtained, points_total, comment.trim()]
    );
    res.status(201).json({ id, cg_subject_id: +req.params.id, semester: +semester, name: name.trim(), points_obtained: +points_obtained, points_total: +points_total, comment: comment.trim() });
  });

  app.delete('/api/cg/tests/:id', auth, (req, res) => {
    const t = get(
      'SELECT t.id FROM cg_tests t JOIN cg_subjects s ON t.cg_subject_id = s.id WHERE t.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!t) return res.status(404).json({ error: 'Test introuvable' });
    run('DELETE FROM cg_tests WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.patch('/api/cg/tests/:id', auth, [
    vNameOpt,
    body('points_obtained').optional().isFloat({ min: 0 }).toFloat().withMessage('Points obtenus invalides (≥ 0)'),
    body('points_total').optional().isFloat({ min: 0.1 }).toFloat().withMessage('Points totaux invalides (> 0)'),
    vComment,
  ], checkValidation, (req, res) => {
    const t = get(
      'SELECT t.id FROM cg_tests t JOIN cg_subjects s ON t.cg_subject_id = s.id WHERE t.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!t) return res.status(404).json({ error: 'Test introuvable' });
    const { name, points_obtained, points_total, comment } = req.body ?? {};
    if (comment !== undefined && name === undefined) {
      run('UPDATE cg_tests SET comment = ? WHERE id = ?', [(comment ?? '').trim(), req.params.id]);
      return res.json({ ok: true });
    }
    if (!name?.trim() || points_obtained == null || !points_total)
      return res.status(400).json({ error: 'Champs manquants' });
    if (points_obtained < 0 || points_obtained > points_total)
      return res.status(400).json({ error: 'Points invalides' });
    run('UPDATE cg_tests SET name = ?, points_obtained = ?, points_total = ?, comment = ? WHERE id = ?',
      [name.trim(), points_obtained, points_total, (comment ?? '').trim(), req.params.id]);
    res.json({ ok: true });
  });

  app.post('/api/cg/subjects/:id/futures', auth, [
    vSemester, vName,
    body('is_petit_test').optional().isInt({ min: 0, max: 1 }).toInt().withMessage('is_petit_test invalide (0 ou 1)'),
  ], checkValidation, (req, res) => {
    const s = get('SELECT id FROM cg_subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!s) return res.status(404).json({ error: 'Matière introuvable' });
    const { semester, name, is_petit_test = 0 } = req.body ?? {};
    if (!name?.trim() || !semester) return res.status(400).json({ error: 'Champs manquants' });
    const isPetit = is_petit_test ? 1 : 0;
    const { lastInsertRowid: id } = run(
      'INSERT INTO cg_futures (cg_subject_id, semester, name, is_petit_test) VALUES (?, ?, ?, ?)',
      [req.params.id, semester, name.trim(), isPetit]
    );
    res.status(201).json({ id, cg_subject_id: +req.params.id, semester: +semester, name: name.trim(), is_petit_test: isPetit });
  });

  app.post('/api/cg/subjects/:id/small-tests', auth, [vSemester, vName, vObt, vTot, vComment], checkValidation, (req, res) => {
    const s = get('SELECT id FROM cg_subjects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!s) return res.status(404).json({ error: 'Matière introuvable' });
    const { semester, name, points_obtained, points_total, comment = '' } = req.body ?? {};
    if (!name?.trim() || !semester || points_obtained == null || !points_total)
      return res.status(400).json({ error: 'Champs manquants' });
    if (points_obtained < 0 || points_obtained > points_total)
      return res.status(400).json({ error: 'Points obtenus invalides' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO cg_petits_tests (cg_subject_id, semester, name, points_obtained, points_total, comment) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, semester, name.trim(), points_obtained, points_total, comment.trim()]
    );
    res.status(201).json({ id, cg_subject_id: +req.params.id, semester: +semester, name: name.trim(), points_obtained: +points_obtained, points_total: +points_total, comment: comment.trim() });
  });

  app.delete('/api/cg/small-tests/:id', auth, (req, res) => {
    const t = get(
      'SELECT t.id FROM cg_petits_tests t JOIN cg_subjects s ON t.cg_subject_id = s.id WHERE t.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!t) return res.status(404).json({ error: 'Test introuvable' });
    run('DELETE FROM cg_petits_tests WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.patch('/api/cg/small-tests/:id', auth, [
    vNameOpt,
    body('points_obtained').optional().isFloat({ min: 0 }).toFloat().withMessage('Points obtenus invalides (≥ 0)'),
    body('points_total').optional().isFloat({ min: 0.1 }).toFloat().withMessage('Points totaux invalides (> 0)'),
    vComment,
  ], checkValidation, (req, res) => {
    const t = get(
      'SELECT t.id FROM cg_petits_tests t JOIN cg_subjects s ON t.cg_subject_id = s.id WHERE t.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!t) return res.status(404).json({ error: 'Test introuvable' });
    const { name, points_obtained, points_total, comment } = req.body ?? {};
    if (comment !== undefined && name === undefined) {
      run('UPDATE cg_petits_tests SET comment = ? WHERE id = ?', [(comment ?? '').trim(), req.params.id]);
      return res.json({ ok: true });
    }
    if (!name?.trim() || points_obtained == null || !points_total)
      return res.status(400).json({ error: 'Champs manquants' });
    if (points_obtained < 0 || points_obtained > points_total)
      return res.status(400).json({ error: 'Points invalides' });
    run('UPDATE cg_petits_tests SET name = ?, points_obtained = ?, points_total = ?, comment = ? WHERE id = ?',
      [name.trim(), points_obtained, points_total, (comment ?? '').trim(), req.params.id]);
    res.json({ ok: true });
  });

  app.delete('/api/cg/futures/:id', auth, (req, res) => {
    const f = get(
      'SELECT f.id FROM cg_futures f JOIN cg_subjects s ON f.cg_subject_id = s.id WHERE f.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!f) return res.status(404).json({ error: 'Test introuvable' });
    run('DELETE FROM cg_futures WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.patch('/api/cg/futures/:id', auth, [vName], checkValidation, (req, res) => {
    const f = get(
      'SELECT f.id FROM cg_futures f JOIN cg_subjects s ON f.cg_subject_id = s.id WHERE f.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!f) return res.status(404).json({ error: 'Test introuvable' });
    const { name } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
    run('UPDATE cg_futures SET name = ? WHERE id = ?', [name.trim(), req.params.id]);
    res.json({ ok: true });
  });

  // ── Agenda : Matières ────────────────────────────────────────────────────────
  app.get('/api/matieres', auth, (req, res) => {
    res.json(all('SELECT * FROM matieres WHERE user_id = ? ORDER BY nom', [req.user.id]));
  });

  app.post('/api/matieres', auth, (req, res) => {
    const { nom, couleur, date_debut, date_fin } = req.body ?? {};
    if (!nom?.trim()) return res.status(400).json({ error: 'Nom requis' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO matieres (user_id, nom, couleur, date_debut, date_fin) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, nom.trim(), couleur || '#6366f1', date_debut || null, date_fin || null]
    );
    res.status(201).json(get('SELECT * FROM matieres WHERE id = ?', [id]));
  });

  app.put('/api/matieres/:id', auth, (req, res) => {
    const m = get('SELECT * FROM matieres WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!m) return res.status(404).json({ error: 'Matière non trouvée' });
    const { nom, couleur, date_debut, date_fin } = req.body ?? {};
    run('UPDATE matieres SET nom = ?, couleur = ?, date_debut = ?, date_fin = ? WHERE id = ?', [
      nom ?? m.nom, couleur ?? m.couleur,
      date_debut !== undefined ? (date_debut || null) : m.date_debut,
      date_fin   !== undefined ? (date_fin   || null) : m.date_fin,
      req.params.id
    ]);
    res.json(get('SELECT * FROM matieres WHERE id = ?', [req.params.id]));
  });

  app.delete('/api/matieres/:id', auth, (req, res) => {
    const m = get('SELECT id FROM matieres WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!m) return res.status(404).json({ error: 'Matière non trouvée' });
    run('DELETE FROM creneaux WHERE matiere_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    run('UPDATE devoirs SET matiere_id = NULL WHERE matiere_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    run('DELETE FROM matieres WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ── Agenda : Créneaux ─────────────────────────────────────────────────────────
  const creneauxWithMatiere = `
    SELECT c.*, m.nom AS matiere_nom, m.couleur AS matiere_couleur
    FROM creneaux c LEFT JOIN matieres m ON c.matiere_id = m.id`;

  app.get('/api/creneaux', auth, (req, res) => {
    res.json(all(creneauxWithMatiere + ' WHERE c.user_id = ? ORDER BY c.jour, c.heure_debut', [req.user.id]));
  });

  app.post('/api/creneaux', auth, (req, res) => {
    const { matiere_id, jour, heure_debut, heure_fin, salle } = req.body ?? {};
    if (jour === undefined || !heure_debut || !heure_fin || !matiere_id)
      return res.status(400).json({ error: 'Champs requis manquants' });
    if (typeof jour !== 'number' || jour < 0 || jour > 6)
      return res.status(400).json({ error: 'Jour invalide (0=lundi … 6=dimanche)' });
    if (heure_debut >= heure_fin)
      return res.status(400).json({ error: 'L\'heure de début doit être avant la fin' });
    if (!get('SELECT id FROM matieres WHERE id = ? AND user_id = ?', [matiere_id, req.user.id]))
      return res.status(400).json({ error: 'Matière invalide' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO creneaux (user_id, matiere_id, jour, heure_debut, heure_fin, salle) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, matiere_id, jour, heure_debut, heure_fin, salle || null]
    );
    res.status(201).json(get(creneauxWithMatiere + ' WHERE c.id = ?', [id]));
  });

  app.put('/api/creneaux/:id', auth, (req, res) => {
    const c = get('SELECT * FROM creneaux WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!c) return res.status(404).json({ error: 'Créneau non trouvé' });
    const { matiere_id, jour, heure_debut, heure_fin, salle } = req.body ?? {};
    run('UPDATE creneaux SET matiere_id = ?, jour = ?, heure_debut = ?, heure_fin = ?, salle = ? WHERE id = ?', [
      matiere_id ?? c.matiere_id, jour ?? c.jour,
      heure_debut || c.heure_debut, heure_fin || c.heure_fin,
      salle !== undefined ? salle : c.salle,
      req.params.id
    ]);
    res.json(get(creneauxWithMatiere + ' WHERE c.id = ?', [req.params.id]));
  });

  app.delete('/api/creneaux/:id', auth, (req, res) => {
    const c = get('SELECT id FROM creneaux WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!c) return res.status(404).json({ error: 'Créneau non trouvé' });
    run('DELETE FROM creneaux WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ── Agenda : Devoirs ──────────────────────────────────────────────────────────
  const devoirsWithMatiere = `
    SELECT d.*, m.nom AS matiere_nom, m.couleur AS matiere_couleur
    FROM devoirs d LEFT JOIN matieres m ON d.matiere_id = m.id`;

  app.get('/api/devoirs', auth, (req, res) => {
    res.json(all(
      devoirsWithMatiere + ` WHERE d.user_id = ?
      ORDER BY CASE WHEN d.deadline IS NULL THEN 1 ELSE 0 END, d.deadline ASC, d.created_at DESC`,
      [req.user.id]
    ));
  });

  const VALID_STATUTS  = ['todo', 'inprogress', 'done'];
  const VALID_PRIORITES = ['basse', 'moyenne', 'haute'];

  app.post('/api/devoirs', auth, (req, res) => {
    const { titre, matiere_id, description, deadline, priorite, statut } = req.body ?? {};
    if (!titre?.trim()) return res.status(400).json({ error: 'Titre requis' });
    if (priorite !== undefined && !VALID_PRIORITES.includes(priorite))
      return res.status(400).json({ error: "Priorité invalide (basse, moyenne, haute)" });
    if (statut !== undefined && !VALID_STATUTS.includes(statut))
      return res.status(400).json({ error: "Statut invalide (todo, inprogress, done)" });
    const cleanPrio   = priorite  ?? 'moyenne';
    const cleanStatut = statut    ?? 'todo';
    const { lastInsertRowid: id } = run(
      'INSERT INTO devoirs (user_id, matiere_id, titre, description, deadline, priorite, statut) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, matiere_id || null, titre.trim(), description || null,
       deadline || null, cleanPrio, cleanStatut]
    );
    res.status(201).json(get(devoirsWithMatiere + ' WHERE d.id = ?', [id]));
  });

  app.put('/api/devoirs/:id', auth, (req, res) => {
    const d = get('SELECT * FROM devoirs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!d) return res.status(404).json({ error: 'Devoir non trouvé' });
    const { titre, matiere_id, description, deadline, priorite, statut } = req.body ?? {};
    if (statut !== undefined && !VALID_STATUTS.includes(statut))
      return res.status(400).json({ error: 'Statut invalide (todo, inprogress, done)' });
    if (priorite !== undefined && !VALID_PRIORITES.includes(priorite))
      return res.status(400).json({ error: 'Priorité invalide (basse, moyenne, haute)' });
    run(`UPDATE devoirs SET titre = ?, matiere_id = ?, description = ?, deadline = ?, priorite = ?, statut = ? WHERE id = ?`, [
      titre     ?? d.titre,
      matiere_id !== undefined ? (matiere_id || null) : d.matiere_id,
      description !== undefined ? description : d.description,
      deadline    !== undefined ? (deadline || null) : d.deadline,
      priorite  ?? d.priorite,
      statut    ?? d.statut,
      req.params.id
    ]);
    res.json(get(devoirsWithMatiere + ' WHERE d.id = ?', [req.params.id]));
  });

  app.delete('/api/devoirs/:id', auth, (req, res) => {
    const d = get('SELECT id FROM devoirs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!d) return res.status(404).json({ error: 'Devoir non trouvé' });
    run('DELETE FROM devoirs WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // ── Agenda : Stats ────────────────────────────────────────────────────────────
  app.get('/api/stats-agenda', auth, (req, res) => {
    const uid = req.user.id;
    const devoirsParMatiere = all(`
      SELECT COALESCE(m.nom,'Sans matière') AS nom, COALESCE(m.couleur,'#64748b') AS couleur,
             COUNT(*) AS total,
             SUM(CASE WHEN d.statut='done' THEN 1 ELSE 0 END) AS done
      FROM devoirs d LEFT JOIN matieres m ON d.matiere_id = m.id
      WHERE d.user_id = ? GROUP BY d.matiere_id ORDER BY total DESC`, [uid]);

    const chargeParSemaine = all(`
      SELECT strftime('%Y-%W', deadline) AS semaine, MIN(deadline) AS debut_semaine,
             COUNT(*) AS total, SUM(CASE WHEN statut='done' THEN 1 ELSE 0 END) AS done
      FROM devoirs
      WHERE user_id = ? AND deadline IS NOT NULL
        AND deadline >= date('now','-42 days') AND deadline <= date('now','+84 days')
      GROUP BY semaine ORDER BY semaine`, [uid]);

    const global = get(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN statut='todo'       THEN 1 ELSE 0 END) AS todo,
             SUM(CASE WHEN statut='inprogress' THEN 1 ELSE 0 END) AS inprogress,
             SUM(CASE WHEN statut='done'       THEN 1 ELSE 0 END) AS done,
             SUM(CASE WHEN deadline < date('now') AND statut != 'done' THEN 1 ELSE 0 END) AS en_retard
      FROM devoirs WHERE user_id = ?`, [uid]);

    res.json({ devoirsParMatiere, chargeParSemaine, global });
  });

  // ── Support tickets ──────────────────────────────────────────────────────────
  app.post('/api/support', auth, (req, res) => {
    const { type, titre, description } = req.body ?? {};
    if (!['bug', 'suggestion'].includes(type))
      return res.status(400).json({ error: 'Type invalide (bug ou suggestion)' });
    if (!titre?.trim() || titre.trim().length > 150)
      return res.status(400).json({ error: 'Titre requis (1–150 caractères)' });
    if (!description?.trim() || description.trim().length > 2000)
      return res.status(400).json({ error: 'Description requise (1–2000 caractères)' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO tickets (user_id, type, titre, description) VALUES (?, ?, ?, ?)',
      [req.user.id, type, titre.trim(), description.trim()]
    );
    const u = get('SELECT username FROM users WHERE id = ?', [req.user.id]);
    sendNotificationEmail({ type, titre: titre.trim(), description: description.trim(), username: u?.username || '?' })
      .catch(e => console.error('Email error:', e.message));
    res.status(201).json({ ok: true, id });
  });

  // ── Export PDF ────────────────────────────────────────────────────────────────
  app.get('/api/export/pdf', auth, (req, res) => {
    const uid = req.user.id;
    const { year, trimester } = req.query;

    // ── Fetch data ──
    const subjects = all(
      `SELECT * FROM subjects WHERE user_id = ?
       AND (? IS NULL OR year = ?) AND (? IS NULL OR trimester = ?)
       ORDER BY name`,
      [uid, year ?? null, year ?? null, trimester ?? null, trimester ?? null]
    );
    for (const s of subjects) {
      s.grades  = all('SELECT * FROM grades       WHERE subject_id = ? ORDER BY created_at', [s.id]);
      s.futures = all('SELECT * FROM future_tests WHERE subject_id = ? ORDER BY created_at', [s.id]);
    }

    const cgSubjects = all(
      'SELECT * FROM cg_subjects WHERE user_id = ? AND (? IS NULL OR year = ?) ORDER BY name',
      [uid, year ?? null, year ?? null]
    );
    for (const s of cgSubjects) {
      s.tests        = all('SELECT * FROM cg_tests        WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
      s.futures      = all('SELECT * FROM cg_futures      WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
      s.petits_tests = all('SELECT * FROM cg_petits_tests WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
    }

    const projects = all(
      `SELECT * FROM projects WHERE user_id = ?
       AND (? IS NULL OR year = ?)
       ORDER BY created_at`,
      [uid, year ?? null, year ?? null]
    );

    // ── Business logic (mirrors frontend) ──
    function calcSubjectAvg(grades, futures) {
      if (!grades.length) return null;
      const curSum = grades.reduce((s, g) => s + g.value * g.weight, 0);
      const curW   = grades.reduce((s, g) => s + g.weight, 0);
      if (curW === 0) return null;
      return curSum / curW;
    }

    function cgGrade(t) {
      return (t.points_obtained / t.points_total) * 5 + 1;
    }

    function calcCGSemAvg(tests, petitsTests) {
      const ptAvg = petitsTests.length
        ? petitsTests.reduce((s, t) => s + cgGrade(t), 0) / petitsTests.length
        : null;
      const curSum = tests.reduce((s, t) => s + cgGrade(t), 0) + (ptAvg ?? 0);
      const curN   = tests.length + (ptAvg !== null ? 1 : 0);
      return curN > 0 ? curSum / curN : null;
    }

    function cgSubjectAvgs(s) {
      const t1 = s.tests.filter(t => t.semester === 1);
      const t2 = s.tests.filter(t => t.semester === 2);
      const p1 = s.petits_tests.filter(t => t.semester === 1);
      const p2 = s.petits_tests.filter(t => t.semester === 2);
      const s1Avg = calcCGSemAvg(t1, p1);
      const s2Avg = calcCGSemAvg(t2, p2);
      let annAvg = null;
      if (s1Avg !== null && s2Avg !== null) annAvg = (s1Avg + s2Avg) / 2;
      else if (s1Avg !== null) annAvg = s1Avg;
      else if (s2Avg !== null) annAvg = s2Avg;
      return { s1Avg, s2Avg, annAvg };
    }

    const mean = arr => { const f = arr.filter(v => v !== null); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null; };
    const fmt  = v => v !== null && v !== undefined ? v.toFixed(2) : '—';

    const subjectAvgsList = subjects.map(s => calcSubjectAvg(s.grades, s.futures));
    const globalSubj = mean(subjectAvgsList);
    const cgAvgsList = cgSubjects.map(s => cgSubjectAvgs(s));
    const cgS1 = mean(cgAvgsList.map(a => a.s1Avg));
    const cgS2 = mean(cgAvgsList.map(a => a.s2Avg));
    const totPer = projects.reduce((s, p) => s + p.periods, 0);
    const valPer = projects.filter(p => p.success).reduce((s, p) => s + p.periods, 0);
    const projPct = totPer > 0 ? valPer / totPer * 100 : null;

    // ── Build PDF ──
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    const yearLabel = year ? `Année ${year}` : 'Toutes années';
    const trimLabel = trimester ? ` · Trimestre ${trimester}` : '';
    res.setHeader('Content-Disposition', `attachment; filename="notes_${year || 'all'}_T${trimester || 'all'}.pdf"`);
    doc.pipe(res);

    const PURPLE = '#7c3aed';
    const GREEN  = '#059669';
    const RED    = '#dc2626';
    const ORANGE = '#ea580c';
    const GRAY   = '#6b7280';
    const LIGHT  = '#f3f4f6';
    const W      = doc.page.width - 100; // usable width

    function gradeColor(v) {
      if (v === null) return GRAY;
      return v >= 4 ? GREEN : v >= 3.5 ? ORANGE : RED;
    }

    // ── Title ──
    doc.fontSize(22).font('Helvetica-Bold').fillColor(PURPLE).text('Relevé de Notes', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').fillColor(GRAY).text(`${yearLabel}${trimLabel}  ·  ${new Date().toLocaleDateString('fr-CH')}`, { align: 'center' });
    doc.moveDown(1);

    // ── Dashboard summary ──
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827').text('Tableau de bord', { underline: false });
    doc.moveDown(0.4);

    const stats = [
      { label: 'Moyenne Matières', value: fmt(globalSubj), color: gradeColor(globalSubj) },
      { label: 'CG · Semestre 1',  value: fmt(cgS1),       color: gradeColor(cgS1) },
      { label: 'CG · Semestre 2',  value: fmt(cgS2),       color: gradeColor(cgS2) },
      { label: 'Projets',          value: projPct !== null ? projPct.toFixed(1) + '%' : '—', color: projPct === null ? GRAY : projPct >= 80 ? GREEN : projPct >= 60 ? ORANGE : RED },
    ];
    const colW = W / 4;
    const rowY = doc.y;
    stats.forEach((st, i) => {
      const x = 50 + i * colW;
      doc.rect(x, rowY, colW - 6, 52).fill(LIGHT).stroke('#e5e7eb');
      doc.fontSize(8).font('Helvetica').fillColor(GRAY).text(st.label, x + 6, rowY + 6, { width: colW - 12 });
      doc.fontSize(18).font('Helvetica-Bold').fillColor(st.color).text(st.value, x + 6, rowY + 20, { width: colW - 12 });
    });
    doc.y = rowY + 62;
    doc.moveDown(1);

    // ── Subjects ──
    if (subjects.length) {
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827').text('Matières');
      doc.moveDown(0.5);

      subjects.forEach((s, si) => {
        const avg = subjectAvgsList[si];
        const avgTxt = avg !== null ? avg.toFixed(2) : '—';
        const col = gradeColor(avg);

        // Subject header bar
        const hy = doc.y;
        doc.rect(50, hy, W, 22).fill('#f9fafb').stroke('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(s.name, 56, hy + 6, { width: W - 70 });
        doc.fontSize(10).font('Helvetica-Bold').fillColor(col).text(avgTxt, 50, hy + 6, { width: W, align: 'right' });
        doc.y = hy + 26;

        if (s.grades.length) {
          // Table header
          const th = doc.y;
          doc.rect(50, th, W, 16).fill('#e5e7eb');
          doc.fontSize(7.5).font('Helvetica-Bold').fillColor(GRAY)
            .text('Évaluation', 56, th + 4, { width: W * 0.5 })
            .text('Note', 50 + W * 0.5, th + 4, { width: W * 0.15, align: 'center' })
            .text('Poids', 50 + W * 0.65, th + 4, { width: W * 0.15, align: 'center' })
            .text('Commentaire', 50 + W * 0.8, th + 4, { width: W * 0.2 });
          doc.y = th + 20;

          s.grades.forEach((g, gi) => {
            if (doc.y > doc.page.height - 80) doc.addPage();
            const gy = doc.y;
            const rowBg = gi % 2 === 0 ? '#ffffff' : '#f9fafb';
            doc.rect(50, gy, W, 15).fill(rowBg).stroke('#f3f4f6');
            doc.fontSize(8).font('Helvetica').fillColor('#374151')
              .text(g.name, 56, gy + 3.5, { width: W * 0.5 - 6 });
            doc.fontSize(8).font('Helvetica-Bold').fillColor(gradeColor(g.value))
              .text(g.value.toFixed(1), 50 + W * 0.5, gy + 3.5, { width: W * 0.15, align: 'center' });
            doc.fontSize(8).font('Helvetica').fillColor(GRAY)
              .text(g.weight + '%', 50 + W * 0.65, gy + 3.5, { width: W * 0.15, align: 'center' });
            if (g.comment) {
              doc.fontSize(7).font('Helvetica').fillColor(GRAY)
                .text(g.comment, 50 + W * 0.8, gy + 3.5, { width: W * 0.2 });
            }
            doc.y = gy + 18;
          });
        } else {
          doc.fontSize(8.5).font('Helvetica').fillColor(GRAY).text('  Aucune note', 56, doc.y);
          doc.moveDown(0.5);
        }

        if (s.futures.length) {
          doc.fontSize(8).font('Helvetica-Bold').fillColor(ORANGE).text(`  Tests à venir : ${s.futures.map(f => f.name + ' (' + f.weight + '%)').join(', ')}`, 56, doc.y);
          doc.moveDown(0.4);
        }
        doc.moveDown(0.5);
      });
    }

    // ── Culture Générale ──
    if (cgSubjects.length) {
      if (doc.y > doc.page.height - 150) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827').text('Culture Générale');
      doc.moveDown(0.5);

      cgSubjects.forEach(s => {
        const { s1Avg, s2Avg, annAvg } = cgSubjectAvgs(s);
        if (doc.y > doc.page.height - 80) doc.addPage();
        const hy = doc.y;
        doc.rect(50, hy, W, 22).fill('#f9fafb').stroke('#e5e7eb');
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(s.name, 56, hy + 6, { width: W * 0.5 });
        const avgLine = `S1: ${fmt(s1Avg)}  S2: ${fmt(s2Avg)}  Ann.: ${fmt(annAvg)}`;
        doc.fontSize(9).font('Helvetica').fillColor(gradeColor(annAvg)).text(avgLine, 56 + W * 0.5, hy + 7, { width: W * 0.5, align: 'right' });
        doc.y = hy + 26;

        [1, 2].forEach(sem => {
          const semTests = s.tests.filter(t => t.semester === sem);
          const semPetits = s.petits_tests.filter(t => t.semester === sem);
          const semFutures = s.futures.filter(t => t.semester === sem);
          if (!semTests.length && !semPetits.length && !semFutures.length) return;

          doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY).text(`  Semestre ${sem}`, 56, doc.y);
          doc.moveDown(0.3);

          [...semTests.map(t => ({ ...t, kind: 'test' })), ...semPetits.map(t => ({ ...t, kind: 'petit' }))].forEach((t, ti) => {
            if (doc.y > doc.page.height - 50) doc.addPage();
            const grade = cgGrade(t);
            const gy = doc.y;
            const rowBg = ti % 2 === 0 ? '#ffffff' : '#f9fafb';
            doc.rect(50, gy, W, 14).fill(rowBg).stroke('#f3f4f6');
            const kindLabel = t.kind === 'petit' ? '[Petit] ' : '';
            doc.fontSize(7.5).font('Helvetica').fillColor('#374151')
              .text(`    ${kindLabel}${t.name}`, 56, gy + 3, { width: W * 0.55 });
            doc.fontSize(7.5).font('Helvetica').fillColor(GRAY)
              .text(`${t.points_obtained}/${t.points_total}`, 50 + W * 0.55, gy + 3, { width: W * 0.2, align: 'center' });
            doc.fontSize(7.5).font('Helvetica-Bold').fillColor(gradeColor(grade))
              .text(grade.toFixed(2), 50 + W * 0.75, gy + 3, { width: W * 0.25, align: 'right' });
            doc.y = gy + 17;
          });

          if (semFutures.length) {
            doc.fontSize(7.5).font('Helvetica').fillColor(ORANGE)
              .text(`    À venir : ${semFutures.map(f => f.name).join(', ')}`, 56, doc.y);
            doc.moveDown(0.3);
          }
        });
        doc.moveDown(0.5);
      });
    }

    // ── Projets ──
    if (projects.length) {
      if (doc.y > doc.page.height - 150) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#111827').text('Projets');
      doc.moveDown(0.5);

      // Header
      const ph = doc.y;
      doc.rect(50, ph, W, 16).fill('#e5e7eb');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(GRAY)
        .text('Nom du projet', 56, ph + 4, { width: W * 0.45 })
        .text('Trimestre', 50 + W * 0.45, ph + 4, { width: W * 0.15, align: 'center' })
        .text('Périodes', 50 + W * 0.6,  ph + 4, { width: W * 0.2,  align: 'center' })
        .text('Statut',   50 + W * 0.8,  ph + 4, { width: W * 0.2,  align: 'center' });
      doc.y = ph + 20;

      projects.forEach((p, pi) => {
        if (doc.y > doc.page.height - 50) doc.addPage();
        const gy = doc.y;
        const rowBg = pi % 2 === 0 ? '#ffffff' : '#f9fafb';
        doc.rect(50, gy, W, 15).fill(rowBg).stroke('#f3f4f6');
        doc.fontSize(8).font('Helvetica').fillColor('#374151')
          .text(p.name, 56, gy + 3.5, { width: W * 0.45 - 6 });
        doc.fontSize(8).font('Helvetica').fillColor(GRAY)
          .text(`T${p.trimester}`, 50 + W * 0.45, gy + 3.5, { width: W * 0.15, align: 'center' });
        doc.fontSize(8).font('Helvetica').fillColor(GRAY)
          .text(String(p.periods), 50 + W * 0.6, gy + 3.5, { width: W * 0.2, align: 'center' });
        const statusTxt = p.success ? 'Réussi' : 'Non réussi';
        const statusCol = p.success ? GREEN : RED;
        doc.fontSize(8).font('Helvetica-Bold').fillColor(statusCol)
          .text(statusTxt, 50 + W * 0.8, gy + 3.5, { width: W * 0.2, align: 'center' });
        doc.y = gy + 18;
      });

      doc.moveDown(0.5);
      const succCount = projects.filter(p => p.success).length;
      doc.fontSize(8.5).font('Helvetica').fillColor(GRAY)
        .text(`${succCount} projet(s) réussi(s) sur ${projects.length}  ·  ${totPer > 0 ? projPct.toFixed(1) + '%' : '—'} des périodes validées`, { align: 'right' });
    }

    // ── Footer ──
    const pages = doc.bufferedPageRange ? doc.bufferedPageRange() : null;
    doc.fontSize(8).font('Helvetica').fillColor(GRAY);
    doc.text(`Exporté le ${new Date().toLocaleDateString('fr-CH')} depuis Notes Scolaires`, 50, doc.page.height - 40, { align: 'center', width: W });

    doc.end();
  });

  // ── Export JSON ───────────────────────────────────────────────────────────────
  app.get('/api/export/json', auth, (req, res) => {
    const uid = req.user.id;

    const subjects = all('SELECT id, year, trimester, name, target FROM subjects WHERE user_id = ? ORDER BY year, trimester, name', [uid]);
    for (const s of subjects) {
      s.grades  = all('SELECT name, value, weight, comment FROM grades       WHERE subject_id = ? ORDER BY created_at', [s.id]);
      s.futures = all('SELECT name, weight               FROM future_tests   WHERE subject_id = ? ORDER BY created_at', [s.id]);
      delete s.id;
    }

    const projects = all('SELECT year, trimester, name, periods, success FROM projects WHERE user_id = ? ORDER BY year, trimester', [uid]);

    const cgSubjects = all('SELECT id, year, name, target_s1, target_s2 FROM cg_subjects WHERE user_id = ? ORDER BY year, name', [uid]);
    for (const s of cgSubjects) {
      s.tests        = all('SELECT semester, name, points_obtained, points_total, comment FROM cg_tests        WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
      s.futures      = all('SELECT semester, name                                         FROM cg_futures      WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
      s.petits_tests = all('SELECT semester, name, points_obtained, points_total, comment FROM cg_petits_tests WHERE cg_subject_id = ? ORDER BY semester, created_at', [s.id]);
      delete s.id;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="notes_${new Date().toISOString().slice(0,10)}.json"`);
    res.json({ subjects, projects, cg_subjects: cgSubjects });
  });

  // ── Import JSON ───────────────────────────────────────────────────────────────
  app.post('/api/import/json', auth, (req, res) => {
    const uid = req.user.id;
    const { subjects = [], projects = [], cg_subjects = [] } = req.body ?? {};

    if (!Array.isArray(subjects) || !Array.isArray(projects) || !Array.isArray(cg_subjects))
      return res.status(400).json({ error: 'Format JSON invalide' });

    const doImport = db.transaction(() => {
      db.prepare('DELETE FROM subjects    WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM projects    WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM cg_subjects WHERE user_id = ?').run(uid);

      const ins = (sql, params) => db.prepare(sql).run(...params).lastInsertRowid;

      for (const s of subjects) {
        const sid = ins(
          'INSERT INTO subjects (user_id, year, trimester, name, target) VALUES (?,?,?,?,?)',
          [uid, s.year, s.trimester, s.name, s.target ?? 4.0]
        );
        for (const g of (s.grades  ?? [])) db.prepare('INSERT INTO grades       (subject_id, name, value, weight, comment) VALUES (?,?,?,?,?)').run(sid, g.name, g.value, g.weight, g.comment ?? '');
        for (const f of (s.futures ?? [])) db.prepare('INSERT INTO future_tests (subject_id, name, weight)           VALUES (?,?,?)').run(sid, f.name, f.weight);
      }

      for (const p of projects)
        db.prepare('INSERT INTO projects (user_id, year, trimester, name, periods, success) VALUES (?,?,?,?,?,?)').run(uid, p.year, p.trimester, p.name, p.periods, p.success ?? 0);

      for (const s of cg_subjects) {
        const sid = ins(
          'INSERT INTO cg_subjects (user_id, year, name, target_s1, target_s2) VALUES (?,?,?,?,?)',
          [uid, s.year, s.name, s.target_s1 ?? 4.0, s.target_s2 ?? 4.0]
        );
        for (const t  of (s.tests        ?? [])) db.prepare('INSERT INTO cg_tests        (cg_subject_id, semester, name, points_obtained, points_total, comment) VALUES (?,?,?,?,?,?)').run(sid, t.semester,  t.name, t.points_obtained, t.points_total, t.comment ?? '');
        for (const f  of (s.futures      ?? [])) db.prepare('INSERT INTO cg_futures      (cg_subject_id, semester, name)                                        VALUES (?,?,?)').run(sid, f.semester,  f.name);
        for (const pt of (s.petits_tests ?? [])) db.prepare('INSERT INTO cg_petits_tests (cg_subject_id, semester, name, points_obtained, points_total, comment) VALUES (?,?,?,?,?,?)').run(sid, pt.semester, pt.name, pt.points_obtained, pt.points_total, pt.comment ?? '');
      }
    });

    try {
      doImport();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: 'Import invalide : ' + e.message });
    }
  });

  // ── Admin middleware ──────────────────────────────────────────────────────────
  function isAdmin(req, res, next) {
    const header = req.headers.authorization;
    // Support both Bearer token (API calls) and query param (page load check)
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(403).json({ error: 'Accès refusé' });
    try {
      const payload = jwt.verify(token, SECRET);
      const u = get('SELECT role, banned FROM users WHERE id = ?', [payload.id]);
      if (!u || u.role !== 'admin' || u.banned) return res.status(403).json({ error: 'Accès refusé' });
      req.user = payload;
      next();
    } catch {
      res.status(403).json({ error: 'Accès refusé' });
    }
  }

  const limiterAdmin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de requêtes admin' },
  });

  // ── Admin : HTML panel ────────────────────────────────────────────────────────
  app.get('/admin', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Grade — Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a1a; --card: rgba(255,255,255,0.05); --border: rgba(255,255,255,0.08);
    --acc: #a78bfa; --acc2: #7c3aed; --green: #34d399; --red: #fb7185; --orange: #f97316;
    --text: #e2e8f0; --muted: #94a3b8;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; min-height: 100vh; }
  .bg { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
  .blob { position: absolute; border-radius: 50%; filter: blur(80px); opacity: .18; }
  .blob:nth-child(1) { width: 500px; height: 500px; background: #7c3aed; top: -100px; left: -100px; }
  .blob:nth-child(2) { width: 400px; height: 400px; background: #2563eb; bottom: -80px; right: -80px; }

  header {
    position: sticky; top: 0; z-index: 100;
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 2rem;
    background: rgba(10,10,26,.85); backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--border);
  }
  .logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 1.1rem;
    background: linear-gradient(135deg, var(--acc), #60a5fa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .badge-admin { background: rgba(167,139,250,.15); color: var(--acc); border: 1px solid rgba(167,139,250,.3);
    padding: .2rem .6rem; border-radius: 99px; font-size: .75rem; font-weight: 600; margin-left: .6rem; }
  .btn-logout { background: rgba(255,255,255,.06); border: 1px solid var(--border); color: var(--muted);
    padding: .4rem 1rem; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: .875rem;
    transition: all .2s; }
  .btn-logout:hover { background: rgba(251,113,133,.15); color: var(--red); border-color: var(--red); }

  main { position: relative; z-index: 1; max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem; }
  h1 { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 1.6rem; margin-bottom: 1.5rem; }

  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px;
    padding: 1.2rem 1.4rem; backdrop-filter: blur(20px); }
  .stat-label { font-size: .75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: .4rem; }
  .stat-value { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 2rem; }

  .section-card { background: var(--card); border: 1px solid var(--border); border-radius: 16px;
    padding: 1.5rem; backdrop-filter: blur(20px); }
  .section-title { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 1.1rem; margin-bottom: 1.2rem; }

  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); padding: .6rem .8rem; border-bottom: 1px solid var(--border); font-weight: 600; }
  td { padding: .75rem .8rem; border-bottom: 1px solid rgba(255,255,255,.04); font-size: .875rem; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.03); }

  .chip { display: inline-flex; align-items: center; gap: .3rem; padding: .2rem .6rem;
    border-radius: 99px; font-size: .72rem; font-weight: 600; }
  .chip-admin { background: rgba(167,139,250,.15); color: var(--acc); border: 1px solid rgba(167,139,250,.25); }
  .chip-user  { background: rgba(148,163,184,.1); color: var(--muted); border: 1px solid rgba(148,163,184,.15); }
  .chip-banned{ background: rgba(251,113,133,.12); color: var(--red); border: 1px solid rgba(251,113,133,.2); }
  .chip-ok    { background: rgba(52,211,153,.1);   color: var(--green); border: 1px solid rgba(52,211,153,.2); }
  .chip-warn  { background: rgba(249,115,22,.12);  color: var(--orange); border: 1px solid rgba(249,115,22,.25); }

  .actions { display: flex; gap: .4rem; flex-wrap: wrap; }
  .btn-action { padding: .3rem .7rem; border-radius: 7px; font-size: .78rem; font-weight: 600;
    border: 1px solid transparent; cursor: pointer; font-family: inherit; transition: all .15s; white-space: nowrap; }
  .btn-ban    { background: rgba(251,113,133,.1); color: var(--red); border-color: rgba(251,113,133,.2); }
  .btn-ban:hover { background: rgba(251,113,133,.25); }
  .btn-unban  { background: rgba(52,211,153,.1); color: var(--green); border-color: rgba(52,211,153,.2); }
  .btn-unban:hover { background: rgba(52,211,153,.25); }
  .btn-reset  { background: rgba(249,115,22,.1); color: var(--orange); border-color: rgba(249,115,22,.2); }
  .btn-reset:hover { background: rgba(249,115,22,.25); }
  .btn-del    { background: rgba(239,68,68,.08); color: #f87171; border-color: rgba(239,68,68,.15); }
  .btn-del:hover { background: rgba(239,68,68,.2); }

  .modal-overlay { display: none; position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,.6); backdrop-filter: blur(4px);
    align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #12122a; border: 1px solid var(--border); border-radius: 16px;
    padding: 2rem; max-width: 420px; width: 90%; }
  .modal h3 { font-family: 'Syne', sans-serif; font-weight: 700; margin-bottom: 1rem; }
  .modal p { color: var(--muted); font-size: .9rem; margin-bottom: 1rem; line-height: 1.5; }
  .pwd-display { background: rgba(167,139,250,.1); border: 1px solid rgba(167,139,250,.3);
    border-radius: 8px; padding: .8rem 1rem; font-family: monospace; font-size: 1.1rem;
    color: var(--acc); text-align: center; margin-bottom: 1.2rem; letter-spacing: .05em; }
  .modal-actions { display: flex; gap: .6rem; justify-content: flex-end; }
  .btn-copy { background: var(--acc2); color: #fff; border: none; padding: .5rem 1.2rem;
    border-radius: 8px; cursor: pointer; font-family: inherit; font-weight: 600; transition: opacity .2s; }
  .btn-copy:hover { opacity: .85; }
  .btn-close-modal { background: rgba(255,255,255,.06); color: var(--muted); border: 1px solid var(--border);
    padding: .5rem 1rem; border-radius: 8px; cursor: pointer; font-family: inherit; }

  #toast { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
    background: #1e1e3a; border: 1px solid var(--border); border-radius: 10px;
    padding: .75rem 1.2rem; font-size: .875rem; color: var(--text); display: none;
    box-shadow: 0 8px 32px rgba(0,0,0,.4); }

  .empty { text-align: center; color: var(--muted); padding: 3rem; font-size: .9rem; }

  /* ── Sidebar layout ── */
  .admin-layout { display: flex; min-height: 100vh; }
  .admin-sidebar {
    width: 220px; position: fixed; top: 0; left: 0; bottom: 0;
    background: rgba(255,255,255,.03); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; z-index: 100; padding: 1.4rem .9rem;
  }
  .sidebar-logo { display: flex; align-items: center; gap: .5rem; margin-bottom: 1.4rem; }
  .sidebar-divider { height: 1px; background: var(--border); margin: .8rem 0; }
  .nav-item {
    display: flex; align-items: center; gap: .7rem;
    padding: .6rem .85rem; border-radius: 10px; cursor: pointer;
    font-size: .875rem; font-weight: 500; color: var(--muted);
    transition: all .15s; margin-bottom: 2px;
    border: none; background: none; width: 100%; text-align: left; font-family: inherit;
  }
  .nav-item:hover { background: rgba(255,255,255,.06); color: var(--text); }
  .nav-item.active { background: rgba(167,139,250,.15); color: var(--acc); font-weight: 600; }
  .nav-badge { margin-left: auto; background: rgba(249,115,22,.2); color: var(--orange);
    border-radius: 99px; font-size: .68rem; font-weight: 700; padding: .1rem .45rem; min-width: 18px; text-align: center; }
  .admin-content { margin-left: 220px; flex: 1; padding: 2rem 1.5rem; max-width: calc(1100px + 220px); }
  .view-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .view-header h1 { margin-bottom: 0; }

  .admin-section { display: none; }
  .admin-section.active { display: block; }

  /* ── Admin chat modal responsive ── */
  #admin-chat-overlay > div { width: 90%; max-width: 560px; }
  @media (max-width: 900px) {
    .admin-sidebar { width: 56px; padding: .9rem .5rem; }
    .admin-sidebar .nav-label, .sidebar-logo span, .sidebar-badge-text { display: none; }
    .admin-content { margin-left: 56px; }
    .nav-item { justify-content: center; padding: .6rem; }
  }
  @media (max-width: 600px) {
    #admin-chat-overlay { align-items: flex-end !important; }
    #admin-chat-overlay > div { width: 100%; max-width: 100%; border-radius: 18px 18px 0 0; max-height: 90vh; }
    #admin-chat-messages { min-height: 160px; max-height: 300px; }
    #admin-chat-input { font-size: .82rem; }
    table th:nth-child(3), table td:nth-child(3),
    table th:nth-child(4), table td:nth-child(4) { display: none; }
    .actions { flex-direction: column; }
    .admin-content { padding: 1rem .75rem; }
  }
  @media (max-width: 700px) { .stats-grid { grid-template-columns: repeat(2,1fr); } }
  @media (max-width: 400px) { .stats-grid { grid-template-columns: 1fr 1fr; }
    th:nth-child(1), td:nth-child(1) { display: none; } }
  .filter-bar { display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin-bottom:.8rem; }
  .filter-input { background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);
    padding:.45rem .8rem;border-radius:8px;font-family:inherit;font-size:.82rem;outline:none;transition:border-color .2s; }
  .filter-input:focus { border-color:var(--acc); }
  .filter-input::placeholder { color:var(--muted); }
  select.filter-input option { background:#12122a; }
  .activity-feed { display:flex;flex-direction:column;gap:.5rem; }
  .activity-item { display:flex;align-items:flex-start;gap:.75rem;padding:.6rem .8rem;
    background:rgba(255,255,255,.03);border-radius:8px;border:1px solid var(--border); }
  .activity-icon { font-size:1rem;flex-shrink:0;margin-top:.05rem; }
  .activity-text { flex:1;font-size:.82rem; }
  .activity-meta { font-size:.72rem;color:var(--muted);margin-top:.15rem; }
  .monitor-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem; }
  .monitor-card { background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem 1.2rem;backdrop-filter:blur(20px); }
  .monitor-label { font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem; }
  .monitor-value { font-family:'Syne',sans-serif;font-weight:700;font-size:1.4rem; }
  .chart-wrap { position:relative;height:220px; }
  @media(max-width:700px) { .monitor-grid { grid-template-columns:1fr 1fr; } }
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
<div class="bg"><div class="blob"></div><div class="blob"></div></div>

<div class="admin-layout">

<!-- Sidebar -->
<aside class="admin-sidebar">
  <div class="sidebar-logo">
    <span class="logo">Grade</span>
    <span class="badge-admin sidebar-badge-text">Admin</span>
  </div>
  <div class="sidebar-divider"></div>
  <nav style="flex:1">
    <button class="nav-item active" data-view="overview" onclick="showAdminView('overview')">
      <span>📊</span><span class="nav-label">Vue d'ensemble</span>
    </button>
    <button class="nav-item" data-view="users" onclick="showAdminView('users')">
      <span>👥</span><span class="nav-label">Utilisateurs</span>
    </button>
    <button class="nav-item" data-view="tickets" onclick="showAdminView('tickets')">
      <span>🎫</span><span class="nav-label">Tickets</span>
      <span class="nav-badge" id="nav-tickets-badge" style="display:none">0</span>
    </button>
    <button class="nav-item" data-view="activity" onclick="showAdminView('activity')">
      <span>📋</span><span class="nav-label">Activité</span>
    </button>
    <button class="nav-item" data-view="stats" onclick="showAdminView('stats')">
      <span>📈</span><span class="nav-label">Statistiques</span>
    </button>
    <button class="nav-item" data-view="server" onclick="showAdminView('server')">
      <span>🖥️</span><span class="nav-label">Serveur</span>
    </button>
  </nav>
  <div class="sidebar-divider"></div>
  <button class="btn-logout" onclick="logout()" style="width:100%;text-align:left">Déconnexion</button>
</aside>

<!-- Main content -->
<main class="admin-content">

  <!-- Vue d'ensemble -->
  <section class="admin-section active" id="view-overview">
    <div class="view-header"><h1>Vue d'ensemble</h1></div>
    <div class="stats-grid" id="stats-grid">
      <div class="stat-card"><div class="stat-label">Utilisateurs</div><div class="stat-value" id="s-users">—</div></div>
      <div class="stat-card"><div class="stat-label">Admins</div><div class="stat-value" id="s-admins" style="color:var(--acc)">—</div></div>
      <div class="stat-card"><div class="stat-label">Bannis</div><div class="stat-value" id="s-banned" style="color:var(--red)">—</div></div>
      <div class="stat-card"><div class="stat-label">Notes totales</div><div class="stat-value" id="s-grades" style="color:var(--green)">—</div></div>
      <div class="stat-card"><div class="stat-label">Matières</div><div class="stat-value" id="s-subjects" style="color:#60a5fa">—</div></div>
      <div class="stat-card"><div class="stat-label">Projets</div><div class="stat-value" id="s-projects" style="color:#34d399">—</div></div>
      <div class="stat-card"><div class="stat-label">Devoirs</div><div class="stat-value" id="s-devoirs" style="color:#f472b6">—</div></div>
      <div class="stat-card"><div class="stat-label">Tickets ouverts</div><div class="stat-value" id="s-tickets" style="color:var(--orange)">—</div></div>
    </div>
  </section>

  <!-- Utilisateurs -->
  <section class="admin-section" id="view-users">
    <div class="view-header"><h1>Utilisateurs</h1></div>
    <div class="filter-bar">
      <input class="filter-input" id="user-search" type="text" placeholder="🔍  Rechercher nom, email…" oninput="filterUsers()" style="flex:1;min-width:180px">
      <select class="filter-input" id="user-filter-role" onchange="filterUsers()">
        <option value="">Tous les rôles</option>
        <option value="admin">Admin</option>
        <option value="user">Utilisateur</option>
      </select>
      <select class="filter-input" id="user-filter-status" onchange="filterUsers()">
        <option value="">Tous les statuts</option>
        <option value="active">Actif</option>
        <option value="banned">Banni</option>
      </select>
    </div>
    <div class="section-card">
      <div id="table-wrap"><div class="empty">Chargement…</div></div>
    </div>
  </section>

  <!-- Tickets -->
  <section class="admin-section" id="view-tickets">
    <div class="view-header"><h1>Tickets support</h1></div>
    <div class="filter-bar">
      <select class="filter-input" id="ticket-filter-type" onchange="filterTickets()">
        <option value="">Tous les types</option>
        <option value="bug">Bug</option>
        <option value="suggestion">Suggestion</option>
        <option value="reset">Reset MDP</option>
      </select>
      <select class="filter-input" id="ticket-filter-status" onchange="filterTickets()">
        <option value="">Tous les statuts</option>
        <option value="ouvert">Ouvert</option>
        <option value="fermé">Fermé</option>
      </select>
    </div>
    <div class="section-card">
      <div id="tickets-wrap"><div class="empty">Chargement…</div></div>
    </div>
  </section>

  <!-- Activité -->
  <section class="admin-section" id="view-activity">
    <div class="view-header"><h1>Activité récente</h1>
      <button class="btn-action" style="background:rgba(167,139,250,.1);color:var(--acc);border-color:rgba(167,139,250,.25)" onclick="loadActivity(true)">Actualiser</button>
    </div>
    <div class="section-card"><div id="activity-wrap"><div class="empty">Chargement…</div></div></div>
  </section>

  <!-- Statistiques -->
  <section class="admin-section" id="view-stats">
    <div class="view-header"><h1>Statistiques</h1>
      <button class="btn-action" style="background:rgba(167,139,250,.1);color:var(--acc);border-color:rgba(167,139,250,.25)" onclick="loadStats(true)">Actualiser</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
      <div class="section-card">
        <div class="section-title">Inscriptions par mois</div>
        <div class="chart-wrap"><canvas id="chart-inscriptions"></canvas></div>
      </div>
      <div class="section-card">
        <div class="section-title">Activité — notes ajoutées (30j)</div>
        <div class="chart-wrap"><canvas id="chart-grades-activity"></canvas></div>
      </div>
    </div>
  </section>

  <!-- Serveur -->
  <section class="admin-section" id="view-server">
    <div class="view-header"><h1>Monitoring serveur</h1>
      <button class="btn-action" style="background:rgba(167,139,250,.1);color:var(--acc);border-color:rgba(167,139,250,.25)" onclick="loadServer(true)">Actualiser</button>
    </div>
    <div id="server-wrap"><div class="empty">Chargement…</div></div>
  </section>

</main>
</div>

<div class="modal-overlay" id="modal-pwd">
  <div class="modal">
    <h3>🔑 Mot de passe temporaire</h3>
    <p>Transmets ce mot de passe à <strong id="modal-username"></strong> à l'adresse :</p>
    <div id="modal-user-email" style="background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.25);border-radius:8px;padding:10px 14px;font-size:.92rem;color:var(--acc);margin-bottom:12px;word-break:break-all"></div>
    <div class="pwd-display" id="modal-pwd-value"></div>
    <p style="font-size:.8rem;color:var(--muted);margin:10px 0 0">L'utilisateur devra choisir un nouveau mot de passe dès sa prochaine connexion.</p>
    <div class="modal-actions">
      <button class="btn-close-modal" onclick="closeModal()">Fermer</button>
      <button class="btn-copy" onclick="copyEmail()">Copier email</button>
      <button class="btn-copy" onclick="copyPwd()">Copier MDP</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<!-- Debug error display -->
<div id="admin-js-err" style="display:none;position:fixed;top:1rem;left:50%;transform:translateX(-50%);z-index:99999;background:#1a0000;border:1px solid var(--red);color:var(--red);padding:.8rem 1.2rem;border-radius:10px;font-size:.85rem;max-width:90vw;word-break:break-all"></div>

<!-- Login overlay admin -->
<div id="admin-login-overlay" style="display:none;position:fixed;inset:0;z-index:9999;background:var(--bg);align-items:center;justify-content:center">
  <div style="background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:20px;padding:2.5rem 2rem;width:90%;max-width:360px;box-shadow:0 8px 40px rgba(0,0,0,.5)">
    <h2 style="font-family:'Syne',sans-serif;font-weight:800;font-size:1.4rem;margin-bottom:.3rem">📚 Grade</h2>
    <p style="color:var(--muted);font-size:.83rem;margin-bottom:1.8rem">Panneau d'administration</p>
    <div id="admin-login-err" style="display:none;color:var(--red);background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.2);border-radius:8px;padding:.6rem .9rem;font-size:.82rem;margin-bottom:1rem"></div>
    <div style="margin-bottom:1rem">
      <label style="font-size:.72rem;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:.5rem">Nom d'utilisateur</label>
      <input id="admin-login-user" type="text" autocomplete="username" placeholder="admin" style="width:100%;background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);padding:.65rem .9rem;border-radius:10px;font-family:inherit;font-size:.9rem;outline:none;box-sizing:border-box">
    </div>
    <div style="margin-bottom:1.6rem">
      <label style="font-size:.72rem;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:.5rem">Mot de passe</label>
      <input id="admin-login-pwd" type="password" autocomplete="current-password" style="width:100%;background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);padding:.65rem .9rem;border-radius:10px;font-family:inherit;font-size:.9rem;outline:none;box-sizing:border-box">
    </div>
    <button id="admin-login-btn" onclick="doAdminLogin()" style="width:100%;background:var(--acc2);color:#fff;border:none;padding:.75rem;border-radius:10px;font-family:'Syne',sans-serif;font-weight:700;font-size:.95rem;cursor:pointer;transition:opacity .2s">Se connecter</button>
  </div>
</div>

<script>
window.onerror = function(msg, src, line, col, err) {
  var d = document.getElementById('admin-js-err');
  if (d) { d.textContent = 'Erreur JS (ligne ' + line + '): ' + msg; d.style.display = 'block'; }
};
</script>
<script>
let token = localStorage.getItem('admin_token');
let myId = null;
let allAdminUsers = [];
const viewLoaded = {};

function showAdminView(v) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === v));
  document.querySelectorAll('.admin-section').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  if (!viewLoaded[v]) {
    viewLoaded[v] = true;
    if (v === 'activity') loadActivity();
    else if (v === 'stats') loadStats();
    else if (v === 'server') loadServer();
  }
}

function adminAvatarColor(username) {
  const colors = ['#7c3aed','#2563eb','#0891b2','#059669','#d97706','#dc2626','#db2777'];
  let h = 0;
  for (let i = 0; i < (username||'').length; i++) h = (username||'').charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}
function adminAvatarInitials(fullName, username) {
  const str = (fullName||'').trim() || (username||'?');
  const parts = str.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return str.slice(0, 2).toUpperCase();
}

function showAdminLogin() {
  document.getElementById('admin-login-overlay').style.display = 'flex';
  document.getElementById('admin-login-user').focus();
}
function hideAdminLogin() {
  document.getElementById('admin-login-overlay').style.display = 'none';
}

async function doAdminLogin() {
  const username = document.getElementById('admin-login-user').value.trim();
  const password = document.getElementById('admin-login-pwd').value;
  const errEl    = document.getElementById('admin-login-err');
  const btn      = document.getElementById('admin-login-btn');
  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Identifiants requis.'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Connexion…';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erreur');
    token = d.token;
    localStorage.setItem('admin_token', token);
    const p = parseJwt(token);
    if (p) myId = p.id;
    hideAdminLogin();
    load();
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = 'Se connecter';
}

function parseJwt(t) {
  try { return JSON.parse(atob(t.split('.')[1])); } catch { return null; }
}
if (token) { const p = parseJwt(token); if (p) myId = p.id; }
else { showAdminLogin(); }

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json();
  if (!r.ok) throw Object.assign(new Error(d.error || 'Erreur'), { status: r.status });
  return d;
}

function toast(msg, color) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.borderColor = color || 'rgba(255,255,255,.1)';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', 3500);
}

function logout() {
  localStorage.removeItem('admin_token');
  token = null;
  document.getElementById('admin-login-user').value = '';
  document.getElementById('admin-login-pwd').value = '';
  document.getElementById('admin-login-err').style.display = 'none';
  showAdminLogin();
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function renderUsersTable(users) {
  const wrap = document.getElementById('table-wrap');
  if (!wrap) return;
  if (!users.length) { wrap.innerHTML = '<div class="empty">Aucun résultat</div>'; return; }
  const rows = users.map(u => {
    const isMe = u.id === myId;
    const roleBadge = u.role === 'admin'
      ? '<span class="chip chip-admin">admin</span>'
      : '<span class="chip chip-user">user</span>';
    const banBadge = u.banned
      ? '<span class="chip chip-banned">banni</span>'
      : '<span class="chip chip-ok">actif</span>';
    const banBtn = u.banned
      ? \`<button class="btn-action btn-unban" onclick="toggleBan(\${u.id},'\${esc(u.username)}')">Débannir</button>\`
      : \`<button class="btn-action btn-ban"   onclick="toggleBan(\${u.id},'\${esc(u.username)}')">Bannir</button>\`;
    const promoteBtn = u.role === 'admin'
      ? \`<button class="btn-action btn-reset" onclick="promoteUser(\${u.id},'\${esc(u.username)}','user')">Rétrograder</button>\`
      : \`<button class="btn-action btn-reset" onclick="promoteUser(\${u.id},'\${esc(u.username)}','admin')">Promouvoir</button>\`;
    const consentBadge = u.allow_admin_view
      ? \`<span class="chip" style="background:rgba(52,211,153,.1);color:var(--green);border-color:rgba(52,211,153,.2);font-size:.65rem">✓ Accès accordé</span>\`
      : \`<span style="color:var(--muted);font-size:.72rem;opacity:.5">—</span>\`;
    const detailBtn = u.allow_admin_view
      ? \`<button class="btn-action" style="background:rgba(52,211,153,.1);color:var(--green);border-color:rgba(52,211,153,.2)" onclick="openUserDetail(\${u.id},'\${esc(u.username)}')">Voir données</button>\`
      : '';
    const actions = isMe
      ? \`<span style="color:var(--muted);font-size:.78rem">C'est vous</span>\`
      : \`<div class="actions">\${detailBtn}\${banBtn}\${promoteBtn}<button class="btn-action btn-del" onclick="deleteUser(\${u.id},'\${esc(u.username)}')">Supprimer</button></div>\`;
    const date      = u.created_at ? u.created_at.slice(0,10) : '—';
    const lastLogin = u.last_login ? new Date(u.last_login + 'Z').toLocaleString('fr-CH', { timeZone:'Europe/Zurich', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const color = adminAvatarColor(u.username);
    const initials = adminAvatarInitials(u.full_name, u.username);
    return \`<tr>
      <td style="color:var(--muted)">\${u.id}</td>
      <td><div style="display:flex;align-items:center;gap:.6rem">
        <div style="width:30px;height:30px;border-radius:50%;background:\${color};display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;color:#fff;flex-shrink:0">\${esc(initials)}</div>
        <div><div style="font-weight:600">\${esc(u.username)}</div><div style="font-size:.73rem;color:var(--muted)">\${esc(u.full_name||'—')}</div></div>
      </div></td>
      <td style="color:var(--muted);font-size:.82rem">\${esc(u.email)}</td>
      <td style="color:var(--muted);font-size:.78rem">\${date}</td>
      <td style="color:var(--muted);font-size:.78rem">\${lastLogin}</td>
      <td style="color:var(--green);font-weight:600">\${u.nb_grades}</td>
      <td>\${roleBadge}</td>
      <td>\${banBadge}</td>
      <td>\${consentBadge}</td>
      <td>\${actions}</td>
    </tr>\`;
  }).join('');
  wrap.innerHTML = \`<table><thead><tr>
    <th>ID</th><th>Utilisateur</th><th>Email</th><th>Inscrit le</th><th>Dernière connexion</th><th>Notes</th><th>Rôle</th><th>Statut</th><th>Accès données</th><th>Actions</th>
  </tr></thead><tbody>\${rows}</tbody></table>\`;
}

function filterUsers() {
  const q = (document.getElementById('user-search')?.value || '').toLowerCase();
  const role = document.getElementById('user-filter-role')?.value || '';
  const status = document.getElementById('user-filter-status')?.value || '';
  const filtered = allAdminUsers.filter(u => {
    if (q && !u.username.toLowerCase().includes(q) && !(u.full_name||'').toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
    if (role && u.role !== role) return false;
    if (status === 'active' && u.banned) return false;
    if (status === 'banned' && !u.banned) return false;
    return true;
  });
  renderUsersTable(filtered);
}

async function load() {
  const wrap = document.getElementById('table-wrap');
  let data;
  try {
    data = await api('GET', '/admin/users');
  } catch (e) {
    if (e.status === 403 || e.status === 401) {
      localStorage.removeItem('admin_token');
      token = null;
      wrap.innerHTML = '';
      showAdminLogin();
      document.getElementById('admin-login-err').textContent = "Accès refusé — ce compte n'a pas le rôle admin.";
      document.getElementById('admin-login-err').style.display = 'block';
    } else {
      wrap.innerHTML = \`<div class="empty" style="color:var(--orange)">Erreur : \${esc(e.message)}</div>\`;
    }
    return;
  }
  document.getElementById('s-users').textContent    = data.stats.total_users;
  document.getElementById('s-admins').textContent   = data.stats.admin_users;
  document.getElementById('s-banned').textContent   = data.stats.banned_users;
  document.getElementById('s-grades').textContent   = data.stats.total_grades;
  document.getElementById('s-subjects').textContent = data.stats.total_subjects;
  document.getElementById('s-projects').textContent = data.stats.total_projects;
  document.getElementById('s-devoirs').textContent  = data.stats.total_devoirs;
  loadTickets();
  allAdminUsers = data.users;
  renderUsersTable(allAdminUsers);
}

async function openUserDetail(id, username) {
  const overlay = document.getElementById('user-detail-overlay');
  document.getElementById('user-detail-title').textContent = username;
  document.getElementById('user-detail-body').innerHTML = '<div class="empty">Chargement…</div>';
  overlay.style.display = 'flex';
  try {
    const d = await api('GET', \`/admin/users/\${id}/detail\`);
    let html = '';

    if (d.subjects.length) {
      // Group by year then trimester
      const grouped = {};
      d.subjects.forEach(s => {
        const key = \`\${s.year}-\${s.trimester}\`;
        if (!grouped[key]) grouped[key] = { year: s.year, trimester: s.trimester, subjects: [] };
        grouped[key].subjects.push(s);
      });

      html += '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.8rem">Matières &amp; Notes</div>';

      Object.values(grouped).forEach(group => {
        html += \`<div style="margin-bottom:1.2rem">
          <div style="font-size:.78rem;font-weight:700;color:var(--acc);margin-bottom:.5rem;padding:.3rem .6rem;background:rgba(167,139,250,.1);border-radius:6px;display:inline-block">
            Année \${group.year} — Trimestre \${group.trimester}
          </div>\`;

        group.subjects.forEach(s => {
          const hasGrades = s.grades.length > 0;
          const avg = hasGrades
            ? s.grades.reduce((sum,g)=>sum+g.value*g.weight,0) / s.grades.reduce((sum,g)=>sum+g.weight,0)
            : null;
          const avgStr = avg !== null ? avg.toFixed(2) : null;
          const avgColor = avg === null ? 'var(--muted)' : avg >= 4 ? 'var(--green)' : avg >= 3.5 ? 'var(--orange)' : 'var(--red)';
          const barW = avg !== null ? Math.round((avg - 1) / 5 * 100) : 0;

          html += \`<div style="margin-bottom:.6rem;border:1px solid var(--border);border-radius:10px;overflow:hidden">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:.6rem .85rem;background:rgba(255,255,255,.04)">
              <span style="font-weight:600;font-size:.875rem">\${esc(s.name)}</span>
              <span style="font-weight:700;font-size:.95rem;color:\${avgColor}">\${avgStr ? avgStr + '/6' : '—'}</span>
            </div>
            \${avg !== null ? \`<div style="height:2px;background:var(--border)"><div style="height:100%;width:\${barW}%;background:\${avgColor};transition:width .3s"></div></div>\` : ''}
            \${hasGrades ? \`<table style="width:100%">
              <thead><tr>
                <th style="padding:.4rem .85rem;text-align:left;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">Évaluation</th>
                <th style="padding:.4rem .6rem;text-align:center;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">Note</th>
                <th style="padding:.4rem .6rem;text-align:center;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">Poids</th>
              </tr></thead>
              <tbody>\${s.grades.map((g,i) => {
                const gc = g.value >= 4 ? 'var(--green)' : g.value >= 3.5 ? 'var(--orange)' : 'var(--red)';
                const bg = i % 2 === 1 ? 'background:rgba(255,255,255,.02)' : '';
                return \`<tr style="\${bg}">
                  <td style="padding:.4rem .85rem;font-size:.8rem">\${esc(g.name)}</td>
                  <td style="padding:.4rem .6rem;text-align:center;font-weight:700;font-size:.85rem;color:\${gc}">\${g.value}</td>
                  <td style="padding:.4rem .6rem;text-align:center;font-size:.78rem;color:var(--muted)">\${g.weight}%</td>
                </tr>\`;
              }).join('')}</tbody>
            </table>\` : '<div style="padding:.5rem .85rem;font-size:.78rem;color:var(--muted)">Aucune note</div>'}
          </div>\`;
        });

        html += '</div>';
      });
    }

    if (d.projects.length) {
      html += '<div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:.4rem 0 .6rem">Projets</div>';
      html += \`<table style="width:100%;margin-bottom:1rem">
        <thead><tr>
          <th style="padding:.4rem .85rem;text-align:left;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">Nom</th>
          <th style="padding:.4rem .6rem;text-align:center;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">An.</th>
          <th style="padding:.4rem .6rem;text-align:center;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">T.</th>
          <th style="padding:.4rem .6rem;text-align:center;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">Périodes</th>
          <th style="padding:.4rem .6rem;text-align:center;font-size:.7rem;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border)">Statut</th>
        </tr></thead>
        <tbody>\${d.projects.map((p,i) => {
          const bg = i % 2 === 1 ? 'background:rgba(255,255,255,.02)' : '';
          const statusHtml = p.success
            ? '<span style="color:var(--green);font-weight:600">Validé</span>'
            : '<span style="color:var(--muted)">En cours</span>';
          return \`<tr style="\${bg}">
            <td style="padding:.4rem .85rem;font-size:.82rem;font-weight:500">\${esc(p.name)}</td>
            <td style="padding:.4rem .6rem;text-align:center;font-size:.78rem;color:var(--muted)">\${p.year}</td>
            <td style="padding:.4rem .6rem;text-align:center;font-size:.78rem;color:var(--muted)">\${p.trimester}</td>
            <td style="padding:.4rem .6rem;text-align:center;font-size:.78rem;color:var(--muted)">\${p.periods ?? '—'}</td>
            <td style="padding:.4rem .6rem;text-align:center;font-size:.78rem">\${statusHtml}</td>
          </tr>\`;
        }).join('')}</tbody>
      </table>\`;
    }

    if (!d.subjects.length && !d.projects.length) html = '<div class="empty">Aucune donnée disponible.</div>';
    document.getElementById('user-detail-body').innerHTML = html;
  } catch(e) {
    document.getElementById('user-detail-body').innerHTML = \`<div class="empty" style="color:var(--red)">\${esc(e.message)}</div>\`;
  }
}

async function toggleBan(id, username) {
  if (!confirm(\`Modifier le statut de ban de \${username} ?\`)) return;
  try {
    await api('PATCH', \`/admin/users/\${id}/ban\`);
    toast(\`Ban togglé pour \${username}\`, 'var(--green)');
    load();
  } catch (e) { toast(e.message, 'var(--red)'); }
}

async function promoteUser(id, username, newRole) {
  const label = newRole === 'admin' ? 'promouvoir en admin' : 'rétrograder en user';
  if (!confirm(\`\${label} \${username} ?\`)) return;
  try {
    await api('PATCH', \`/admin/users/\${id}/role\`, { role: newRole });
    toast(\`\${username} → \${newRole}\`, 'var(--acc)');
    load();
  } catch (e) { toast(e.message, 'var(--red)'); }
}

async function deleteUser(id, username) {
  if (!confirm(\`⚠️ Supprimer définitivement \${username} et toutes ses données ?\`)) return;
  try {
    await api('DELETE', \`/admin/users/\${id}\`);
    toast(\`\${username} supprimé\`, 'var(--orange)');
    load();
  } catch (e) { toast(e.message, 'var(--red)'); }
}

async function resetPwd(id, username) {
  try {
    await api('PATCH', \`/admin/users/\${id}/reset-password\`);
    toast(\`Mot de passe de \${username} réinitialisé et envoyé via le ticket.\`, 'var(--green)');
    load();
  } catch (e) { toast(e.message, 'var(--red)'); }
}

function copyEmail() {
  navigator.clipboard.writeText(document.getElementById('modal-user-email').textContent)
    .then(() => toast('Email copié !', 'var(--acc)'));
}

function closeModal() { document.getElementById('modal-pwd').classList.remove('open'); }

function copyPwd() {
  navigator.clipboard.writeText(document.getElementById('modal-pwd-value').textContent)
    .then(() => toast('Mot de passe copié !', 'var(--acc)'));
}

document.getElementById('modal-pwd').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

let adminTickets = [];

function renderTicketsTable(tickets) {
  const wrap = document.getElementById('tickets-wrap');
  if (!wrap) return;
  if (!tickets.length) { wrap.innerHTML = '<div class="empty">Aucun ticket</div>'; return; }
  const rows = tickets.map(t => {
    const typeBadge = t.type === 'bug'
      ? '<span class="chip" style="background:rgba(251,113,133,.15);color:#fb7185;border-color:rgba(251,113,133,.25)">🐛 Bug</span>'
      : t.type === 'reset'
      ? '<span class="chip" style="background:rgba(249,115,22,.12);color:#f97316;border-color:rgba(249,115,22,.25)">🔑 Reset MDP</span>'
      : '<span class="chip" style="background:rgba(96,165,250,.15);color:#60a5fa;border-color:rgba(96,165,250,.25)">💡 Suggestion</span>';
    const statutBadge = t.statut === 'ouvert'
      ? '<span class="chip" style="background:rgba(249,115,22,.12);color:#f97316;border-color:rgba(249,115,22,.2)">Ouvert</span>'
      : '<span class="chip chip-ok">Fermé</span>';
    const toggleLabel = t.statut === 'ouvert' ? 'Fermer' : 'Rouvrir';
    const desc = esc(t.description).slice(0, 120) + (t.description.length > 120 ? '…' : '');
    const date = t.created_at ? new Date(t.created_at + 'Z').toLocaleString('fr-CH', { timeZone:'Europe/Zurich', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const delBtn = t.statut === 'fermé'
      ? \`<button class="btn-action btn-del" onclick="deleteTicket(\${t.id})">Supprimer</button>\`
      : \`<button class="btn-action" style="opacity:.3;cursor:not-allowed;background:rgba(255,255,255,.04);color:var(--muted);border-color:rgba(255,255,255,.08)" disabled>Supprimer</button>\`;
    return \`<tr>
      <td>\${typeBadge}</td>
      <td><strong>\${esc(t.titre)}</strong><br><span style="color:var(--muted);font-size:.78rem">\${desc}</span></td>
      <td style="color:var(--muted);font-size:.82rem">\${esc(t.username)}</td>
      <td style="color:var(--muted);font-size:.8rem">\${date}</td>
      <td>\${statutBadge}</td>
      <td><div class="actions">
        <button class="btn-action \${t.statut === 'ouvert' ? 'btn-reset' : 'btn-unban'}" onclick="toggleTicket(\${t.id})">\${toggleLabel}</button>
        <button class="btn-action" style="background:rgba(96,165,250,.1);color:#60a5fa;border-color:rgba(96,165,250,.2)" onclick="openAdminChat(\${t.id})">Chat</button>
        \${delBtn}
      </div></td>
    </tr>\`;
  }).join('');
  wrap.innerHTML = \`<table><thead><tr><th>Type</th><th>Titre / Description</th><th>Utilisateur</th><th>Date</th><th>Statut</th><th>Actions</th></tr></thead><tbody>\${rows}</tbody></table>\`;
}

function filterTickets() {
  const type = document.getElementById('ticket-filter-type')?.value || '';
  const status = document.getElementById('ticket-filter-status')?.value || '';
  const filtered = adminTickets.filter(t => {
    if (type && t.type !== type) return false;
    if (status && t.statut !== status) return false;
    return true;
  });
  renderTicketsTable(filtered);
}

async function loadTickets() {
  const wrap = document.getElementById('tickets-wrap');
  try { adminTickets = await api('GET', '/admin/tickets'); }
  catch (e) { wrap.innerHTML = \`<div class="empty" style="color:var(--orange)">Erreur: \${esc(e.message)}</div>\`; return; }
  const open = adminTickets.filter(t => t.statut === 'ouvert').length;
  document.getElementById('s-tickets').textContent = open;
  const badge = document.getElementById('nav-tickets-badge');
  if (badge) { badge.textContent = open; badge.style.display = open > 0 ? '' : 'none'; }
  renderTicketsTable(adminTickets);
}

// ── Activité ──────────────────────────────────────────────────────────────────
async function loadActivity(force) {
  if (!force && viewLoaded.activity_done) return;
  viewLoaded.activity_done = true;
  const wrap = document.getElementById('activity-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty">Chargement…</div>';
  try {
    const events = await api('GET', '/admin/activity');
    if (!events.length) { wrap.innerHTML = '<div class="empty">Aucune activité</div>'; return; }
    const icons = { login:'🔐', grade:'📝', ticket:'🎫', register:'🆕' };
    const colors = { login:'#60a5fa', grade:'var(--acc)', ticket:'var(--orange)', register:'var(--green)' };
    wrap.innerHTML = '<div class="activity-feed">' + events.map(e => {
      const ts = e.ts ? new Date(e.ts + (e.ts.includes('T') ? 'Z' : '')).toLocaleString('fr-CH', { timeZone:'Europe/Zurich', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
      return \`<div class="activity-item">
        <div class="activity-icon">\${icons[e.type]||'•'}</div>
        <div class="activity-text">
          <span style="font-weight:600;color:\${colors[e.type]||'var(--text)'}">\${esc(e.username)}</span>
          <span style="color:var(--muted)"> — \${esc(e.label)}</span>
          <div class="activity-meta">\${ts}</div>
        </div>
      </div>\`;
    }).join('') + '</div>';
  } catch(e) { wrap.innerHTML = \`<div class="empty" style="color:var(--red)">\${esc(e.message)}</div>\`; }
}

// ── Statistiques / Charts ─────────────────────────────────────────────────────
let _charts = {};
async function loadStats(force) {
  if (!force && viewLoaded.stats_done) return;
  viewLoaded.stats_done = true;
  try {
    const d = await api('GET', '/admin/stats/charts');
    const chartOpts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color:'#94a3b8', font:{ size:11 } }, grid: { color:'rgba(255,255,255,.05)' } },
        y: { ticks: { color:'#94a3b8', font:{ size:11 } }, grid: { color:'rgba(255,255,255,.05)' }, beginAtZero: true }
      }
    };
    const mkChart = (id, type, labels, values, color) => {
      if (_charts[id]) _charts[id].destroy();
      const ctx = document.getElementById(id)?.getContext('2d');
      if (!ctx) return;
      _charts[id] = new Chart(ctx, { type, data: {
        labels,
        datasets: [{ data: values, backgroundColor: color + '66', borderColor: color, borderWidth: 2, borderRadius: 6, tension: 0.3, fill: true }]
      }, options: chartOpts });
    };
    mkChart('chart-inscriptions', 'bar',
      d.inscriptions.map(r => r.month), d.inscriptions.map(r => r.n), '#a78bfa');
    mkChart('chart-grades-activity', 'line',
      d.gradesPerDay.map(r => r.day), d.gradesPerDay.map(r => r.n), '#60a5fa');
  } catch(e) { toast(e.message, 'var(--red)'); }
}

// ── Monitoring serveur ────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(1) + ' MB';
}
function fmtUptime(s) {
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  return (d ? d + 'j ' : '') + (h ? h + 'h ' : '') + m + 'm';
}
async function loadServer(force) {
  if (!force && viewLoaded.server_done) return;
  viewLoaded.server_done = true;
  const wrap = document.getElementById('server-wrap');
  if (!wrap) return;
  try {
    const d = await api('GET', '/admin/monitoring');
    wrap.innerHTML = \`
      <div class="monitor-grid">
        <div class="monitor-card"><div class="monitor-label">RAM utilisée (RSS)</div><div class="monitor-value">\${fmtBytes(d.mem_rss)}</div></div>
        <div class="monitor-card"><div class="monitor-label">Heap V8</div><div class="monitor-value">\${fmtBytes(d.mem_heap_used)}<span style="font-size:.85rem;color:var(--muted)"> / \${fmtBytes(d.mem_heap_total)}</span></div></div>
        <div class="monitor-card"><div class="monitor-label">Uptime processus</div><div class="monitor-value">\${fmtUptime(d.uptime)}</div></div>
        <div class="monitor-card"><div class="monitor-label">Taille base de données</div><div class="monitor-value" style="color:var(--acc)">\${fmtBytes(d.db_size)}</div></div>
        <div class="monitor-card"><div class="monitor-label">Connexions Socket.io</div><div class="monitor-value" style="color:var(--green)">\${d.socket_clients}</div></div>
        <div class="monitor-card"><div class="monitor-label">Version Node.js</div><div class="monitor-value" style="font-size:1.1rem;color:var(--muted)">\${d.node_version}</div></div>
      </div>\`;
  } catch(e) { wrap.innerHTML = \`<div class="empty" style="color:var(--red)">\${esc(e.message)}</div>\`; }
}

async function toggleTicket(id) {
  try { await api('PATCH', \`/admin/tickets/\${id}\`); loadTickets(); }
  catch (e) { toast(e.message, 'var(--red)'); }
}

async function deleteTicket(id) {
  try { await api('DELETE', \`/admin/tickets/\${id}\`); toast('Ticket supprimé', 'var(--orange)'); loadTickets(); }
  catch (e) { toast(e.message, 'var(--red)'); }
}

document.getElementById('admin-login-pwd').addEventListener('keydown', e => {
  if (e.key === 'Enter') doAdminLogin();
});
document.getElementById('admin-login-user').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('admin-login-pwd').focus();
});

if (token) load();

// ── Admin Chat ────────────────────────────────────────────────────────────────
let adminChatSocket = null;
let adminChatTicketId = null;

async function openAdminChat(ticketId) {
  adminChatTicketId = ticketId;
  const t = adminTickets.find(x => x.id === ticketId);
  document.getElementById('admin-chat-titre').textContent = t ? t.titre : '#' + ticketId;
  document.getElementById('admin-chat-sub').textContent = 'Ticket #' + ticketId + (t ? ' — ' + t.username : '');
  document.getElementById('admin-chat-input').value = '';
  const msgs = document.getElementById('admin-chat-messages');
  msgs.innerHTML = '<div style="color:var(--muted);text-align:center;padding:2rem;font-size:.85rem">Chargement…</div>';
  document.getElementById('admin-chat-overlay').style.display = 'flex';
  try {
    const history = await api('GET', \`/api/tickets/\${ticketId}/messages\`);
    renderAdminMsgs(msgs, history);
  } catch(e) {
    msgs.innerHTML = \`<div style="color:var(--red);padding:1rem">\${esc(e.message)}</div>\`;
  }
  const chatInput = document.getElementById('admin-chat-input');
  chatInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAdminMsg(); } };
  if (adminChatSocket) adminChatSocket.disconnect();
  adminChatSocket = io({ auth: { token } });
  adminChatSocket.emit('join-ticket', ticketId);
  adminChatSocket.on('message', msg => {
    if (msg.ticket_id === adminChatTicketId) appendAdminMsg(document.getElementById('admin-chat-messages'), msg);
  });
}

function closeAdminChat() {
  document.getElementById('admin-chat-overlay').style.display = 'none';
  if (adminChatSocket) { adminChatSocket.disconnect(); adminChatSocket = null; }
  adminChatTicketId = null;
}

function renderAdminMsgs(el, msgs) {
  if (!msgs.length) { el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:2rem;font-size:.85rem">Aucun message</div>'; return; }
  el.innerHTML = '';
  msgs.forEach(m => appendAdminMsg(el, m, false));
  el.scrollTop = el.scrollHeight;
}

function appendAdminMsg(el, m, scroll) {
  if (scroll === undefined) scroll = true;
  const mine = m.is_admin;
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;flex-direction:column;align-items:' + (mine ? 'flex-end' : 'flex-start') + ';margin-bottom:.4rem';
  const label = esc(m.username) + (m.is_admin ? ' (admin)' : '');
  const bg = mine ? 'rgba(124,58,237,.25)' : 'rgba(255,255,255,.07)';
  const border = mine ? 'rgba(124,58,237,.4)' : 'rgba(255,255,255,.1)';
  div.innerHTML = \`<div style="font-size:.7rem;color:var(--muted);margin-bottom:.2rem">\${label}</div><div style="background:\${bg};border:1px solid \${border};border-radius:12px;padding:.45rem .85rem;max-width:80%;font-size:.875rem;word-break:break-word;white-space:pre-wrap">\${esc(m.message)}</div>\`;
  el.appendChild(div);
  if (scroll) el.scrollTop = el.scrollHeight;
}

async function sendAdminMsg() {
  if (!adminChatTicketId) return;
  const input = document.getElementById('admin-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  try { await api('POST', \`/api/tickets/\${adminChatTicketId}/messages\`, { message: msg }); }
  catch(e) { toast(e.message, 'var(--red)'); }
}

// listener ajouté dynamiquement dans openAdminChat() car l'élément est injecté après ce script
</script>
<script src="/socket.io/socket.io.js"></script>

<!-- User detail overlay -->
<div id="user-detail-overlay" onclick="if(event.target===this)this.style.display='none'" style="display:none;position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);align-items:center;justify-content:center">
  <div style="background:#12122a;border:1px solid var(--border);border-radius:16px;width:90%;max-width:640px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:1.1rem 1.4rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="section-title" style="margin-bottom:.1rem" id="user-detail-title"></div>
        <div style="font-size:.72rem;color:var(--muted)">Données partagées avec consentement explicite</div>
      </div>
      <button class="btn-close-modal" onclick="document.getElementById('user-detail-overlay').style.display='none'">&#x2715;</button>
    </div>
    <div id="user-detail-body" style="flex:1;overflow-y:auto;padding:1.2rem"></div>
  </div>
</div>

<!-- Admin chat overlay -->
<div id="admin-chat-overlay" onclick="if(event.target===this)closeAdminChat()" style="display:none;position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);align-items:center;justify-content:center">
  <div style="background:#12122a;border:1px solid var(--border);border-radius:16px;width:90%;max-width:560px;max-height:82vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:1.1rem 1.4rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:1rem">
      <div>
        <div class="section-title" id="admin-chat-titre" style="margin-bottom:.2rem"></div>
        <div id="admin-chat-sub" style="color:var(--muted);font-size:.75rem"></div>
      </div>
      <button class="btn-close-modal" onclick="closeAdminChat()" style="flex-shrink:0">&#x2715;</button>
    </div>
    <div id="admin-chat-messages" style="flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;min-height:240px;max-height:420px"></div>
    <div style="padding:.9rem 1rem;border-top:1px solid var(--border);display:flex;gap:.6rem">
      <input id="admin-chat-input" type="text" maxlength="2000" placeholder="Répondre au ticket…" style="flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:var(--text);padding:.55rem .9rem;border-radius:8px;font-family:inherit;font-size:.875rem">
      <button class="btn-copy" onclick="sendAdminMsg()">Envoyer</button>
    </div>
  </div>
</div>
</body>
</html>`);
  });

  // ── Admin : bootstrap (one-shot, only when 0 admins exist) ──────────────────
  app.post('/admin/setup', limiterAdmin, (req, res) => {
    const header = req.headers.authorization;
    const token  = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token requis' });
    let payload;
    try { payload = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: 'Token invalide' }); }
    const adminCount = (get('SELECT COUNT(*) AS n FROM users WHERE role = ?', ['admin']) || { n: 0 }).n;
    if (adminCount > 0) return res.status(403).json({ error: 'Un admin existe déjà. Utilisez le panneau admin.' });
    const u = get('SELECT id, username FROM users WHERE id = ?', [payload.id]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    run('UPDATE users SET role = ? WHERE id = ?', ['admin', u.id]);
    res.json({ ok: true, message: u.username + ' est maintenant admin.' });
  });

  // ── Admin : API routes ────────────────────────────────────────────────────────
  app.get('/admin/users', limiterAdmin, isAdmin, (req, res) => {
    const users = all(`
      SELECT u.id, u.username, u.email, u.full_name, u.role, u.banned, u.created_at, u.last_login,
             u.allow_admin_view, u.admin_view_granted_at,
             COUNT(g.id) AS nb_grades
      FROM users u
      LEFT JOIN subjects s ON s.user_id = u.id
      LEFT JOIN grades g   ON g.subject_id = s.id
      GROUP BY u.id ORDER BY u.created_at DESC
    `);
    const stats = {
      total_users:    (get('SELECT COUNT(*) AS n FROM users') || {n:0}).n,
      admin_users:    (get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'") || {n:0}).n,
      banned_users:   (get('SELECT COUNT(*) AS n FROM users WHERE banned = 1') || {n:0}).n,
      total_grades:   (get('SELECT COUNT(*) AS n FROM grades') || {n:0}).n,
      total_subjects: (get('SELECT COUNT(*) AS n FROM subjects') || {n:0}).n,
      total_projects: (get('SELECT COUNT(*) AS n FROM projects') || {n:0}).n,
      total_devoirs:  (get('SELECT COUNT(*) AS n FROM devoirs') || {n:0}).n,
    };
    res.json({ users, stats });
  });

  app.get('/admin/users/:id/detail', limiterAdmin, isAdmin, (req, res) => {
    const uid = parseInt(req.params.id);
    const u = get('SELECT id, username, full_name, allow_admin_view FROM users WHERE id = ?', [uid]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (!u.allow_admin_view) return res.status(403).json({ error: "Cet utilisateur n'a pas accordé l'accès à ses données." });
    const subjects = all('SELECT * FROM subjects WHERE user_id = ? ORDER BY year, trimester, name', [uid]);
    for (const s of subjects) {
      s.grades  = all('SELECT name, value, weight FROM grades WHERE subject_id = ? ORDER BY created_at', [s.id]);
      s.futures = all('SELECT name, weight, date_test, note FROM future_tests WHERE subject_id = ? ORDER BY created_at', [s.id]);
    }
    const projects = all('SELECT * FROM projects WHERE user_id = ? ORDER BY year, trimester', [uid]);
    const devoirs  = all(`SELECT d.titre, d.priorite, d.statut, d.deadline, m.nom AS matiere_nom
                          FROM devoirs d LEFT JOIN matieres m ON d.matiere_id = m.id
                          WHERE d.user_id = ? ORDER BY d.deadline ASC`, [uid]);
    res.json({ username: u.username, full_name: u.full_name, subjects, projects, devoirs });
  });

  app.delete('/admin/users/:id', limiterAdmin, isAdmin, (req, res) => {
    const uid = parseInt(req.params.id);
    if (uid === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
    const u = get('SELECT id FROM users WHERE id = ?', [uid]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    userSockets.get(uid)?.forEach(s => s.emit('force-logout', 'deleted'));
    run('DELETE FROM users WHERE id = ?', [uid]);
    res.json({ ok: true });
  });

  app.patch('/admin/users/:id/role', limiterAdmin, isAdmin, (req, res) => {
    const uid = parseInt(req.params.id);
    if (uid === req.user.id) return res.status(400).json({ error: 'Impossible de modifier son propre rôle' });
    const { role } = req.body ?? {};
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Rôle invalide (admin ou user)' });
    const u = get('SELECT id FROM users WHERE id = ?', [uid]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    run('UPDATE users SET role = ? WHERE id = ?', [role, uid]);
    userSockets.get(uid)?.forEach(s => s.emit('role-changed', { role }));
    res.json({ ok: true, role });
  });

  app.patch('/admin/users/:id/ban', limiterAdmin, isAdmin, (req, res) => {
    const uid = parseInt(req.params.id);
    if (uid === req.user.id) return res.status(400).json({ error: 'Impossible de se bannir soi-même' });
    const u = get('SELECT id, banned FROM users WHERE id = ?', [uid]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const nowBanned = !u.banned;
    run('UPDATE users SET banned = ? WHERE id = ?', [nowBanned ? 1 : 0, uid]);
    if (nowBanned) {
      userSockets.get(uid)?.forEach(s => s.emit('force-logout'));
    }
    res.json({ ok: true, banned: nowBanned });
  });

  app.patch('/admin/users/:id/reset-password', limiterAdmin, isAdmin, (req, res) => {
    const uid = parseInt(req.params.id);
    const u = get('SELECT id, username, email, reset_requested FROM users WHERE id = ?', [uid]);
    if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (!u.reset_requested) return res.status(403).json({ error: "L'utilisateur n'a pas demandé de reset." });
    const temp = 'Grade#' + crypto.randomBytes(5).toString('hex');
    const hash = bcrypt.hashSync(temp, 10);
    run("UPDATE users SET password_hash = ?, reset_requested = 0, reset_message = '', must_change_password = 1 WHERE id = ?", [hash, uid]);
    const resetTicket = get("SELECT id FROM tickets WHERE user_id = ? AND type = 'reset' ORDER BY created_at DESC LIMIT 1", [uid]);
    if (resetTicket) {
      const autoMsg = `Ton mot de passe a été réinitialisé.\n\nMot de passe temporaire : ${temp}\n\nConnecte-toi sur notes.benross.ch avec ce mot de passe. Tu devras immédiatement en choisir un nouveau.`;
      run('INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)', [resetTicket.id, req.user.id, autoMsg]);
      io.to(`ticket-${resetTicket.id}`).emit('message', {
        ticket_id: resetTicket.id,
        user_id: req.user.id,
        username: req.user.username,
        message: autoMsg,
        is_admin: 1,
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
    }
    sendPasswordResetEmail({ username: u.username, email: u.email, temp_password: temp }).catch(err => console.error('Email reset error:', err.message));
    res.json({ ok: true });
  });

  // ── Admin : activité, stats, monitoring ──────────────────────────────────────
  app.get('/admin/activity', limiterAdmin, isAdmin, (req, res) => {
    const events = all(`
      SELECT type, username, full_name, label, ts FROM (
        SELECT 'login'    AS type, u.username, u.full_name, 'Connexion'                        AS label, u.last_login    AS ts FROM users u WHERE u.last_login IS NOT NULL
        UNION ALL
        SELECT 'grade',   u.username, u.full_name, 'Note ' || CAST(g.value AS TEXT) || '/6 — ' || s.name, g.created_at FROM grades g JOIN subjects s ON g.subject_id = s.id JOIN users u ON s.user_id = u.id
        UNION ALL
        SELECT 'ticket',  u.username, u.full_name, 'Ticket : ' || t.titre, t.created_at        FROM tickets t JOIN users u ON t.user_id = u.id
        UNION ALL
        SELECT 'register',username, full_name, 'Inscription', created_at                        FROM users
      ) ORDER BY ts DESC LIMIT 80
    `);
    res.json(events);
  });

  app.get('/admin/stats/charts', limiterAdmin, isAdmin, (req, res) => {
    const inscriptions = all(`SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS n FROM users GROUP BY month ORDER BY month ASC`);
    const gradesPerDay = all(`SELECT date(created_at) AS day, COUNT(*) AS n FROM grades WHERE created_at >= date('now', '-30 days') GROUP BY day ORDER BY day ASC`);
    res.json({ inscriptions, gradesPerDay });
  });

  app.get('/admin/monitoring', limiterAdmin, isAdmin, (req, res) => {
    const mem = process.memoryUsage();
    let dbSize = 0;
    try { dbSize = fs.statSync(DB_PATH).size; } catch {}
    res.json({
      uptime: Math.floor(process.uptime()),
      mem_rss: mem.rss,
      mem_heap_used: mem.heapUsed,
      mem_heap_total: mem.heapTotal,
      db_size: dbSize,
      socket_clients: io.engine.clientsCount,
      node_version: process.version,
    });
  });

  // ── Admin : tickets ───────────────────────────────────────────────────────────
  app.get('/admin/tickets', limiterAdmin, isAdmin, (req, res) => {
    const tickets = all(`
      SELECT t.*, u.username
      FROM tickets t JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC`);
    res.json(tickets);
  });

  app.patch('/admin/tickets/:id', limiterAdmin, isAdmin, (req, res) => {
    const t = get('SELECT id, statut, user_id FROM tickets WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Ticket introuvable' });
    const next = t.statut === 'ouvert' ? 'fermé' : 'ouvert';
    run('UPDATE tickets SET statut = ? WHERE id = ?', [next, req.params.id]);
    io.to(`ticket-${t.id}`).emit('ticket-updated', { id: t.id, statut: next });
    userSockets.get(t.user_id)?.forEach(s => s.emit('ticket-updated', { id: t.id, statut: next }));
    res.json({ ok: true, statut: next });
  });

  app.delete('/admin/tickets/:id', limiterAdmin, isAdmin, (req, res) => {
    const t = get('SELECT id, statut, user_id FROM tickets WHERE id = ?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Ticket introuvable' });
    if (t.statut === 'ouvert') return res.status(400).json({ error: 'Ferme le ticket avant de le supprimer' });
    run('DELETE FROM tickets WHERE id = ?', [req.params.id]);
    userSockets.get(t.user_id)?.forEach(s => s.emit('ticket-deleted', { id: t.id }));
    res.json({ ok: true });
  });

  // ── Ticket messages ───────────────────────────────────────────────────────────
  app.get('/api/tickets/my', auth, (req, res) => {
    const tickets = all(
      'SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(tickets);
  });

  app.get('/api/tickets/:id/messages', auth, (req, res) => {
    const tid = parseInt(req.params.id);
    const ticket = get('SELECT user_id FROM tickets WHERE id = ?', [tid]);
    if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
    const u = get('SELECT role FROM users WHERE id = ?', [req.user.id]);
    if (ticket.user_id !== req.user.id && u?.role !== 'admin')
      return res.status(403).json({ error: 'Accès refusé' });
    const msgs = all(`
      SELECT m.*, u.username,
        CASE WHEN u.role = 'admin' THEN 1 ELSE 0 END as is_admin
      FROM ticket_messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.ticket_id = ? ORDER BY m.created_at ASC
    `, [tid]);
    res.json(msgs);
  });

  app.post('/api/tickets/:id/messages', auth, (req, res) => {
    const tid = parseInt(req.params.id);
    const ticket = get('SELECT user_id FROM tickets WHERE id = ?', [tid]);
    if (!ticket) return res.status(404).json({ error: 'Ticket introuvable' });
    const u = get('SELECT role, username FROM users WHERE id = ?', [req.user.id]);
    if (ticket.user_id !== req.user.id && u?.role !== 'admin')
      return res.status(403).json({ error: 'Accès refusé' });
    const { message } = req.body ?? {};
    if (!message?.trim() || message.trim().length > 2000)
      return res.status(400).json({ error: 'Message invalide (1–2000 caractères)' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)',
      [tid, req.user.id, message.trim()]
    );
    const msg = {
      id, ticket_id: tid, user_id: req.user.id,
      username: u.username,
      message: message.trim(),
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      is_admin: u.role === 'admin' ? 1 : 0,
    };
    io.to(`ticket-${tid}`).emit('message', msg);
    res.status(201).json(msg);
  });

  // ── Global error handler ──────────────────────────────────────────────────────
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse (max 50 Ko)' });
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  });

  // ── Start ─────────────────────────────────────────────────────────────────────
  httpServer.listen(PORT, () => console.log(`http://localhost:${PORT}`));
}

main();
