# Web Streamer V3 - RTMPS Streamer pour Railway

Application légère pour streamer une URL vidéo ou une page web vers un serveur RTMPS, optimisée pour Railway avec consommation minimale de ressources.

## Caractéristiques

- ✅ Stream RTMPS avec audio
- ✅ 1-5 FPS configurable (par défaut: 3 FPS)
- ✅ Optimisé pour faible consommation de ressources
- ✅ Stream fluide avec latence minimale
- ✅ API REST pour contrôler le stream
- ✅ Auto-start si `SOURCE_URL` ou `WEB_PAGE_URL` est configuré
- ✅ **Clic automatique sur bouton play** pour activer la musique sur une page web
- ✅ Capture d'écran de page web avec Puppeteer

## Configuration

### Variables d'environnement

- `RTMPS_URL` (requis): URL RTMPS de destination (ex: `rtmps://live-api-s.facebook.com:443/rtmp/YOUR_STREAM_KEY`)
- `SOURCE_URL` (optionnel): URL source à streamer (peut aussi être fournie via API)
- `WEB_PAGE_URL` (optionnel): URL de la page web à streamer avec clic automatique sur play
- `PLAY_BUTTON_SELECTOR` (optionnel): Sélecteur CSS du bouton play (défaut: sélecteurs communs)
- `FPS` (optionnel): Nombre de FPS entre 1 et 5 (défaut: 3)
- `PORT` (optionnel): Port du serveur (Railway le définit automatiquement)

## Déploiement sur Railway

1. Créez un nouveau projet sur Railway
2. Connectez votre repository GitHub
3. Ajoutez les variables d'environnement dans Railway:
   - `RTMPS_URL`: Votre URL RTMPS de destination
   - `WEB_PAGE_URL`: (optionnel) URL de la page web à streamer
   - `PLAY_BUTTON_SELECTOR`: (optionnel) Sélecteur CSS du bouton play
   - `FPS`: (optionnel) 1-5, défaut: 3
4. Railway détectera automatiquement Node.js et déploiera l'application

## Utilisation

### Démarrage automatique

Si `SOURCE_URL` ou `WEB_PAGE_URL` est configuré, le stream démarre automatiquement au lancement.

**Stream depuis une page web:**
- Configurez `WEB_PAGE_URL` avec l'URL de votre page web
- L'application ouvrira automatiquement la page, cliquera sur le bouton play, et streamera le contenu
- Vous pouvez personnaliser le sélecteur du bouton play avec `PLAY_BUTTON_SELECTOR`

### API REST

#### Démarrer un stream depuis une URL directe
```bash
POST /start
Content-Type: application/json

{
  "url": "https://example.com/stream.m3u8"
}
```

#### Démarrer un stream depuis une page web (avec clic auto sur play)
```bash
POST /start
Content-Type: application/json

{
  "webPageUrl": "https://example.com/music-page.html",
  "playButtonSelector": "button.play-button"
}
```

#### Arrêter le stream
```bash
POST /stop
```

#### Vérifier le statut
```bash
GET /status
```

#### Health check
```bash
GET /health
```

## Optimisations

L'application est optimisée pour être légère:

- **Codec**: H.264 baseline (compatible et léger)
- **Preset**: ultrafast (encodage rapide, faible CPU)
- **Résolution**: 640px de largeur (réduit la bande passante)
- **Bitrate vidéo**: 500k (faible consommation)
- **Bitrate audio**: 64k AAC (son de qualité acceptable)
- **FPS**: Configurable 1-5 (réduit la charge)
- **Buffer minimal**: Réduit la latence

## Exemple de déploiement

```bash
# Cloner le repo
git clone <votre-repo>
cd web-streamer-v3

# Installer les dépendances
npm install

# Configurer les variables d'environnement
export RTMPS_URL="rtmps://live-api-s.facebook.com:443/rtmp/YOUR_KEY"
export WEB_PAGE_URL="https://example.com/music-page.html"
export PLAY_BUTTON_SELECTOR="button.play-button"
export FPS=3

# Démarrer
npm start
```

## Notes

- L'application utilise `ffmpeg-static` pour inclure FFmpeg sans installation système
- Utilise directement FFmpeg via `spawn` (pas de dépendance dépréciée)
- Le stream est optimisé pour être fluide avec une latence minimale
- La consommation de ressources est minimisée grâce aux paramètres FFmpeg optimisés
- Pour le streaming depuis une page web, l'application utilise Puppeteer pour contrôler un navigateur headless
- Le clic automatique sur le bouton play fonctionne avec la plupart des sélecteurs CSS courants
- Si le sélecteur par défaut ne fonctionne pas, spécifiez `PLAY_BUTTON_SELECTOR` avec le bon sélecteur CSS
- **Note audio**: Pour l'instant, l'audio de la page web utilise un flux silencieux. La capture audio réelle nécessiterait des outils supplémentaires sur Railway.

