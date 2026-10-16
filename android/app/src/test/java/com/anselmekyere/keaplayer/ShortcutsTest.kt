package com.anselmekyere.keaplayer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShortcutsTest {
    @Test
    fun memesRaccourcisQueLeBureau() {
        assertEquals(Command.PlayPause, Shortcuts.commandFor("Space"))
        assertEquals(Command.Seek(10), Shortcuts.commandFor("ArrowRight"))
        assertEquals(Command.Seek(-60), Shortcuts.commandFor("ArrowLeft", shift = true))
        assertEquals(Command.Volume(5), Shortcuts.commandFor("ArrowUp"))
        assertEquals(Command.Mute, Shortcuts.commandFor("M"))
        assertEquals(Command.ToggleFullscreen, Shortcuts.commandFor("f"))
        assertEquals(Command.SpeedStep(0.25f), Shortcuts.commandFor("]"))
        assertEquals(Command.Speed(1f), Shortcuts.commandFor("="))
        assertEquals(Command.AudioDelay(-50), Shortcuts.commandFor("j"))
        assertEquals(Command.SubtitleDelay(50), Shortcuts.commandFor("H"))
        assertEquals(Command.Snapshot, Shortcuts.commandFor("S", shift = true))
        assertNull(Shortcuts.commandFor("s"))
        assertEquals(Command.Help, Shortcuts.commandFor("?"))
        assertEquals(Command.OpenFiles, Shortcuts.commandFor("o", ctrl = true))
        assertEquals(Command.OpenFolder, Shortcuts.commandFor("O", shift = true, ctrl = true))
        assertNull(Shortcuts.commandFor("m", ctrl = true))
    }

    @Test
    fun vitessesCommeLeSelecteurDuBureau() {
        assertEquals(listOf("0,25×", "0,5×", "0,75×", "1×", "1,25×", "1,5×", "2×"), Shortcuts.SPEEDS.map(Shortcuts::speedLabel))
        assertEquals(2f, Shortcuts.clampSpeed(2.25f))
        assertEquals(0.25f, Shortcuts.clampSpeed(0f))
    }
}
