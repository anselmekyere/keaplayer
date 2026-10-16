package com.anselmekyere.keaplayer

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import java.util.concurrent.Executors

/**
 * Miniatures de la barre de progression, comme l'aperçu au survol du bureau.
 * Android les extrait lui-même (MediaMetadataRetriever) pour les formats
 * qu'il sait lire ; sinon seul l'instant est affiché, comme pour l'audio.
 */
class SeekPreview(private val context: Context) {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val cache = LruCache<Long, Bitmap>(60)
    private var retriever: MediaMetadataRetriever? = null
    private var source: Uri? = null
    private var usable = false
    private var wanted = -1L

    /** Prépare l'extraction pour le fichier en cours (en arrière-plan). */
    fun open(uri: Uri?, video: Boolean) {
        val previous = retriever
        retriever = null
        source = uri
        usable = false
        cache.evictAll()
        executor.execute {
            runCatching { previous?.release() }
            if (uri == null || !video || !(uri.scheme == "content" || uri.scheme == "file")) return@execute
            val r = MediaMetadataRetriever()
            usable = runCatching { r.setDataSource(context, uri) }.isSuccess
            if (usable) retriever = r else runCatching { r.release() }
        }
    }

    /**
     * Image proche de [timeMs], regroupée par pas (≈ 200 par fichier) pour
     * que le cache resserve ; [onReady] reçoit null si aucune image n'est possible.
     */
    fun request(timeMs: Long, durationMs: Long, onReady: (Bitmap?) -> Unit) {
        val step = maxOf(1_000L, durationMs / 200)
        val bucket = timeMs / step * step
        cache.get(bucket)?.let { return onReady(it) }
        wanted = bucket
        val expected = source
        executor.execute {
            if (bucket != wanted || expected != source) return@execute
            val r = retriever
            val bitmap = if (usable && r != null) runCatching {
                if (android.os.Build.VERSION.SDK_INT >= 27) {
                    r.getScaledFrameAtTime(bucket * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 320, 180)
                } else {
                    r.getFrameAtTime(bucket * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                }
            }.getOrNull() else null
            if (bitmap != null) cache.put(bucket, bitmap)
            main.post { if (bucket == wanted && expected == source) onReady(bitmap) }
        }
    }

    fun release() {
        val r = retriever
        retriever = null
        executor.execute { runCatching { r?.release() } }
        executor.shutdown()
    }
}
