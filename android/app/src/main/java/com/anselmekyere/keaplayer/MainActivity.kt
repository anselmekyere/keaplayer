package com.anselmekyere.keaplayer

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ImageView
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

/** Accueil : ouvrir des fichiers, un dossier ou un lien, et reprendre les lectures récentes. */
class MainActivity : Activity() {
    private lateinit var recents: Recents
    private lateinit var list: ListView
    private lateinit var empty: View
    private var items: List<Recent> = emptyList()

    private val adapter = object : BaseAdapter() {
        override fun getCount() = items.size
        override fun getItem(position: Int) = items[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: layoutInflater.inflate(R.layout.item_media, parent, false)
            val r = items[position]
            view.findViewById<TextView>(R.id.title).text = r.title
            view.findViewById<ImageView>(R.id.icon).setImageResource(if (r.audioOnly) R.drawable.ic_music else R.drawable.ic_movie)
            val progress = view.findViewById<ProgressBar>(R.id.progress)
            val subtitle = view.findViewById<TextView>(R.id.subtitle)
            if (r.duration > 0) {
                val done = r.position >= r.duration * 0.95
                subtitle.text = if (done) "Terminé · ${Naming.formatTime(r.duration)}"
                else "Reprise à ${Naming.formatTime(r.position)} / ${Naming.formatTime(r.duration)}"
                progress.progress = if (done) 1000 else (r.position * 1000 / r.duration).toInt()
                progress.visibility = View.VISIBLE
            } else {
                subtitle.text = r.uri.scheme?.takeIf { it.startsWith("http") || it == "rtsp" }?.let { "Flux réseau" } ?: ""
                progress.visibility = View.GONE
            }
            return view
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        recents = Recents(this)
        list = findViewById(R.id.recents)
        empty = findViewById(R.id.empty)
        list.adapter = adapter

        findViewById<View>(R.id.open_files).setOnClickListener {
            startActivityForResult(
                Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("video/*", "audio/*", "application/octet-stream"))
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                },
                REQUEST_FILES,
            )
        }
        findViewById<View>(R.id.open_folder).setOnClickListener {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQUEST_FOLDER)
        }
        findViewById<View>(R.id.open_url).setOnClickListener { askUrl() }
        findViewById<View>(R.id.clear_recents).setOnClickListener {
            recents.clear()
            refresh()
        }
        list.setOnItemClickListener { _, _, position, _ ->
            val r = items[position]
            play(listOf(PlayItem(r.uri, r.title, audioOnly = r.audioOnly)), 0)
        }
        list.setOnItemLongClickListener { _, _, position, _ ->
            val r = items[position]
            AlertDialog.Builder(this)
                .setTitle(r.title)
                .setItems(arrayOf("Retirer des récents")) { _, _ ->
                    recents.remove(r.uri)
                    refresh()
                }
                .show()
            true
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        items = recents.list()
        adapter.notifyDataSetChanged()
        empty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        list.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
    }

    @Deprecated("API Activity historique, suffisante ici")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) return
        when (requestCode) {
            REQUEST_FILES -> {
                val uris = buildList {
                    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) add(clip.getItemAt(i).uri) }
                    if (isEmpty()) data.data?.let { add(it) }
                }
                uris.forEach { Library.keepAccess(this, it) }
                val selected = uris.map { Library.item(this, it) }.sortedWith(compareBy(Naming.NATURAL) { it.title })
                if (selected.isNotEmpty()) play(selected, 0)
            }
            REQUEST_FOLDER -> {
                val tree = data.data ?: return
                Library.keepAccess(this, tree)
                val found = runCatching { Library.listFolder(this, tree) }.getOrDefault(emptyList())
                if (found.isEmpty()) {
                    Toast.makeText(this, "Aucune vidéo ni musique dans ce dossier.", Toast.LENGTH_LONG).show()
                } else {
                    play(found, 0)
                }
            }
        }
    }

    private fun askUrl() {
        val input = EditText(this).apply {
            hint = "https://… ou rtsp://…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
        }
        AlertDialog.Builder(this)
            .setTitle("Lire un flux réseau")
            .setView(input)
            .setPositiveButton("Lire") { _, _ ->
                val text = input.text.toString().trim()
                val uri = Uri.parse(text)
                if (uri.scheme.isNullOrEmpty()) {
                    Toast.makeText(this, "Adresse invalide.", Toast.LENGTH_SHORT).show()
                } else {
                    play(listOf(PlayItem(uri, uri.lastPathSegment ?: text)), 0)
                }
            }
            .setNegativeButton("Annuler", null)
            .show()
    }

    private fun play(items: List<PlayItem>, index: Int) {
        Playlist.items = items
        Playlist.index = index
        startActivity(Intent(this, PlayerActivity::class.java).setAction(PlayerActivity.ACTION_PLAYLIST))
    }

    private companion object {
        const val REQUEST_FILES = 1
        const val REQUEST_FOLDER = 2
    }
}
