package com.anselmekyere.keaplayer

import android.content.Context

/** Réglages du son conservés d'une séance à l'autre, comme sur le bureau ; la vitesse vaut pour la séance. */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var speed: Float = 1f

    /** Amplification de libVLC : 100 % (normal) à 200 %. */
    var volume: Int
        get() = prefs.getInt("volume", 100).coerceIn(100, 200)
        set(value) = prefs.edit().putInt("volume", value.coerceIn(100, 200)).apply()

    /** Préréglage d'égaliseur de VLC, ou -1 si désactivé. */
    var equalizerPreset: Int
        get() = prefs.getInt("equalizer", -1)
        set(value) = prefs.edit().putInt("equalizer", value).apply()
}
