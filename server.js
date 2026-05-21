const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'grades.db');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const PORT = process.env.PORT || 3000;

async function main() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
  });

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  // PRAGMA is session-only, must run on every open
  db.run('PRAGMA foreign_keys = ON');

  function save() {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  }

  // Runs a write statement and returns { lastInsertRowid }
  function run(sql, params = []) {
    db.run(sql, params);
    const lastInsertRowid = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    save();
    return { lastInsertRowid };
  }

  // Returns first row as object, or undefined
  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return row;
  }

  // Returns all rows as array of objects
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // Runs DDL / multi-statement SQL and saves
  function exec(sql) {
    db.exec(sql);
    save();
  }

  // Migration 1: drop old flat CG tables if subject-based schema not yet created
  if (!get("SELECT name FROM sqlite_master WHERE type='table' AND name='cg_subjects'")) {
    db.run('DROP TABLE IF EXISTS cg_futures');
    db.run('DROP TABLE IF EXISTS cg_tests');
    save();
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
    save();
  }

  // Migration 3: add target to subjects
  const subjCols = all('PRAGMA table_info(subjects)');
  if (!subjCols.some(c => c.name === 'target')) {
    db.run('ALTER TABLE subjects ADD COLUMN target REAL DEFAULT 4.0');
    save();
  }

  // Migration 4: add target_s1/target_s2 to cg_subjects
  const cgSubjCols = all('PRAGMA table_info(cg_subjects)');
  if (!cgSubjCols.some(c => c.name === 'target_s1')) {
    db.run('ALTER TABLE cg_subjects ADD COLUMN target_s1 REAL DEFAULT 4.0');
    db.run('ALTER TABLE cg_subjects ADD COLUMN target_s2 REAL DEFAULT 4.0');
    save();
  }

  // Migration 5b: add is_petit_test to cg_futures
  const cgFutCols2 = all('PRAGMA table_info(cg_futures)');
  if (!cgFutCols2.some(c => c.name === 'is_petit_test')) {
    db.run('ALTER TABLE cg_futures ADD COLUMN is_petit_test INTEGER NOT NULL DEFAULT 0');
    save();
  }

  // Migration 5: add comment to grades, cg_tests, cg_petits_tests
  const gradesCols = all('PRAGMA table_info(grades)');
  if (!gradesCols.some(c => c.name === 'comment')) {
    db.run("ALTER TABLE grades ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
    save();
  }
  const cgtCols = all('PRAGMA table_info(cg_tests)');
  if (!cgtCols.some(c => c.name === 'comment')) {
    db.run("ALTER TABLE cg_tests ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
    save();
  }
  const cgptCols = all('PRAGMA table_info(cg_petits_tests)');
  if (!cgptCols.some(c => c.name === 'comment')) {
    db.run("ALTER TABLE cg_petits_tests ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
    save();
  }

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
  `);

  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ── Rate limiting ──────────────────────────────────────────────────────────────
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de requêtes, réessayez dans 15 minutes' },
  }));
  const limiterAuth = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
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
      next();
    } catch {
      res.status(401).json({ error: 'Token invalide ou expiré' });
    }
  }

  // ── Auth routes ───────────────────────────────────────────────────────────────
  app.post('/api/register', limiterAuth, [vUsername, vEmail, vPassword], checkValidation, (req, res) => {
    const { username, email, password } = req.body ?? {};
    if (!username?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: 'Nom, email et mot de passe requis' });

    try {
      const hash = bcrypt.hashSync(password, 10);
      const { lastInsertRowid: id } = run(
        'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
        [username.trim(), email.trim().toLowerCase(), hash]
      );
      const token = jwt.sign({ id, username: username.trim() }, SECRET, { expiresIn: '30d' });
      res.status(201).json({ token, username: username.trim() });
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
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '30d' });
    res.json({ token, username: user.username });
  });

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
    const { name, weight } = req.body ?? {};
    if (!name?.trim() || !weight)
      return res.status(400).json({ error: 'Nom et poids requis' });
    const { lastInsertRowid: id } = run(
      'INSERT INTO future_tests (subject_id, name, weight) VALUES (?, ?, ?)',
      [req.params.id, name.trim(), weight]
    );
    res.status(201).json({ id, name: name.trim(), weight });
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

  app.patch('/api/future/:id', auth, [vName, vWeight], checkValidation, (req, res) => {
    const f = get(
      'SELECT f.id FROM future_tests f JOIN subjects s ON f.subject_id = s.id WHERE f.id = ? AND s.user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!f) return res.status(404).json({ error: 'Test introuvable' });
    const { name, weight } = req.body ?? {};
    if (!name?.trim() || !weight || weight <= 0)
      return res.status(400).json({ error: 'Champs invalides' });
    run('UPDATE future_tests SET name = ?, weight = ? WHERE id = ?', [name.trim(), weight, req.params.id]);
    res.json({ ok: true });
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

    try {
      db.run('BEGIN TRANSACTION');

      db.run('DELETE FROM subjects    WHERE user_id = ?', [uid]);
      db.run('DELETE FROM projects    WHERE user_id = ?', [uid]);
      db.run('DELETE FROM cg_subjects WHERE user_id = ?', [uid]);

      const ins = (sql, params) => {
        db.run(sql, params);
        return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      };

      for (const s of subjects) {
        const sid = ins(
          'INSERT INTO subjects (user_id, year, trimester, name, target) VALUES (?,?,?,?,?)',
          [uid, s.year, s.trimester, s.name, s.target ?? 4.0]
        );
        for (const g of (s.grades  ?? [])) db.run('INSERT INTO grades       (subject_id, name, value, weight, comment) VALUES (?,?,?,?,?)', [sid, g.name, g.value, g.weight, g.comment ?? '']);
        for (const f of (s.futures ?? [])) db.run('INSERT INTO future_tests (subject_id, name, weight)           VALUES (?,?,?)',           [sid, f.name, f.weight]);
      }

      for (const p of projects)
        db.run('INSERT INTO projects (user_id, year, trimester, name, periods, success) VALUES (?,?,?,?,?,?)',
          [uid, p.year, p.trimester, p.name, p.periods, p.success ?? 0]);

      for (const s of cg_subjects) {
        const sid = ins(
          'INSERT INTO cg_subjects (user_id, year, name, target_s1, target_s2) VALUES (?,?,?,?,?)',
          [uid, s.year, s.name, s.target_s1 ?? 4.0, s.target_s2 ?? 4.0]
        );
        for (const t  of (s.tests        ?? [])) db.run('INSERT INTO cg_tests        (cg_subject_id, semester, name, points_obtained, points_total, comment) VALUES (?,?,?,?,?,?)', [sid, t.semester,  t.name, t.points_obtained, t.points_total, t.comment ?? '']);
        for (const f  of (s.futures      ?? [])) db.run('INSERT INTO cg_futures      (cg_subject_id, semester, name)                                        VALUES (?,?,?)',         [sid, f.semester,  f.name]);
        for (const pt of (s.petits_tests ?? [])) db.run('INSERT INTO cg_petits_tests (cg_subject_id, semester, name, points_obtained, points_total, comment) VALUES (?,?,?,?,?,?)', [sid, pt.semester, pt.name, pt.points_obtained, pt.points_total, pt.comment ?? '']);
      }

      db.run('COMMIT');
      save();
      res.json({ ok: true });
    } catch (e) {
      try { db.run('ROLLBACK'); } catch {}
      res.status(400).json({ error: 'Import invalide : ' + e.message });
    }
  });

  // ── Global error handler ──────────────────────────────────────────────────────
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse (max 50 Ko)' });
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  });

  // ── Start ─────────────────────────────────────────────────────────────────────
  app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
}

main().catch(console.error);
