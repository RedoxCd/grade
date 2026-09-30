# Grade

**Application web de gestion de notes scolaires** pour le système suisse (notes de 1 à 6, seuil de réussite à 4.0).

Conçue pour une formation sur **4 ans découpés en 4 trimestres**, Grade permet de suivre ses notes, calculer ses moyennes pondérées, savoir quelle note minimale obtenir aux prochains tests, gérer sa Culture Générale, ses projets, son agenda scolaire, et bien plus.

> Production : [notes.benross.ch](https://notes.benross.ch)

---

## Fonctionnalités

### Suivi des notes
- **Matières par année/trimestre** avec notes pondérées (poids en %)
- **Calcul de la note minimale** à obtenir aux tests à venir pour atteindre la moyenne cible
- **Objectif de note personnalisable** par matière (par défaut 4.0)
- Code couleur automatique selon la moyenne (vert / orange / rouge)
- **Tests à venir** avec date et heure optionnelles
- Commentaires sur chaque note

### Culture Générale (CG)
- Gestion séparée par **semestre** (S1 / S2), notes calculées à partir de points obtenus / total
- Distinction **tests** / **petits tests** (les petits tests comptent ensemble comme un seul test dans la moyenne)
- Objectifs de moyenne par semestre

### Projets
- Suivi des projets par périodes validées, avec seuil de réussite à 80 %

### Agenda scolaire
- **Emploi du temps** hebdomadaire (créneaux par matière, salle, horaires)
- **Devoirs** avec priorité, statut (à faire / en cours / terminé) et échéance
- **Statistiques** de charge de travail (graphiques Chart.js)

### Tableau de bord & statistiques
- Vue d'ensemble : moyennes Informatique, CG (S1/S2/annuelle) et projets
- Graphiques d'évolution, comparaison par année, radar par matière
- Export **PDF** des notes

### Comptes & sécurité
- Inscription / connexion par **JWT**, mots de passe hashés avec **bcrypt**
- **Réinitialisation de mot de passe** automatique (mot de passe temporaire + email + changement forcé à la première connexion)
- Profil utilisateur : avatar, nom complet, email, changement de mot de passe
- **Tickets de support** (bug / suggestion) avec **chat en temps réel** (Socket.io)

### Panneau d'administration
- Gestion des utilisateurs (rôles, bannissement, suppression) avec effet **temps réel** (déconnexion forcée via Socket.io)
- Gestion des tickets, flux d'activité, statistiques et monitoring serveur
- Accès aux données d'un utilisateur **uniquement avec son consentement explicite** (RGPD)

---

## Stack technique

| Domaine | Technologie |
|---------|-------------|
| Backend | Node.js + [Express](https://expressjs.com/) |
| Base de données | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (natif, synchrone, mode WAL) |
| Authentification | [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) + [bcryptjs](https://github.com/dcodeIO/bcrypt.js) |
| Sécurité | [helmet](https://helmetjs.github.io/), [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit), [express-validator](https://express-validator.github.io/) |
| Temps réel | [Socket.io](https://socket.io/) |
| Export PDF | [pdfkit](https://pdfkit.org/) |
| Email | [Resend](https://resend.com/) |
| Frontend | Vanilla JS, HTML/CSS, [Chart.js](https://www.chartjs.org/) (via CDN) |

Le frontend est composé de deux SPA (Single Page Applications) : la page principale des notes (`public/index.html`) et le module agenda (`public/agenda.html`).

---

## Installation locale

**Prérequis :** Node.js 18+ et les outils de build natifs (`build-essential` sur Linux, requis pour compiler `better-sqlite3`).

```bash
# 1. Cloner le dépôt
git clone https://github.com/RedoxCd/grade.git
cd grade

# 2. Installer les dépendances
npm install

# 3. (Optionnel) Configurer les variables d'environnement
#    Sans configuration, un secret JWT de développement est utilisé
#    et la base grades.db est créée automatiquement.

# 4. Lancer le serveur
npm start          # production
npm run dev        # développement (rechargement auto via --watch)
```

L'application est disponible sur **http://localhost:3000**.

La base de données SQLite (`grades.db`) est créée automatiquement au premier lancement, et les migrations de schéma s'exécutent au démarrage.

---

## Configuration

L'application se configure via des variables d'environnement :

| Variable | Description | Défaut |
|----------|-------------|--------|
| `PORT` | Port d'écoute HTTP | `3000` |
| `JWT_SECRET` | Secret de signature des tokens JWT | `dev-secret-change-in-prod` |
| `DATABASE_PATH` | Chemin du fichier SQLite | `./grades.db` |
| `EMAIL_ENABLED` | Active l'envoi d'emails (`true` / `false`) | `false` |
| `RESEND_API_KEY` | Clé API [Resend](https://resend.com/) pour les emails | — |

> **En production, `JWT_SECRET` doit impérativement être remplacé** par une valeur aléatoire :
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Déploiement

Le déploiement de référence utilise **PM2** derrière un reverse proxy **nginx** (avec HTTPS via Let's Encrypt).

```bash
# Copier la config PM2 d'exemple et renseigner les vraies valeurs
cp ecosystem.config.example.js ecosystem.config.js
# éditer ecosystem.config.js (JWT_SECRET, RESEND_API_KEY, ...)

pm2 start ecosystem.config.js
pm2 restart grade --update-env
```

`ecosystem.config.js` contient des secrets et est **ignoré par git** — seul le modèle `ecosystem.config.example.js` est versionné.

> ℹ️ Derrière un reverse proxy, `app.set('trust proxy', 1)` est déjà configuré dans `server.js` (nécessaire pour `express-rate-limit`).

### Sauvegarde

Le script [`backup.sh`](backup.sh) copie la base de données et la synchronise vers un stockage distant via [rclone](https://rclone.org/). À planifier via cron pour des sauvegardes automatiques.

---

## Structure du projet

```
grade/
├── server.js                    # API REST + init DB + migrations + auth + panneau admin
├── mailer.js                    # Envoi d'emails (Resend)
├── backup.sh                    # Script de sauvegarde de la base
├── ecosystem.config.example.js  # Modèle de configuration PM2
├── package.json
└── public/
    ├── index.html               # SPA principale (notes, CG, projets, tickets)
    ├── agenda.html              # SPA agenda (devoirs, emploi du temps)
    ├── css/
    │   ├── style.css
    │   └── agenda.css
    └── js/                       # Logique de l'agenda (API, devoirs, matières, emploi du temps, stats)
```

---

## Aperçu de l'API

L'API REST est servie sous `/api/*`. Toutes les routes nécessitent un header `Authorization: Bearer <token>`, sauf l'inscription, la connexion et la réinitialisation de mot de passe.

Quelques exemples :

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/api/register` | Inscription |
| `POST` | `/api/login` | Connexion (retourne un JWT) |
| `GET` | `/api/subjects?year=&trimester=` | Lister les matières |
| `POST` | `/api/subjects/:id/grades` | Ajouter une note |
| `GET` | `/api/cg?year=` | Culture Générale (tests, petits tests, à venir) |
| `GET` | `/api/projects?year=` | Projets |
| `GET` | `/api/matieres` · `/api/creneaux` · `/api/devoirs` | Agenda |
| `GET` | `/api/export/pdf` | Export PDF des notes |

Les routes d'administration sont sous `/admin/*` et réservées aux comptes ayant le rôle `admin`.

---

## Logique de calcul

**Note minimale à obtenir** (pour atteindre la moyenne cible sur les tests restants) :

```
noteMin = (cible × poidsTotal − sommePondéréeActuelle) / poidsRestant
```

**Note de Culture Générale** (à partir des points) :

```
note = (pointsObtenus / pointsTotal) × 5 + 1
```

**Projets** — réussite si au moins 80 % des périodes sont validées.

---

## Licence

Projet personnel. Tous droits réservés.
