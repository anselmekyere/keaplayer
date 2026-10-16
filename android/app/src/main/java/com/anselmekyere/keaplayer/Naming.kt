package com.anselmekyere.keaplayer

import java.text.Normalizer
import java.util.Locale

/** Règles de nommage partagées avec la version de bureau (src/main/media/library.ts). */
object Naming {
    val MEDIA_EXTENSIONS = setOf(
        "mp4", "m4v", "mkv", "webm", "avi", "mov", "wmv", "flv", "mpg", "mpeg",
        "ts", "m2ts", "3gp", "ogv", "mp3", "m4a", "aac", "flac", "wav", "ogg",
        "opus", "wma",
    )
    val AUDIO_EXTENSIONS = setOf("mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma")
    val SUBTITLE_EXTENSIONS = setOf("srt", "vtt", "ass", "ssa")

    fun extension(name: String): String = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
    fun stem(name: String): String = name.substringBeforeLast('.')

    fun isMedia(name: String, mime: String? = null): Boolean =
        extension(name) in MEDIA_EXTENSIONS || mime?.startsWith("video/") == true || mime?.startsWith("audio/") == true

    fun isAudio(name: String, mime: String? = null): Boolean =
        extension(name) in AUDIO_EXTENSIONS || mime?.startsWith("audio/") == true

    fun isSubtitle(name: String): Boolean = extension(name) in SUBTITLE_EXTENSIONS

    /**
     * Sous-titres du même nom que la vidéo, comme VLC : « film.srt »,
     * « film.fr.srt », « film.en.ass »… (ordre naturel).
     */
    fun matchingSubtitles(media: String, siblings: List<String>): List<String> {
        val s = stem(media).lowercase(Locale.ROOT)
        return siblings
            .filter { isSubtitle(it) }
            .filter {
                val base = stem(it).lowercase(Locale.ROOT)
                base == s || base.startsWith("$s.")
            }
            .sortedWith(NATURAL)
    }

    /** Ordre naturel : « Épisode 2 » avant « Épisode 10 », sans tenir compte de la casse ni des accents. */
    val NATURAL: Comparator<String> = Comparator { a, b -> naturalCompare(a, b) }

    fun naturalCompare(a: String, b: String): Int {
        val x = chunks(fold(a))
        val y = chunks(fold(b))
        for (i in 0 until minOf(x.size, y.size)) {
            val p = x[i]
            val q = y[i]
            val c = if (p[0].isDigit() && q[0].isDigit()) {
                val n = p.trimStart('0').ifEmpty { "0" }
                val m = q.trimStart('0').ifEmpty { "0" }
                if (n.length != m.length) n.length - m.length else n.compareTo(m)
            } else {
                p.compareTo(q)
            }
            if (c != 0) return c
        }
        return x.size - y.size
    }

    private fun fold(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)

    private fun chunks(s: String): List<String> = Regex("\\d+|\\D+").findAll(s).map { it.value }.toList()

    /** 1:02:03 ou 4:05, comme l'horloge de la version de bureau. */
    fun formatTime(ms: Long): String {
        val total = (if (ms < 0) 0 else ms) / 1000
        val h = total / 3600
        val m = (total / 60) % 60
        val s = total % 60
        return if (h > 0) String.format(Locale.ROOT, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.ROOT, "%d:%02d", m, s)
    }

    /** Reprise : seulement si l'on s'était arrêté au-delà des 5 premières secondes et avant la fin. */
    fun resumePosition(position: Long, duration: Long): Long? =
        if (position > 5_000 && (duration <= 0 || position < duration * 0.95)) position else null
}
