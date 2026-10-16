package com.anselmekyere.keaplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NamingTest {
    @Test
    fun ordreNaturelSansCasseNiAccents() {
        val noms = listOf("Épisode 10.mkv", "episode 2.mkv", "Episode 1.mkv", "Bonus.mp4", "épisode 02b.mkv")
        assertEquals(
            listOf("Bonus.mp4", "Episode 1.mkv", "episode 2.mkv", "épisode 02b.mkv", "Épisode 10.mkv"),
            noms.sortedWith(Naming.NATURAL),
        )
    }

    @Test
    fun reconnaitLesMediasEtLAudio() {
        assertTrue(Naming.isMedia("film.MKV"))
        assertTrue(Naming.isMedia("sans-extension", "video/mp4"))
        assertFalse(Naming.isMedia("notes.txt", "text/plain"))
        assertTrue(Naming.isAudio("chanson.flac"))
        assertFalse(Naming.isAudio("film.mp4", "video/mp4"))
    }

    @Test
    fun sousTitresDuMemeNomCommeVlc() {
        val voisins = listOf("Film.en.srt", "film.srt", "film.fr.ass", "film 2.srt", "Film.mkv", "autre.srt", "film.srt.bak")
        assertEquals(listOf("Film.en.srt", "film.fr.ass", "film.srt"), Naming.matchingSubtitles("Film.mkv", voisins))
    }

    @Test
    fun horlogeCommeLeBureau() {
        assertEquals("0:00", Naming.formatTime(-5))
        assertEquals("4:05", Naming.formatTime(245_400))
        assertEquals("1:02:03", Naming.formatTime(3_723_000))
    }

    @Test
    fun repriseSeulementEntreLeDebutEtLaFin() {
        assertNull(Naming.resumePosition(3_000, 600_000))
        assertEquals(120_000L, Naming.resumePosition(120_000, 600_000))
        assertNull(Naming.resumePosition(590_000, 600_000))
        assertEquals(60_000L, Naming.resumePosition(60_000, 0))
    }
}
