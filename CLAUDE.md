# Grade App — Instructions pour Claude

## Présentation du projet
Application web de gestion de notes scolaires pour le système suisse (notes 1–6, passage à 4.0).
Développée pour un étudiant en formation sur 4 ans, découpée en **4 trimestres** par an.

## Stack technique
- **Backend** : Node.js + Express (`server.js`)
- **Base de données** : SQLite via **`sql.js`** (WASM, pas de compilation native) — fichier `grades.db`
- **Auth** : JWT (`jsonwebtoken`) + hash bcrypt (`bcryptjs`)
- **Frontend** : Vanilla JS, HTML/CSS dans `public/index.html` (SPA sans framework)
- **Démarrage** : `npm install` puis `npm start` → http://localhost:3000

## Particularités sql.js (IMPORTANT)
- `sql.js` est en mémoire : **chaque écriture doit appeler `save()`** qui fait `fs.writeFileSync(DB_PATH, Buffer.from(db.export()))`
- `PRAGMA foreign_keys = ON` doit être exécuté à chaque ouverture (pas persisté)
- Le fichier WASM est localisé via `locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)`
- Helpers définis dans `main()` : `run(sql, params)`, `get(sql, params)`, `all(sql, params)`, `exec(sql)`
- Migration SQLite sans ALTER MODIFY : pattern create-new + INSERT SELECT + DROP + RENAME
- **Redémarrer le serveur** est obligatoire après tout changement de `server.js`

## Structure des fichiers
```
grade/
├── server.js          ← API REST + init DB + migrations + auth middleware
├── package.json
├── grades.db          ← généré au premier lancement
└── public/
    └── index.html     ← toute l'UI (auth, app, JS, CSS)
```

## Schéma de base de données complet
```sql
users            (id, username, email, password_hash, created_at)
subjects         (id, user_id, year, trimester, name, created_at)
grades           (id, subject_id, name, value, weight, created_at)
future_tests     (id, subject_id, name, weight, created_at)
projects         (id, user_id, year, trimester, name, periods, success, created_at)
cg_subjects      (id, user_id, year, name, created_at)
cg_tests         (id, cg_subject_id, semester, name, points_obtained, points_total, created_at)
cg_futures       (id, cg_subject_id, semester, name, created_at)
cg_petits_tests  (id, cg_subject_id, semester, name, points_obtained, points_total, created_at)
```
- `year` : 1–4, `trimester` : 1–4
- `weight` : pourcentage (0–100), doit totaliser 100% par matière
- `success` : 0 ou 1 (INTEGER SQLite)
- `semester` : 1 ou 2 (pour CG uniquement)
- CG n'est pas filtré par trimestre, uniquement par année

