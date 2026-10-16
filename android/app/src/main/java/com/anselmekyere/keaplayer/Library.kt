package com.anselmekyere.keaplayer

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.File

/** Un élément de la liste de lecture, avec ses sous-titres voisins. */
data class PlayItem(
    val uri: Uri,
    val title: String,
    val subtitles: List<Uri> = emptyList(),
    val audioOnly: Boolean = false,
)

/** Liste de lecture en cours, partagée entre l'accueil et le lecteur. */
object Playlist {
    var items: List<PlayItem> = emptyList()
    var index: Int = 0
}

object Library {
    fun displayName(context: Context, uri: Uri): String {
        if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
            runCatching {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
                }
            }
        }
        return Uri.decode(uri.lastPathSegment ?: uri.toString()).substringAfterLast('/')
    }

    fun item(context: Context, uri: Uri): PlayItem {
        val name = displayName(context, uri)
        val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
        return PlayItem(uri, name, audioOnly = Naming.isAudio(name, mime))
    }

    /** Garde l'accès au fichier après redémarrage (liste « Récents »). */
    fun keepAccess(context: Context, uri: Uri) {
        runCatching {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /**
     * Dossier choisi par l'utilisateur : ses médias en ordre naturel, chacun
     * avec les sous-titres du même nom (comme la version de bureau).
     */
    fun listFolder(context: Context, tree: Uri): List<PlayItem> {
        val parent = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val entries = mutableListOf<Triple<String, String, String?>>() // id, nom, type MIME
        context.contentResolver.query(
            parent,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            ),
            null, null, null,
        )?.use { c ->
            while (c.moveToNext()) entries += Triple(c.getString(0), c.getString(1) ?: "", c.getString(2))
        }
        val names = entries.map { it.second }
        val byName = entries.associateBy { it.second }
        return entries
            .filter { it.third != DocumentsContract.Document.MIME_TYPE_DIR && Naming.isMedia(it.second, it.third) }
            .sortedWith(compareBy(Naming.NATURAL) { it.second })
            .map { (id, name, mime) ->
                PlayItem(
                    uri = DocumentsContract.buildDocumentUriUsingTree(tree, id),
                    title = name,
                    subtitles = Naming.matchingSubtitles(name, names).mapNotNull { sub ->
                        byName[sub]?.let { DocumentsContract.buildDocumentUriUsingTree(tree, it.first) }
                    },
                    audioOnly = Naming.isAudio(name, mime),
                )
            }
    }

    /**
     * libVLC lit les sous-titres depuis un chemin de fichier : ceux d'un
     * fournisseur de documents (content://) sont copiés dans le cache.
     */
    fun localCopy(context: Context, uri: Uri): Uri {
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return uri
        val dir = File(context.cacheDir, "subtitles").apply { mkdirs() }
        val name = displayName(context, uri).replace(Regex("[\\\\/:*?\"<>|]"), "_")
        val file = File(dir, name)
        context.contentResolver.openInputStream(uri)?.use { input ->
            file.outputStream().use { input.copyTo(it) }
        }
        return Uri.fromFile(file)
    }
}
