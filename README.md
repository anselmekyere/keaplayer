# KEAPlayer

Lecteur multimédia de bureau (Windows, Linux) construit avec Electron. Son
architecture s'inspire de celle de VLC : un petit cœur qui choisit, pour chaque
fichier, le meilleur module de lecture disponible.

## Fonctions

- **Lecture** : lecture/pause, barre de progression, volume, raccourcis
  clavier inspirés de VLC (`?` dans l'application pour la liste).
- **Barre de menus** comme celle de VLC (Média, Lecture, Audio, Vidéo,
  Sous-titres, Affichage, Aide) : pistes, égaliseur et vitesse du fichier en
  cours, accessible au clavier avec Alt.
- **Plein écran** de la fenêtre entière (F, F11, double-clic ou menu Vidéo ;
  Échap pour quitter), option « Toujours au premier plan ».
- **Navigation au clavier** : F6 / Maj+F6 passent d'une zone à l'autre
  (commandes, liste de lecture, panneau des pistes) ; dans la liste, flèches,
  Entrée pour lire, Suppr pour retirer.
- **Aperçu au survol** de la barre de progression : miniature de l'image et
  instant pointé, extraits par FFmpeg à la volée et mis en cache.
- **Pistes et sous-titres** : choix de la piste audio, sous-titres `.srt` /
  `.vtt` / `.ass` voisins activés d'office (`film.srt`, `film.fr.ass`),
  sous-titres texte intégrés (MKV…), décalage audio et sous-titres par pas de
  50 ms.
- **Sous-titres ASS/SSA** rendus par libass (le moteur de VLC, compilé en
  WebAssembly via [JASSUB](https://github.com/ThaUnknown/jassub)) : styles,
  positions, dessins, karaoké, polices jointes aux MKV.
- **Liste de lecture** : glisser-déposer de fichiers ou de dossiers (ordre
  naturel : « Épisode 2 » avant « Épisode 10 »), suivant/précédent, reprise de
  la lecture là où on s'était arrêté.
- **Vitesse et captures** : 0,25× à 2×, image par image, capture d'écran PNG
  dans `Images/KEAPlayer`.
- **Son** : égaliseur 10 bandes avec les 18 préréglages de VLC, normalisation
  du volume, amplification jusqu'à 200 %.
- **Vidéo entrelacée** (TNT, DVD, caméscope) désentrelacée automatiquement
  (yadif).
- **Transcodage accéléré** par la carte graphique quand elle le permet
  (NVIDIA NVENC, Intel Quick Sync, AMD AMF, Apple VideoToolbox), détecté au
  démarrage par un court encodage d'essai ; x264 sinon.

## Comment ça marche

Comme `vlc_module_load` dans VLC (`src/main/core/modules.ts`), chaque module de
lecture annonce une capacité et un score ; ils sont essayés du plus haut au
plus bas et le premier qui accepte le fichier l'emporte :

| Module | Score | Quand | Comment |
| --- | --: | --- | --- |
| `native` | 100 | MP4/WebM/MP3/FLAC… en H.264, VP8/9, AV1, AAC, Opus… | Chromium lit le fichier directement (recherche instantanée) |
| `remux` | 50 | Image H.264/VP9/AV1 dans un autre conteneur (MKV…), autre piste audio, décalage audio | FFmpeg recopie l'image sans la réencoder dans un MP4 fragmenté |
| `transcode` | 10 | Tout le reste (AVI MPEG-4, WMV, HEVC…) | FFmpeg réencode en H.264/AAC |

Avant de choisir, `ffprobe` analyse le fichier (pistes, codecs, durée,
entrelacement), comme le « demux » de VLC. Les codecs que Chromium sait lire
sur la machine (HEVC, AC-3…) sont mesurés au démarrage. En mode `remux` / `transcode`, une recherche relance FFmpeg à
la nouvelle position.

```
src/
  main/            processus principal (Node.js)
    core/modules.ts    registre de modules à score
    media/probe.ts     analyse ffprobe
    media/playback.ts  modules native / remux / transcode
    media/server.ts    protocole interne kp:// (fichiers, flux FFmpeg, sous-titres,
                       miniatures, polices jointes)
    store.ts           positions de reprise
  renderer/        interface (HTML/CSS/TypeScript, sans framework)
  shared/          types et traitement des sous-titres
```

Sécurité : isolation du contexte, sandbox, aucune intégration Node dans
l'interface, navigation verrouillée et politique de sécurité du contenu (CSP)
stricte (seule exception : `wasm-unsafe-eval`, nécessaire à libass) ; toutes les ressources sont servies depuis l'origine interne
`kp://local`.

## Développement

Prérequis : Node.js ≥ 20.

```bash
npm install          # télécharge Electron, FFmpeg et ffprobe pour votre plateforme
npm start            # compile puis lance l'application
npm test             # tests unitaires (Vitest)
npm run test:e2e     # tests de bout en bout (Playwright + vrais médias générés par FFmpeg)
npm run dist         # installeur Windows dans release/ (à lancer sous Windows)
```

L'installeur Windows est aussi construit par GitHub Actions : poussez une
étiquette `vX.Y.Z` (par exemple `git tag v0.2.0 && git push origin v0.2.0`) et il
apparaît dans les *Releases* du dépôt.

`KEAPLAYER_FFMPEG` et `KEAPLAYER_FFPROBE` permettent d'utiliser les binaires du
système à la place de ceux fournis par npm.

## Licences

KEAPlayer s'inspire de l'architecture de VLC mais ne reprend pas son code. Il
appelle FFmpeg comme programme externe ; les binaires distribués par
`ffmpeg-static` sont sous licence GPL, ce dont il faut tenir compte (mention et
accès aux sources de FFmpeg) si vous distribuez l'installeur.
