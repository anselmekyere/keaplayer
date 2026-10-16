package com.anselmekyere.keaplayer

/**
 * Commandes du lecteur, les mêmes que celles de la version de bureau
 * (src/shared/types.ts, MenuCommand) : barre de menus, boutons et
 * raccourcis clavier passent tous par là.
 */
sealed interface Command {
    data object OpenFiles : Command
    data object OpenFolder : Command
    data object PlayPause : Command
    data object Previous : Command
    data object Next : Command
    data class Seek(val seconds: Int) : Command
    data object Frame : Command
    data object Snapshot : Command
    data object Mute : Command
    data class Volume(val delta: Int) : Command
    data class Speed(val value: Float) : Command
    data class SpeedStep(val delta: Float) : Command
    data object CycleAudio : Command
    data object CycleSubtitle : Command
    data class AudioDelay(val ms: Int) : Command
    data class SubtitleDelay(val ms: Int) : Command
    data object TogglePlaylist : Command
    data object ToggleTracks : Command
    data object ToggleFullscreen : Command
    data object Escape : Command
    data object Help : Command
}

/** Raccourcis clavier de la version de bureau (aide « ? » de KEAPlayer). */
object Shortcuts {
    /**
     * [key] : caractère tapé (« m », « ? », « [ »…) ou nom de touche
     * (« Space », « ArrowLeft », « Escape », « F11 »).
     */
    fun commandFor(key: String, shift: Boolean = false, ctrl: Boolean = false): Command? {
        if (ctrl) {
            return when (key.lowercase()) {
                "o" -> if (shift) Command.OpenFolder else Command.OpenFiles
                else -> null
            }
        }
        return when (key) {
            "Space", " " -> Command.PlayPause
            "ArrowRight" -> Command.Seek(if (shift) 60 else 10)
            "ArrowLeft" -> Command.Seek(if (shift) -60 else -10)
            "ArrowUp" -> Command.Volume(5)
            "ArrowDown" -> Command.Volume(-5)
            "Escape" -> Command.Escape
            "F11" -> Command.ToggleFullscreen
            "[" -> Command.SpeedStep(-0.25f)
            "]" -> Command.SpeedStep(0.25f)
            "=" -> Command.Speed(1f)
            "?" -> Command.Help
            "S" -> if (shift) Command.Snapshot else null
            else -> when (key.lowercase()) {
                "m" -> Command.Mute
                "f" -> Command.ToggleFullscreen
                "n" -> Command.Next
                "p" -> Command.Previous
                "e" -> Command.Frame
                "b" -> Command.CycleAudio
                "v" -> Command.CycleSubtitle
                "j" -> Command.AudioDelay(-50)
                "k" -> Command.AudioDelay(50)
                "g" -> Command.SubtitleDelay(-50)
                "h" -> Command.SubtitleDelay(50)
                "l" -> Command.TogglePlaylist
                "t" -> Command.ToggleTracks
                else -> null
            }
        }
    }

    /** Liste affichée par « ? » et par Aide → Raccourcis clavier, comme sur le bureau. */
    val HELP: List<Pair<String, String>> = listOf(
        "Espace" to "Lecture / pause",
        "← / →" to "Reculer / avancer de 10 s (Maj : 1 min)",
        "↑ / ↓" to "Volume (jusqu'à 200 %)",
        "M" to "Couper le son",
        "F / F11 / Échap" to "Plein écran / quitter",
        "T" to "Panneau pistes, son et décalages",
        "L" to "Liste de lecture",
        "N / P" to "Suivant / précédent",
        "[ / ] / =" to "Ralentir / accélérer / vitesse normale",
        "E" to "Image suivante",
        "B / V" to "Piste audio / sous-titres suivants",
        "J / K" to "Décalage audio −/+ 50 ms",
        "G / H" to "Décalage sous-titres −/+ 50 ms",
        "Maj+S" to "Capture d'écran (Images/KEAPlayer)",
        "Ctrl+O" to "Ouvrir des fichiers",
    )

    /** Gestes, propres à l'écran tactile. */
    val GESTURES: List<Pair<String, String>> = listOf(
        "Toucher" to "Afficher les commandes, puis lecture / pause",
        "Double toucher au centre" to "Plein écran",
        "Double toucher à gauche / droite" to "Reculer / avancer de 10 s",
        "Glisser horizontalement" to "Se déplacer dans la vidéo",
        "Glisser à droite (vertical)" to "Volume",
        "Glisser à gauche (vertical)" to "Luminosité",
    )

    /** Vitesses proposées, comme le sélecteur du bureau. */
    val SPEEDS = listOf(0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)

    fun clampSpeed(value: Float) = value.coerceIn(0.25f, 2f)

    fun speedLabel(speed: Float): String =
        (if (speed == speed.toInt().toFloat()) speed.toInt().toString() else speed.toString().replace('.', ',')) + "×"
}

/** Libellés du bureau (src/renderer/audio.ts), dans l'ordre des préréglages de VLC. */
val EQ_LABELS = listOf(
    "Plat", "Classique", "Club", "Danse", "Basses renforcées", "Basses et aigus", "Aigus renforcés",
    "Casque", "Grande salle", "Concert", "Fête", "Pop", "Reggae", "Rock", "Ska", "Doux", "Rock doux", "Techno",
)
