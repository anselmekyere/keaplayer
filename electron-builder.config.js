/**
 * Installeur Windows (NSIS). Les binaires FFmpeg/ffprobe sont sortis de
 * l'archive asar : un exécutable ne peut pas être lancé depuis l'intérieur.
 * À construire sous Windows : ffmpeg-static télécharge le binaire de la
 * plateforme qui fait l'installation npm.
 */
module.exports = {
  appId: "com.anselmekyere.keaplayer",
  productName: "KEAPlayer",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "build/icon.png", "package.json"],
  artifactName: "KEAPlayer-Setup-${version}.${ext}",
  asarUnpack: ["node_modules/ffmpeg-static/**", "node_modules/@ffprobe-installer/**"],
  fileAssociations: [
    { ext: ["mp4", "m4v", "mkv", "webm", "avi", "mov", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts"], name: "Vidéo", role: "Viewer" },
    { ext: ["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma"], name: "Audio", role: "Viewer" },
  ],
  win: { target: "nsis", icon: "build/icon.ico" },
  linux: { target: "AppImage", icon: "build/icon.png", category: "AudioVideo" },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: "KEAPlayer",
  },
  publish: null,
};