## Routes API complètes
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/register` | Inscription |
| POST | `/api/login` | Connexion → JWT |
| GET | `/api/subjects?year=&trimester=` | Matières filtrées |
| POST | `/api/subjects` | Créer une matière |
| DELETE | `/api/subjects/:id` | Supprimer (cascade) |
| GET | `/api/subjects/:id/detail` | `{ grades, futures }` |
| POST | `/api/subjects/:id/grades` | Ajouter une note |
| DELETE | `/api/grades/:id` | Supprimer une note |
| POST | `/api/subjects/:id/future` | Ajouter test à venir |
| DELETE | `/api/future/:id` | Supprimer test à venir |
| GET | `/api/projects?year=&trimester=` | Projets filtrés |
| POST | `/api/projects` | Créer un projet |
| PATCH | `/api/projects/:id` | Toggle réussi/échoué |
| DELETE | `/api/projects/:id` | Supprimer un projet |
| GET | `/api/cg?year=` | Matières CG avec tests/futures/petits_tests imbriqués |
| POST | `/api/cg/subjects` | Créer matière CG |
| DELETE | `/api/cg/subjects/:id` | Supprimer matière CG |
| POST | `/api/cg/subjects/:id/tests` | Ajouter test CG (points_obtained, points_total) |
| DELETE | `/api/cg/tests/:id` | Supprimer test CG |
| POST | `/api/cg/subjects/:id/futures` | Ajouter test à venir CG (nom seul, pas de pts) |
| DELETE | `/api/cg/futures/:id` | Supprimer test à venir CG |
| POST | `/api/cg/subjects/:id/small-tests` | Ajouter petit test CG (points_obtained, points_total) |
| DELETE | `/api/cg/small-tests/:id` | Supprimer petit test CG |

Toutes les routes sauf register/login nécessitent `Authorization: Bearer <token>`.

## Logique métier — Section Matières

### Calcul de la note minimale (`calcSubject`)
```js
curSum   = Σ(grade.value × grade.weight)
curW     = Σ(grade.weight)
futW     = Σ(future.weight)
totalW   = curW + futW
minGrade = (4.0 × totalW - curSum) / futW
```
- `minGrade ≤ 1` → "Assurée" | `minGrade > 6` → "Impossible"
- Vert < 4.5 / Orange < 5.5 / Rouge ≥ 5.5

### Projets (seuil 80%)
```js
pct    = périodes_validées / périodes_totales × 100
manque = ceil(total × 0.8) - validées
```

## Logique métier — Culture Générale

### Formule de note CG
```js
cgGrade(t) = (t.points_obtained / t.points_total) × 5 + 1
```

### Calcul de moyenne de semestre (`calcCGSem`)
```js
// Signature : calcCGSem(tests, petitsTests, futures, targetAvg = 4.0)
petitsAvg = moyenne des cgGrade(petits tests)   // null si aucun
curSum    = Σ(cgGrade(tests)) + (petitsAvg ?? 0)
curN      = tests.length + (petitsAvg !== null ? 1 : 0)  // petits tests = 1 test
n         = curN + futures.length
semAvg    = curSum / curN
minGrade  = (targetAvg × n - curSum) / futures.length
```
**Important** : la moyenne des petits tests compte comme **1 seul test** dans la moyenne du semestre.

### Tests à venir CG
- Pas de `points_total` : on affiche directement la note minimale à obtenir
- Fonction `fmtMinGrade(mg)` → `{ label, cls }` avec green/orange/red

## Frontend — Architecture JS

### State
```js
S = {
  token, user, year, trimester,
  subjects, details,   // matières + cache détails
  projects,
  expanded,            // id matière ouverte (accordéon)
  cg,                  // array subjects CG avec tests/futures/petits_tests imbriqués
  cgExpanded,          // id matière CG ouverte
}
```

### Fonctions clés
- `loadAll()` : charge subjects+projects en Promise.all, puis CG séparément dans try/catch indépendant
- `renderDashboard()` : tableau de bord global (appelé depuis renderSubjects, renderProjects, renderCG, renderSubjectInPlace)
- `renderSubjects()` / `renderSubjectCard(s)` / `renderSubjectBody(sid, d, calc)` / `renderSubjectInPlace(sid)`
- `renderCG()` / `renderCGSubjectCard(s)` / `renderCGSubjectBody(s)` / `renderCGSemCol(s, sem)`
- `renderProjects()`
- `cgSubjectAvgs(s)` → `{ s1Avg, s2Avg, annAvg }` (prend en compte petits_tests)
- `showToast(msg, type, duration)` : notifications en bas à droite (styles inline, z-index 99999)

### Notifications (showToast)
- Utilise **des styles inline** sur l'élément (pas de classes CSS) pour éviter les conflits
- `document.body.appendChild(el)` — ne jamais utiliser `overflow:hidden` sur `body` ou `html` (casse `position:fixed`)
- Appeler sur toutes les actions : ajout, suppression, erreur, connexion

## Design

### Thème
- Fond : `#0a0a1a`
- Polices : `Syne` (titres, font-weight 700-800) + `DM Sans` (corps)
- Variables CSS : `--acc: #a78bfa`, `--acc2: #7c3aed`, `--green: #34d399`, `--red: #fb7185`, `--orange: #f97316`
- Glassmorphism : `backdrop-filter: blur(20px)` + `rgba(255,255,255,0.07)` background
- Blobs animés en background (`.bg` > 4 × `.blob`)

### Boutons (style Uiverse par adamgiebl)
Les boutons principaux (`btn-primary`, `.add-row .btn-add`, `.btn-sm.add`) utilisent un style avec :
- Fond `var(--acc)`, `box-shadow: inset` pour relief
- `<div class="icon">` positionné en absolu à droite avec une SVG flèche
- Au hover : `.icon` s'étend sur toute la largeur (`width: calc(100% - 0.6em)`)
- `overflow: hidden` sur le bouton (pas sur body/html !)
- **Toujours inclure le `<div class="icon"><svg>...</svg></div>` dans le HTML du bouton**
- Pour `btn-primary`, le texte est dans `<span id="auth-btn-text">` (pour que le JS puisse le modifier sans effacer l'icône)

### Structure sections
Les sections dans `<main>` sont des enfants directs. La 1ère div (`.welcome-header`) n'est pas `.section`.
Ordre actuel : welcome-header · Dashboard · Matières · Culture Générale · Projets
Les bordures colorées utilisent `.section:nth-child(n)` (n commence à 2 car welcome-header est child 1).

### Responsive
- Breakpoint mobile : 600px (header) et 680px (grilles 2 colonnes)
- Dashboard : 4 colonnes → 2 colonnes sous 780px

## Ce qu'il reste à faire (pistes)
- Export PDF / CSV des notes
- Graphique d'évolution de la moyenne dans le temps
- Mode "démo" sans compte
- Migration vers PostgreSQL pour la production (remplacer `sql.js` par `pg`)
- Variable d'environnement `JWT_SECRET` à configurer en production (actuellement `'dev-secret-change-in-prod'`)
- Ajouter la section CG dans le filtrage par année sur le tableau de bord
