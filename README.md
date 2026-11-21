# RepairHub

Site de guides de réparation (style iFixit) : Node.js + Express + PostgreSQL.

## Rôles
- **Lecteur** : lit et commente
- **Créateur** : crée/modifie ses guides
- **Modérateur** : supprime commentaires/guides, suspend des lecteurs
- **Admin** : tout + catégories + attribution des rôles

Inscription par email, sans validation. Le compte dont l'email = `ADMIN_EMAIL` devient admin à son inscription.

## Déploiement sur Render
1. Poussez ce dossier sur GitHub.
2. Render → New → **Blueprint** → choisissez le dépôt (`render.yaml` crée le service + la base PostgreSQL).
3. Renseignez `ADMIN_EMAIL` (et `SMTP_*` pour l'email de bienvenue, optionnel).
4. Inscrivez-vous avec `ADMIN_EMAIL` : vous êtes admin. Créez les catégories, puis promouvez des utilisateurs en créateur/modérateur.

## En local
`DATABASE_URL=postgres://... ADMIN_EMAIL=moi@mail.fr npm install && npm start`
