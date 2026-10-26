# Ancora API

Backend de la marketplace Ancora : comptes (clients et propriétaires), catalogue de yachts, réservations. Écrit en Node.js pur côté logique (aucune dépendance autre que `pg`, le client Postgres).

## Déployer gratuitement (Neon + Render)

### 1. Base de données (Neon, gratuit, sans carte bancaire)
1. Va sur neon.tech et crée un compte.
2. Crée un projet.
3. Dans le tableau de bord, copie la "Connection string" (elle ressemble à `postgresql://user:password@host/dbname?sslmode=require`).

### 2. Mettre le code sur GitHub
1. Crée un compte sur github.com si tu n'en as pas.
2. Crée un nouveau repository (public ou privé, les deux marchent).
3. Dépose tous les fichiers de ce dossier dans le repository (glisser-déposer depuis l'interface web de GitHub, pas besoin de ligne de commande).

### 3. Héberger l'API (Render, gratuit, sans carte bancaire)
1. Va sur render.com et crée un compte.
2. "New +" -> "Web Service", connecte le repository GitHub créé à l'étape 2.
3. Render détecte Node automatiquement. Renseigne :
   - Build Command : `npm install`
   - Start Command : `npm start`
4. Dans "Environment", ajoute deux variables :
   - `DATABASE_URL` = la chaîne copiée depuis Neon
   - `ANCORA_SECRET` = une longue chaîne aléatoire de ton choix
5. Clique sur "Create Web Service". Le premier déploiement prend quelques minutes.
6. Une fois prêt, Render donne une adresse publique du type `https://ancora-api-xxxx.onrender.com`.

Important : le plan gratuit de Render met le service en veille après 15 minutes sans requête ; la requête suivante le réveille en moins d'une minute. Normal pour une phase de test.

## Mettre à jour un déploiement existant

Si l'API est déjà en ligne (sur Render) et que seuls des fichiers ont changé :
1. Va sur ton repository GitHub (celui créé à l'étape 2 ci-dessus).
2. Pour chaque fichier modifié (ici : `server.js`, `db.js`, et le nouveau dossier `public/` avec `public/index.html`), clique sur le fichier existant dans GitHub (ou "Add file" -> "Upload files" pour un fichier/dossier nouveau), puis dépose la nouvelle version — GitHub propose de remplacer l'ancienne.
3. Valide ("Commit changes").
4. Render détecte automatiquement le changement sur GitHub et relance un déploiement (quelques minutes). Pas besoin de toucher à Neon ni aux variables d'environnement.

Désormais, le site lui-même (pas seulement l'API en JSON) est servi à l'adresse Render : ouvrir `https://<ton-adresse>.onrender.com/` affiche directement Ancora, connecté à la vraie base de données (comptes, connexion, réservations).

## Tester l'API une fois en ligne

```
curl https://<ton-adresse>.onrender.com/api/yachts
```

## Variables d'environnement

Voir `.env.example`.
