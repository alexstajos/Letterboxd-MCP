# Letterboxd MCP Server (V3)

Un serveur MCP ultra-complet pour Letterboxd utilisant Playwright pour les actions réelles et Axios pour le scraping rapide.

## Fonctionnalités Clés

- **Données Riches** : Posters HD, Casting complet, Durée, Genres et Synopsis intégral pour chaque film.
- **Accès Privé** : Supporte l'accès à votre Watchlist, Journal et Listes privées via authentification sécurisée.
- **Actions Réelles (Browser)** : Notez des films, ajoutez des cœurs, gérez votre watchlist et créez des listes exactement comme un humain.
- **Pagination Infinie** : Fouille absolument toutes les pages pour chaque requête par défaut.
- **Localisation Automatique** : Support du mot-clé `me` pour cibler votre propre compte sans configuration complexe.

## Configuration

Créez un fichier `.env` :
```env
LETTERBOXD_USERNAME=votre_pseudo
LETTERBOXD_PASSWORD=votre_mdp
PORT=3000
```

## Installation

```bash
npm install
npm start
```
*Le script postinstall téléchargera automatiquement le navigateur Chromium nécessaire pour les actions.*

### Lancer en mode stdio (optionnel)

```bash
node index.js --mode=stdio
```
*Par défaut le serveur utilise SSE via Express ; le mode stdio reste disponible pour les clients MCP qui le nécessitent.*

## Tools Disponibles

### Lecture
- `search`: Recherche globale (films, membres, listes).
- `get_film`: Détails profonds d'un film (slug requis).
- `get_member_watchlist`: Votre liste à voir (privee supportée).
- `get_member_diary`: Votre journal de visionnage.
- `get_member_films`: Tous les films que l'utilisateur a vus (toutes les pages), avec les éventuelles notes étoilées.
- `get_member_pinned`: Vos 4 films préférés (épinglés).
- `get_member_lists`: Toutes vos listes (inclus privées).

### Écriture (Playwright)
- `add_to_watched`: Marquer comme vu / retirer.
- `add_to_watchlist`: Ajouter / retirer de la watchlist.
- `rate_film`: Donner une note (1 à 10).
- `toggle_like`: Ajouter / retirer un cœur.
- `write_review`: Publier une critique dans votre journal.
- `add_to_list`: Ajouter un film à une liste existante.
- `create_list`: Créer une nouvelle liste (min. 1 film requis).

## Astuce
Utilisez `username: "me"` dans n'importe quel outil pour cibler automatiquement votre compte connecté.
