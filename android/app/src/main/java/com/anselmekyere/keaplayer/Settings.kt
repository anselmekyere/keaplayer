package com.anselmekyere.keaplayer

import android.content.Context

/**
 * Réglages du son conservés d'une séance à l'autre, comme
 * « keaplayer.audio » sur le bureau : volume (jusqu'à 200 %), égaliseur,
 * normalisation. La vitesse vaut pour la séance.
 */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var speed: Float = 1f

    var volume: Int
        get() = prefs.getInt("volume2", 100).coerceIn(0, 200)
        set(value) = prefs.edit().putInt("volume2", value.coerceIn(0, 200)).apply()

    /** Indice dans [EQ_LABELS] ; 0 (« Plat ») désactive l'égaliseur. */
    var equalizerPreset: Int
        get() = prefs.getInt("equalizer2", 0).coerceIn(0, EQ_LABELS.size - 1)
        set(value) = prefs.edit().putInt("equalizer2", value).apply()

    var normalize: Boolean
        get() = prefs.getBoolean("normalize", false)
        set(value) = prefs.edit().putBoolean("normalize", value).apply()
}
