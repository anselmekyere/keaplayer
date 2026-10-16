package com.anselmekyere.keaplayer

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/** Fichiers récemment lus et position de reprise (comme le ResumeStore du bureau). */
data class Recent(val uri: Uri, val title: String, val position: Long, val duration: Long, val audioOnly: Boolean)

class Recents(context: Context) {
    private val prefs = context.getSharedPreferences("recents", Context.MODE_PRIVATE)

    fun list(): List<Recent> {
        val array = runCatching { JSONArray(prefs.getString(KEY, "[]")) }.getOrElse { JSONArray() }
        return (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            Recent(
                Uri.parse(o.getString("uri")),
                o.optString("title"),
                o.optLong("position"),
                o.optLong("duration"),
                o.optBoolean("audioOnly"),
            )
        }
    }

    fun get(uri: Uri): Recent? = list().firstOrNull { it.uri == uri }

    fun save(item: PlayItem, position: Long, duration: Long) {
        val others = list().filter { it.uri != item.uri }
        val entries = listOf(Recent(item.uri, item.title, position, duration, item.audioOnly)) + others
        write(entries.take(MAX))
    }

    fun remove(uri: Uri) = write(list().filter { it.uri != uri })

    fun clear() = write(emptyList())

    private fun write(entries: List<Recent>) {
        val array = JSONArray()
        entries.forEach {
            array.put(
                JSONObject()
                    .put("uri", it.uri.toString())
                    .put("title", it.title)
                    .put("position", it.position)
                    .put("duration", it.duration)
                    .put("audioOnly", it.audioOnly),
            )
        }
        prefs.edit().putString(KEY, array.toString()).apply()
    }

    private companion object {
        const val KEY = "items"
        const val MAX = 40
    }
}
