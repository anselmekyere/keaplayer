package com.anselmekyere.keaplayer

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.PictureInPictureParams
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Typeface
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.text.InputType
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.util.Rational
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.Menu
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IMedia
import org.videolan.libvlc.util.VLCVideoLayout
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * La fenêtre de KEAPlayer, comme sur le bureau : barre de menus (Média,
 * Lecture, Audio, Vidéo, Sous-titres, Affichage, Aide), accueil, vidéo,
 * barre de commandes, panneau « Pistes, son et décalages » et liste de
 * lecture à droite. La lecture est confiée à libVLC, le moteur de VLC.
 */
class MainActivity : Activity() {
    private lateinit var libVlc: LibVLC
    private lateinit var player: MediaPlayer
    private lateinit var settings: Settings
    private lateinit var recents: Recents
    private lateinit var preview: SeekPreview

    // Vues
    private lateinit var menubar: View
    private lateinit var body: FrameLayout
    private lateinit var stage: FrameLayout
    private lateinit var videoLayout: VLCVideoLayout
    private lateinit var empty: View
    private lateinit var recentsList: LinearLayout
    private lateinit var recentsBox: View
    private lateinit var audioArt: ImageView
    private lateinit var osd: TextView
    private lateinit var loading: ProgressBar
    private lateinit var controls: View
    private lateinit var timeView: TextView
    private lateinit var durationView: TextView
    private lateinit var seek: SeekBar
    private lateinit var playButton: ImageButton
    private lateinit var muteButton: ImageButton
    private lateinit var volumeBar: SeekBar
    private lateinit var titleView: TextView
    private lateinit var badge: TextView
    private lateinit var speedView: TextView
    private lateinit var fullscreenButton: ImageButton
    private lateinit var previewBox: View
    private lateinit var previewImage: ImageView
    private lateinit var previewTime: TextView
    private lateinit var tracksPanel: View
    private lateinit var audioSpinner: Spinner
    private lateinit var subtitleSpinner: Spinner
    private lateinit var eqSpinner: Spinner
    private lateinit var normalizeBox: CheckBox
    private lateinit var audioDelayView: TextView
    private lateinit var subDelayView: TextView
    private lateinit var infoView: TextView
    private lateinit var playlistPanel: View
    private lateinit var playlistView: ListView

    // État
    private val items = mutableListOf<PlayItem>()
    private var index = -1
    private val current get() = items.getOrNull(index)
    private var fd: ParcelFileDescriptor? = null
    private var length = 0L
    private var pendingResume: Long? = null
    private var dragging = false
    private var finished = false
    private var hasVideo = false
    private var muted = false
    private var fullscreen = false
    private var attached = false
    private var scaleIndex = 0
    private var orientationChoice = 0
    private var updatingTracks = false
    private var audioTrackIds = listOf<Int>()
    /** Piste vidéo mise de côté pendant la lecture en arrière-plan (seul le son continue). */
    private var backgroundVideoTrack: Int? = null
    /** Fichier suivant ouvert en arrière-plan sans vidéo : rechargé avec l'image au retour. */
    private var openedWithoutVideo = false
    private var subtitleTrackIds = listOf<Int>()

    private val handler = Handler(Looper.getMainLooper())
    private val hideControls = Runnable { setControlsVisible(false) }
    private val hideOsd = Runnable { osd.visibility = View.GONE }
    private val dp get() = resources.displayMetrics.density

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        settings = Settings(this)
        recents = Recents(this)
        preview = SeekPreview(this)
        volumeControlStream = android.media.AudioManager.STREAM_MUSIC

        libVlc = LibVLC(
            this,
            arrayListOf(
                "--audio-time-stretch", // vitesse modifiée sans voix aiguë
                "--deinterlace=-1", // désentrelacement automatique, comme yadif sur le bureau
                "--deinterlace-mode=yadif",
                "--subsdec-encoding=Windows-1252", // .srt français non UTF-8
                "--freetype-rel-fontsize=16",
            ),
        )
        player = MediaPlayer(libVlc)
        player.setEventListener { onPlayerEvent(it) }
        PlaybackService.controller = remote

        bindViews()
        buildMenuBar()
        attachVideo()
        applyAudioSettings()
        showEmpty()
        body.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> adaptLayout() }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** « Ouvrir avec KEAPlayer » depuis une autre appli. */
    private fun handleIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        enqueue(listOf(Library.item(this, uri)), replace = true)
    }

    override fun onStart() {
        super.onStart()
        attachVideo()
        backgroundVideoTrack?.let { player.setVideoTrack(it) }
        backgroundVideoTrack = null
        if (openedWithoutVideo && current != null) play(index, resumeAt = player.time.coerceAtLeast(0))
    }

    override fun onStop() {
        super.onStop()
        saveResume()
        // Petite fenêtre (image dans l'image) fermée : on s'arrête là.
        // Sinon (écran éteint, autre appli) la lecture continue en arrière-plan.
        if (isInPip() && player.isPlaying) player.pause()
        if (player.isPlaying && hasVideo && !isChangingConfigurations) {
            // Plus de surface où dessiner : seul le son continue, la vidéo reprend au retour.
            backgroundVideoTrack = player.videoTrack.takeIf { it >= 0 }
            if (backgroundVideoTrack != null) player.setVideoTrack(-1)
        }
        if (attached) {
            player.detachViews()
            attached = false
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (PlaybackService.controller === remote) PlaybackService.controller = null
        PlaybackService.stop(this)
        handler.removeCallbacksAndMessages(null)
        player.setEventListener(null as MediaPlayer.EventListener?)
        player.stop()
        player.release()
        libVlc.release()
        preview.release()
        closeFd()
    }

    private fun attachVideo() {
        if (attached) return
        // Sous-titres dessinés par libVLC ; TextureView pour pouvoir capturer l'image.
        player.attachViews(videoLayout, null, true, true)
        player.setVideoScale(SCALES[scaleIndex].first)
        attached = true
    }

    // ---------- Vues ----------

    private fun bindViews() {
        menubar = findViewById(R.id.menubar)
        body = findViewById(R.id.body)
        stage = findViewById(R.id.stage)
        videoLayout = findViewById(R.id.video)
        empty = findViewById(R.id.empty)
        recentsList = findViewById(R.id.recents)
        recentsBox = findViewById(R.id.recents_box)
        audioArt = findViewById(R.id.audio_art)
        osd = findViewById(R.id.osd)
        loading = findViewById(R.id.loading)
        controls = findViewById(R.id.controls)
        timeView = findViewById(R.id.time)
        durationView = findViewById(R.id.duration)
        seek = findViewById(R.id.seek)
        playButton = findViewById(R.id.play)
        muteButton = findViewById(R.id.mute)
        volumeBar = findViewById(R.id.volume)
        titleView = findViewById(R.id.title)
        badge = findViewById(R.id.badge)
        speedView = findViewById(R.id.speed)
        fullscreenButton = findViewById(R.id.fullscreen)
        previewBox = findViewById(R.id.preview)
        previewImage = findViewById(R.id.preview_image)
        previewTime = findViewById(R.id.preview_time)
        tracksPanel = findViewById(R.id.tracks_panel)
        audioSpinner = findViewById(R.id.audio_track)
        subtitleSpinner = findViewById(R.id.subtitle_track)
        eqSpinner = findViewById(R.id.eq_preset)
        normalizeBox = findViewById(R.id.normalize)
        audioDelayView = findViewById(R.id.audio_delay)
        subDelayView = findViewById(R.id.sub_delay)
        infoView = findViewById(R.id.info)
        playlistPanel = findViewById(R.id.playlist_panel)
        playlistView = findViewById(R.id.playlist_items)

        findViewById<View>(R.id.open_files).setOnClickListener { run(Command.OpenFiles) }
        findViewById<View>(R.id.open_folder).setOnClickListener { run(Command.OpenFolder) }
        findViewById<View>(R.id.open_url).setOnClickListener { askUrl() }
        findViewById<View>(R.id.clear_recents).setOnClickListener {
            recents.clear()
            showRecents()
        }

        findViewById<View>(R.id.prev).setOnClickListener { run(Command.Previous) }
        playButton.setOnClickListener { run(Command.PlayPause) }
        findViewById<View>(R.id.next).setOnClickListener { run(Command.Next) }
        muteButton.setOnClickListener { run(Command.Mute) }
        findViewById<View>(R.id.frame).setOnClickListener { run(Command.Frame) }
        findViewById<View>(R.id.snapshot).setOnClickListener { run(Command.Snapshot) }
        findViewById<View>(R.id.tracks_toggle).setOnClickListener { run(Command.ToggleTracks) }
        findViewById<View>(R.id.playlist_toggle).setOnClickListener { run(Command.TogglePlaylist) }
        fullscreenButton.setOnClickListener { run(Command.ToggleFullscreen) }
        speedView.setOnClickListener { showSpeedMenu(it) }
        // Une longue pression montre l'infobulle, comme le survol des boutons du bureau.
        listOf(R.id.prev, R.id.play, R.id.next, R.id.mute, R.id.frame, R.id.snapshot, R.id.tracks_toggle,
            R.id.playlist_toggle, R.id.fullscreen, R.id.add_files, R.id.clear_playlist, R.id.close_playlist,
        ).forEach { id ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) findViewById<View>(id).let { v -> v.tooltipText = v.contentDescription }
        }

        volumeBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) setVolume(progress, announce = false)
            }

            override fun onStartTrackingTouch(bar: SeekBar) = keepControls()
            override fun onStopTrackingTouch(bar: SeekBar) = scheduleHide()
        })

        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (!fromUser || length <= 0) return
                val t = length * progress / 1000
                timeView.text = Naming.formatTime(t)
                showPreview(t)
            }

            override fun onStartTrackingTouch(bar: SeekBar) {
                dragging = true
                keepControls()
                if (length > 0) showPreview(length * bar.progress / 1000)
            }

            override fun onStopTrackingTouch(bar: SeekBar) {
                dragging = false
                previewBox.visibility = View.GONE
                if (length > 0) seekTo(length * bar.progress / 1000)
                scheduleHide()
            }
        })

        // Panneau Pistes.
        findViewById<View>(R.id.add_subtitle).setOnClickListener { pickSubtitle() }
        findViewById<View>(R.id.audio_delay_minus).setOnClickListener { run(Command.AudioDelay(-50)) }
        findViewById<View>(R.id.audio_delay_plus).setOnClickListener { run(Command.AudioDelay(50)) }
        findViewById<View>(R.id.sub_delay_minus).setOnClickListener { run(Command.SubtitleDelay(-50)) }
        findViewById<View>(R.id.sub_delay_plus).setOnClickListener { run(Command.SubtitleDelay(50)) }
        eqSpinner.adapter = spinnerAdapter(EQ_LABELS)
        eqSpinner.setSelection(settings.equalizerPreset)
        eqSpinner.onItemSelectedListener = onSelect { position ->
            if (position != settings.equalizerPreset) setEqualizer(position)
        }
        normalizeBox.isChecked = settings.normalize
        normalizeBox.setOnCheckedChangeListener { _, checked -> setNormalize(checked) }
        audioSpinner.onItemSelectedListener = onSelect { position ->
            if (!updatingTracks) audioTrackIds.getOrNull(position)?.let {
                player.setAudioTrack(it)
                showOsd("Piste audio : ${audioSpinner.selectedItem}")
            }
        }
        subtitleSpinner.onItemSelectedListener = onSelect { position ->
            if (!updatingTracks) subtitleTrackIds.getOrNull(position)?.let {
                player.setSpuTrack(it)
                showOsd(if (it == -1) "Sous-titres désactivés" else "Sous-titres : ${subtitleSpinner.selectedItem}")
            }
        }

        // Liste de lecture.
        playlistView.adapter = playlistAdapter
        playlistView.setOnItemClickListener { _, _, position, _ -> play(position) }
        findViewById<View>(R.id.add_files).setOnClickListener { openFiles(append = true) }
        findViewById<View>(R.id.clear_playlist).setOnClickListener { clearPlaylist() }
        findViewById<View>(R.id.close_playlist).setOnClickListener {
            if (playlistPanel.visibility == View.VISIBLE) setPanel(playlistPanel)
        }

        // Gestes sur la vidéo.
        val gestures = GestureDetector(this, Gestures())
        findViewById<View>(R.id.touch).setOnTouchListener { v, e ->
            if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) {
                scrollMode = ScrollMode.NONE
                seekPreviewTarget?.let {
                    seekTo(it)
                    seekPreviewTarget = null
                }
            }
            gestures.onTouchEvent(e)
            if (e.actionMasked == MotionEvent.ACTION_UP) v.performClick()
            true
        }
    }

    private fun spinnerAdapter(labels: List<String>) =
        ArrayAdapter(this, R.layout.item_spinner, labels).apply { setDropDownViewResource(R.layout.item_spinner) }

    private fun onSelect(block: (Int) -> Unit) = object : AdapterView.OnItemSelectedListener {
        override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = block(position)
        override fun onNothingSelected(parent: AdapterView<*>?) = Unit
    }

    /**
     * Comme le bureau : sous 720 dp la liste de lecture passe par-dessus la
     * vidéo et le titre, le badge et le volume disparaissent de la barre.
     */
    private fun adaptLayout() {
        val widthDp = body.width / dp
        val docked = playlistPanel.visibility == View.VISIBLE && widthDp >= 720 && !fullscreen
        val params = stage.layoutParams as FrameLayout.LayoutParams
        val margin = if (docked) (300 * dp).toInt() else 0
        if (params.marginEnd != margin) {
            params.marginEnd = margin
            stage.layoutParams = params
        }
        val narrow = stage.width / dp < 720
        val tiny = stage.width / dp < 520
        setGone(titleView, narrow)
        setGone(volumeBar, narrow)
        setGone(badge, narrow || badge.text.isNullOrEmpty())
        setGone(findViewById(R.id.frame), tiny)
        setGone(findViewById(R.id.snapshot), tiny)
    }

    private fun setGone(view: View, gone: Boolean) {
        val v = if (gone) View.GONE else View.VISIBLE
        if (view.visibility != v) view.visibility = v
    }

    // ---------- Barre de menus (src/main/menu.ts) ----------

    private fun buildMenuBar() {
        val bar = findViewById<LinearLayout>(R.id.menubar_items)
        listOf("Média", "Lecture", "Audio", "Vidéo", "Sous-titres", "Affichage", "Aide").forEach { name ->
            val item = TextView(this, null, 0, R.style.MenuBarItem).apply {
                text = name
                setOnClickListener { showMenu(name, it) }
            }
            bar.addView(item, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
    }

    /** Libellé avec le raccourci clavier en grisé, à droite, comme les menus du bureau. */
    private fun label(text: String, shortcut: String? = null): CharSequence {
        if (shortcut == null) return text
        val s = SpannableString("$text    $shortcut")
        s.setSpan(ForegroundColorSpan(getColor(R.color.muted)), text.length, s.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        s.setSpan(RelativeSizeSpan(0.85f), text.length, s.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return s
    }

    private fun showMenu(name: String, anchor: View) {
        val popup = PopupMenu(this, anchor)
        val m = popup.menu
        val actions = mutableMapOf<Int, () -> Unit>()
        var nextId = 1
        fun add(menu: Menu, text: String, shortcut: String? = null, enabled: Boolean = true, checked: Boolean? = null, group: Int = 0, action: () -> Unit) {
            val id = nextId++
            val item = menu.add(group, id, id, label(text, shortcut))
            item.isEnabled = enabled
            if (checked != null) {
                item.isCheckable = true
                item.isChecked = checked
            }
            actions[id] = action
        }
        val hasMedia = current != null

        when (name) {
            "Média" -> {
                add(m, "Ouvrir des fichiers…", "Ctrl+O") { run(Command.OpenFiles) }
                add(m, "Ouvrir un dossier…", "Ctrl+Maj+O") { run(Command.OpenFolder) }
                add(m, "Lire un flux réseau…") { askUrl() }
                add(m, "Capture d'écran", "Maj+S", enabled = hasMedia) { run(Command.Snapshot) }
                add(m, "Fermer le fichier", enabled = hasMedia) { clearPlaylist() }
                add(m, "Quitter") { finishAndRemoveTask() }
            }
            "Lecture" -> {
                add(m, if (player.isPlaying) "Pause" else "Lecture", "Espace", enabled = hasMedia) { run(Command.PlayPause) }
                add(m, "Précédent", "P", enabled = hasMedia) { run(Command.Previous) }
                add(m, "Suivant", "N", enabled = hasMedia) { run(Command.Next) }
                add(m, "Avancer de 10 s", "→", enabled = hasMedia) { run(Command.Seek(10)) }
                add(m, "Reculer de 10 s", "←", enabled = hasMedia) { run(Command.Seek(-10)) }
                add(m, "Avancer d'1 min", "Maj+→", enabled = hasMedia) { run(Command.Seek(60)) }
                add(m, "Reculer d'1 min", "Maj+←", enabled = hasMedia) { run(Command.Seek(-60)) }
                add(m, "Image suivante", "E", enabled = hasMedia) { run(Command.Frame) }
                val sub = m.addSubMenu("Vitesse")
                Shortcuts.SPEEDS.forEach { s ->
                    add(sub, Shortcuts.speedLabel(s), checked = abs(settings.speed - s) < 0.001f, group = 1) { run(Command.Speed(s)) }
                }
                sub.setGroupCheckable(1, true, true)
            }
            "Audio" -> {
                val sub = m.addSubMenu("Piste audio")
                val tracks = audioTracks()
                if (tracks.isEmpty()) add(sub, "Aucune", enabled = false) {}
                tracks.forEach { (id, title) ->
                    add(sub, title, checked = id == player.audioTrack, group = 1) {
                        player.setAudioTrack(id)
                        refreshTracks()
                    }
                }
                sub.setGroupCheckable(1, true, true)
                add(m, "Augmenter le volume", "↑") { run(Command.Volume(5)) }
                add(m, "Baisser le volume", "↓") { run(Command.Volume(-5)) }
                add(m, "Couper le son", "M", checked = muted) { run(Command.Mute) }
                val eq = m.addSubMenu("Égaliseur")
                EQ_LABELS.forEachIndexed { i, l -> add(eq, l, checked = i == settings.equalizerPreset, group = 2) { setEqualizer(i) } }
                eq.setGroupCheckable(2, true, true)
                add(m, "Normaliser le volume", checked = settings.normalize) { normalizeBox.isChecked = !settings.normalize }
                add(m, "Avancer le son (−50 ms)", "J", enabled = hasMedia) { run(Command.AudioDelay(-50)) }
                add(m, "Retarder le son (+50 ms)", "K", enabled = hasMedia) { run(Command.AudioDelay(50)) }
            }
            "Vidéo" -> {
                add(m, "Plein écran", "F", checked = fullscreen) { run(Command.ToggleFullscreen) }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    add(m, "Image dans l'image", enabled = hasVideo) { enterPip() }
                }
                val scale = m.addSubMenu("Format de l'image")
                SCALES.forEachIndexed { i, (_, l) -> add(scale, l, checked = i == scaleIndex, group = 1) { setScale(i) } }
                scale.setGroupCheckable(1, true, true)
                val rotation = m.addSubMenu("Rotation")
                ROTATIONS.forEachIndexed { i, l -> add(rotation, l, checked = i == orientationChoice, group = 2) { setOrientation(i) } }
                rotation.setGroupCheckable(2, true, true)
                add(m, "Capture d'écran", "Maj+S", enabled = hasMedia) { run(Command.Snapshot) }
            }
            "Sous-titres" -> {
                val sub = m.addSubMenu("Piste de sous-titres")
                add(sub, "Désactivés", checked = player.spuTrack == -1, group = 1) {
                    player.setSpuTrack(-1)
                    refreshTracks()
                }
                subtitleTracks().forEach { (id, title) ->
                    add(sub, title, checked = id == player.spuTrack, group = 1) {
                        player.setSpuTrack(id)
                        refreshTracks()
                    }
                }
                sub.setGroupCheckable(1, true, true)
                add(m, "Ajouter un fichier de sous-titres…", enabled = hasMedia) { pickSubtitle() }
                add(m, "Avancer (−50 ms)", "G", enabled = hasMedia) { run(Command.SubtitleDelay(-50)) }
                add(m, "Retarder (+50 ms)", "H", enabled = hasMedia) { run(Command.SubtitleDelay(50)) }
            }
            "Affichage" -> {
                add(m, "Liste de lecture", "L", checked = playlistPanel.visibility == View.VISIBLE) { run(Command.TogglePlaylist) }
                add(m, "Pistes, son et décalages", "T", checked = tracksPanel.visibility == View.VISIBLE) { run(Command.ToggleTracks) }
            }
            "Aide" -> {
                add(m, "Raccourcis clavier et gestes", "?") { run(Command.Help) }
                add(m, "À propos de KEAPlayer") { showAbout() }
            }
        }
        popup.setOnMenuItemClickListener { actions[it.itemId]?.invoke(); true }
        popup.show()
    }

    // ---------- Commandes (comme runMenuCommand du bureau) ----------

    private fun run(command: Command) {
        val hasMedia = current != null
        when (command) {
            Command.OpenFiles -> openFiles(append = false)
            Command.OpenFolder -> startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQUEST_FOLDER)
            Command.PlayPause -> if (hasMedia) togglePlay()
            Command.Previous -> if (hasMedia) previous()
            Command.Next -> if (hasMedia && index < items.size - 1) play(index + 1)
            is Command.Seek -> if (hasMedia) seekBy(command.seconds * 1000L)
            Command.Frame -> if (hasMedia) frameStep()
            Command.Snapshot -> if (hasMedia) snapshot()
            Command.Mute -> setMuted(!muted)
            is Command.Volume -> setVolume(settings.volume + command.delta)
            is Command.Speed -> setSpeed(command.value)
            is Command.SpeedStep -> setSpeed(settings.speed + command.delta)
            Command.CycleAudio -> cycle(audioSpinner)
            Command.CycleSubtitle -> cycle(subtitleSpinner)
            is Command.AudioDelay -> if (hasMedia) changeAudioDelay(command.ms)
            is Command.SubtitleDelay -> if (hasMedia) changeSubtitleDelay(command.ms)
            Command.TogglePlaylist -> setPanel(playlistPanel)
            Command.ToggleTracks -> setPanel(tracksPanel)
            Command.ToggleFullscreen -> setFullscreen(!fullscreen)
            Command.Escape -> when {
                tracksPanel.visibility == View.VISIBLE -> setPanel(tracksPanel)
                fullscreen -> setFullscreen(false)
            }
            Command.Help -> showHelp()
        }
    }

    // ---------- Clavier (Chromebook, tablette, Android TV) ----------

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val key = when (keyCode) {
            KeyEvent.KEYCODE_SPACE, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_DPAD_CENTER -> "Space"
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "ArrowRight"
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_ESCAPE -> "Escape"
            KeyEvent.KEYCODE_F11 -> "F11"
            KeyEvent.KEYCODE_MEDIA_NEXT -> "n"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "p"
            else -> event.unicodeChar.takeIf { it != 0 }?.toChar()?.toString()
        }
        // Les champs et listes gardent les flèches pour naviguer au clavier.
        val focus = currentFocus
        val navigating = focus != null && focus !== playButton && key?.startsWith("Arrow") == true &&
            (controls.visibility == View.VISIBLE || playlistPanel.visibility == View.VISIBLE || tracksPanel.visibility == View.VISIBLE)
        val command = if (key == null || navigating) null else Shortcuts.commandFor(key, event.isShiftPressed, event.isCtrlPressed)
        if (command != null) {
            run(command)
            if (current != null) setControlsVisible(true)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("API Activity historique, suffisante ici")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        when {
            playlistPanel.visibility == View.VISIBLE -> setPanel(playlistPanel)
            tracksPanel.visibility == View.VISIBLE -> setPanel(tracksPanel)
            fullscreen -> setFullscreen(false)
            else -> super.onBackPressed()
        }
    }

    // ---------- Ouverture ----------

    private fun openFiles(append: Boolean) {
        startActivityForResult(
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("video/*", "audio/*", "application/octet-stream"))
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            },
            if (append) REQUEST_ADD_FILES else REQUEST_FILES,
        )
    }

    private fun pickSubtitle() {
        if (current == null) return
        startActivityForResult(
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            },
            REQUEST_SUBTITLE,
        )
    }

    @Deprecated("API Activity historique, suffisante ici")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) return
        when (requestCode) {
            REQUEST_FILES, REQUEST_ADD_FILES -> {
                val uris = buildList {
                    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) add(clip.getItemAt(i).uri) }
                    if (isEmpty()) data.data?.let { add(it) }
                }
                uris.forEach { Library.keepAccess(this, it) }
                val selected = uris.map { Library.item(this, it) }.sortedWith(compareBy(Naming.NATURAL) { it.title })
                enqueue(selected, replace = requestCode == REQUEST_FILES)
            }
            REQUEST_FOLDER -> {
                val tree = data.data ?: return
                Library.keepAccess(this, tree)
                val found = runCatching { Library.listFolder(this, tree) }.getOrDefault(emptyList())
                if (found.isEmpty()) showOsd("Aucune vidéo ni musique dans ce dossier.") else enqueue(found, replace = true)
            }
            REQUEST_SUBTITLE -> {
                val uri = data.data ?: return
                val name = Library.displayName(this, uri)
                if (!Naming.isSubtitle(name)) {
                    showOsd("Format non reconnu (.srt, .vtt, .ass, .ssa)")
                    return
                }
                val ok = runCatching { player.addSlave(IMedia.Slave.Type.Subtitle, Library.localCopy(this, uri), true) }
                    .getOrDefault(false)
                showOsd(if (ok) "Sous-titres : $name" else "Sous-titres illisibles")
                handler.postDelayed({ refreshTracks() }, 500)
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
                if (uri.scheme.isNullOrEmpty()) showOsd("Adresse invalide")
                else enqueue(listOf(PlayItem(uri, uri.lastPathSegment ?: text)), replace = true)
            }
            .setNegativeButton("Annuler", null)
            .show()
    }

    /** Comme le bureau : ouvrir remplace la liste, « + » l'allonge. */
    private fun enqueue(newItems: List<PlayItem>, replace: Boolean) {
        if (newItems.isEmpty()) return
        if (replace || items.isEmpty()) {
            saveResume()
            items.clear()
            items.addAll(newItems)
            play(0)
        } else {
            items.addAll(newItems)
            showOsd("${newItems.size} ajouté${if (newItems.size > 1) "s" else ""} à la liste")
        }
        playlistAdapter.notifyDataSetChanged()
        updateNavButtons()
    }

    private fun clearPlaylist() {
        saveResume()
        player.stop()
        items.clear()
        index = -1
        closeFd()
        playlistAdapter.notifyDataSetChanged()
        PlaybackService.stop(this)
        showEmpty()
    }

    private fun removeFromPlaylist(position: Int) {
        if (position == index) {
            saveResume()
            items.removeAt(position)
            if (items.isEmpty()) return clearPlaylist()
            play(position.coerceAtMost(items.size - 1))
        } else {
            items.removeAt(position)
            if (position < index) index--
        }
        playlistAdapter.notifyDataSetChanged()
        updateNavButtons()
    }

    // ---------- Lecture ----------

    private fun play(i: Int, resumeAt: Long? = null) {
        saveResume()
        val item = items.getOrNull(i) ?: return
        index = i
        finished = false
        length = 0
        hasVideo = false
        titleView.text = item.title
        updateNotification(playing = true) // la lecture démarre juste après
        badge.text = ""
        infoView.text = ""
        empty.visibility = View.GONE
        loading.visibility = View.VISIBLE
        audioArt.visibility = if (item.audioOnly) View.VISIBLE else View.GONE
        playlistAdapter.notifyDataSetChanged()
        updateNavButtons()

        closeFd()
        val media = try {
            if (item.uri.scheme == "content") {
                val pfd = contentResolver.openFileDescriptor(item.uri, "r") ?: throw IllegalStateException()
                fd = pfd
                Media(libVlc, pfd.fileDescriptor)
            } else {
                Media(libVlc, item.uri)
            }
        } catch (e: Exception) {
            loading.visibility = View.GONE
            showOsd("Fichier inaccessible : ${item.title}")
            recents.remove(item.uri)
            updateNotification(playing = false)
            return
        }
        media.setHWDecoderEnabled(true, false)
        if (settings.normalize) media.addOption(":audio-filter=normvol")
        // En arrière-plan (fichier suivant de la liste), seul le son est décodé.
        backgroundVideoTrack = null
        openedWithoutVideo = !attached && !item.audioOnly
        if (openedWithoutVideo) media.addOption(":no-video")
        player.setMedia(media)
        media.release()

        // Sous-titres du même nom trouvés dans le dossier : le premier est activé, comme sur le bureau.
        item.subtitles.forEachIndexed { n, sub ->
            runCatching { player.addSlave(IMedia.Slave.Type.Subtitle, Library.localCopy(this, sub), n == 0) }
        }

        pendingResume = resumeAt ?: recents.get(item.uri)?.let { Naming.resumePosition(it.position, it.duration) }
        player.setRate(settings.speed)
        player.play()
        applyVolume()
        setEqualizer(settings.equalizerPreset, announce = false)
        preview.open(item.uri, !item.audioOnly)
        setControlsVisible(true)
    }

    private fun closeFd() {
        runCatching { fd?.close() }
        fd = null
    }

    private fun saveResume() {
        val item = current ?: return
        if (length <= 0) return
        recents.save(item, if (finished) length else player.time, length)
    }

    private fun togglePlay() {
        when {
            player.isPlaying -> player.pause()
            finished -> play(index, resumeAt = 0)
            else -> player.play()
        }
    }

    private fun previous() {
        // Comme VLC : au-delà de 5 s, « précédent » revient au début du fichier.
        if (player.time > 5_000 || index == 0) seekTo(0) else play(index - 1)
    }

    private fun seekTo(ms: Long) {
        val target = ms.coerceIn(0, if (length > 0) length - 500 else Long.MAX_VALUE)
        player.setTime(target)
        timeView.text = Naming.formatTime(target)
    }

    private fun seekBy(deltaMs: Long) {
        val target = (player.time + deltaMs).coerceAtLeast(0)
        seekTo(target)
        showOsd("${Naming.formatTime(target)} / ${Naming.formatTime(length)}")
    }

    /** Image par image (touche E), comme le bureau : en pause, une image plus loin. */
    private fun frameStep() {
        if (player.isPlaying) player.pause()
        val fps = player.currentVideoTrack?.let { t ->
            if (t.frameRateDen > 0) t.frameRateNum.toDouble() / t.frameRateDen else 0.0
        } ?: 0.0
        val frameMs = if (fps > 1) (1000 / fps).roundToInt().toLong() else 40L
        val nextFrame = runCatching { player.javaClass.getMethod("nextFrame") }.getOrNull()
        if (nextFrame != null) runCatching { nextFrame.invoke(player) } else seekTo(player.time + frameMs)
        showOsd("Image suivante")
    }

    private fun setSpeed(value: Float) {
        val speed = Shortcuts.clampSpeed(value)
        settings.speed = speed
        player.setRate(speed)
        speedView.text = "${Shortcuts.speedLabel(speed)} ▾"
        showOsd("Vitesse : ${Shortcuts.speedLabel(speed)}")
    }

    private fun showSpeedMenu(anchor: View) {
        val popup = PopupMenu(this, anchor)
        Shortcuts.SPEEDS.forEachIndexed { i, s ->
            popup.menu.add(1, i, i, Shortcuts.speedLabel(s)).apply {
                isCheckable = true
                isChecked = abs(s - settings.speed) < 0.001f
            }
        }
        popup.menu.setGroupCheckable(1, true, true)
        popup.setOnMenuItemClickListener { setSpeed(Shortcuts.SPEEDS[it.itemId]); true }
        popup.show()
        keepControls()
    }

    // ---------- Son : volume jusqu'à 200 %, égaliseur, normalisation ----------

    private fun applyAudioSettings() {
        volumeBar.progress = settings.volume
        speedView.text = "${Shortcuts.speedLabel(settings.speed)} ▾"
        updateMuteIcon()
    }

    private fun applyVolume() {
        player.setVolume(if (muted) 0 else settings.volume)
    }

    private fun setVolume(value: Int, announce: Boolean = true) {
        settings.volume = value
        if (muted && value > 0) muted = false
        applyVolume()
        volumeBar.progress = settings.volume
        updateMuteIcon()
        if (announce) showOsd("Volume : ${settings.volume} %")
    }

    private fun setMuted(value: Boolean) {
        muted = value
        applyVolume()
        updateMuteIcon()
        showOsd(if (muted) "Son coupé" else "Son rétabli")
    }

    private fun updateMuteIcon() {
        val off = muted || settings.volume == 0
        muteButton.setImageResource(if (off) R.drawable.ic_muted else R.drawable.ic_volume)
    }

    private fun setEqualizer(preset: Int, announce: Boolean = true) {
        settings.equalizerPreset = preset
        // « Plat » : pas d'égaliseur, comme le préréglage par défaut du bureau.
        player.setEqualizer(if (preset > 0) MediaPlayer.Equalizer.createFromPreset(preset) else null)
        if (eqSpinner.selectedItemPosition != preset) eqSpinner.setSelection(preset)
        if (announce) showOsd("Égaliseur : ${EQ_LABELS[preset]}")
    }

    /** La normalisation est un filtre de libVLC : le fichier est relancé à la même position. */
    private fun setNormalize(value: Boolean) {
        if (value == settings.normalize) return
        settings.normalize = value
        showOsd(if (value) "Normalisation activée" else "Normalisation désactivée")
        if (current != null && length > 0) {
            val wasPlaying = player.isPlaying
            play(index, resumeAt = player.time)
            if (!wasPlaying) handler.postDelayed({ player.pause() }, 300)
        }
    }

    // ---------- Pistes et décalages ----------

    private fun audioTracks(): List<Pair<Int, String>> =
        player.audioTracks.orEmpty().filter { it.id != -1 }.map { it.id to it.name }

    private fun subtitleTracks(): List<Pair<Int, String>> =
        player.spuTracks.orEmpty().filter { it.id != -1 }.map { it.id to it.name }

    private fun refreshTracks() {
        updatingTracks = true
        val audio = audioTracks()
        audioTrackIds = audio.map { it.first }
        audioSpinner.adapter = spinnerAdapter(audio.map { it.second }.ifEmpty { listOf("Aucune") })
        audioSpinner.isEnabled = audio.size > 1
        audioTrackIds.indexOf(player.audioTrack).takeIf { it >= 0 }?.let { audioSpinner.setSelection(it) }

        val subs = subtitleTracks()
        subtitleTrackIds = listOf(-1) + subs.map { it.first }
        subtitleSpinner.adapter = spinnerAdapter(listOf("Désactivés") + subs.map { it.second })
        subtitleSpinner.isEnabled = subs.isNotEmpty()
        subtitleSpinner.setSelection(subtitleTrackIds.indexOf(player.spuTrack).coerceAtLeast(0))
        handler.post { updatingTracks = false }

        audioDelayView.text = "${player.audioDelay / 1000} ms"
        subDelayView.text = "${player.spuDelay / 1000} ms"
        updateInfo()
    }

    private fun cycle(spinner: Spinner) {
        val count = spinner.adapter?.count ?: 0
        if (!spinner.isEnabled || count < 2) return
        spinner.setSelection((spinner.selectedItemPosition + 1) % count)
    }

    /** Pas de 50 ms ; libVLC compte en microsecondes. */
    private fun changeAudioDelay(ms: Int) {
        player.setAudioDelay(player.audioDelay + ms * 1000L)
        val value = player.audioDelay / 1000
        audioDelayView.text = "$value ms"
        showOsd("Décalage audio : $value ms")
    }

    private fun changeSubtitleDelay(ms: Int) {
        player.setSpuDelay(player.spuDelay + ms * 1000L)
        val value = player.spuDelay / 1000
        subDelayView.text = "$value ms"
        showOsd("Décalage sous-titres : $value ms")
    }

    /** Ligne d'information du panneau Pistes, comme le bureau : « H264 1920×1080 · 25 i/s · AAC ». */
    private fun updateInfo() {
        val parts = mutableListOf<String>()
        val video = player.currentVideoTrack
        if (video != null && video.width > 0) {
            val fps = if (video.frameRateDen > 0) video.frameRateNum.toDouble() / video.frameRateDen else 0.0
            parts += listOfNotNull(
                codecName(video.codec),
                "${video.width}×${video.height}",
                if (fps > 0) "${String.format(Locale.FRANCE, "%.2f", fps).removeSuffix(",00")} i/s" else null,
            ).joinToString(" ")
            badge.text = codecName(video.codec) ?: ""
        } else if (current?.audioOnly == true || !hasVideo) {
            parts += "Audio seul"
        }
        runCatching {
            val media = player.media
            if (media != null) {
                for (i in 0 until media.trackCount) {
                    val t = media.getTrack(i)
                    if (t != null && t.type == IMedia.Track.Type.Audio) {
                        codecName(t.codec)?.let { parts += it }
                        break
                    }
                }
                media.release()
            }
        }
        infoView.text = parts.joinToString(" · ")
        adaptLayout()
    }

    private fun codecName(codec: String?): String? =
        codec?.trim()?.takeIf { it.isNotEmpty() }?.uppercase(Locale.ROOT)

    // ---------- Évènements de libVLC ----------

    private fun onPlayerEvent(event: MediaPlayer.Event) {
        when (event.type) {
            MediaPlayer.Event.Playing -> {
                loading.visibility = View.GONE
                playButton.setImageResource(R.drawable.ic_pause)
                playButton.contentDescription = getString(R.string.pause)
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                refreshTracks()
                scheduleHide()
                updateNotification(playing = true)
                if (attached) askNotificationPermission()
            }
            MediaPlayer.Event.Paused, MediaPlayer.Event.Stopped -> {
                playButton.setImageResource(R.drawable.ic_play)
                playButton.contentDescription = getString(R.string.play)
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                setControlsVisible(true)
                // « Stopped » survient aussi au passage d'un fichier au suivant : la notification
                // ne repasse en pause que sur une vraie pause, sinon Android pourrait couper le son.
                if (event.type == MediaPlayer.Event.Paused) updateNotification(playing = false)
            }
            MediaPlayer.Event.LengthChanged -> {
                length = event.lengthChanged
                durationView.text = Naming.formatTime(length)
                pendingResume?.let { at ->
                    pendingResume = null
                    if (length <= 0 || at < length) {
                        player.setTime(at)
                        if (at > 0) showOsd("Reprise à ${Naming.formatTime(at)}")
                    }
                }
            }
            MediaPlayer.Event.TimeChanged -> {
                val t = event.timeChanged
                if (!dragging) {
                    timeView.text = Naming.formatTime(t)
                    if (length > 0) seek.progress = (t * 1000 / length).toInt()
                }
            }
            MediaPlayer.Event.Buffering -> {
                loading.visibility = if (event.buffering < 100f && !player.isPlaying) View.VISIBLE else View.GONE
            }
            MediaPlayer.Event.Vout -> {
                hasVideo = event.voutCount > 0
                if (hasVideo) audioArt.visibility = View.GONE
                if (fullscreen) adaptOrientation()
                updateInfo()
            }
            MediaPlayer.Event.ESAdded, MediaPlayer.Event.ESDeleted -> handler.post { refreshTracks() }
            MediaPlayer.Event.EndReached -> {
                finished = true
                saveResume()
                if (index < items.size - 1) play(index + 1) else {
                    setControlsVisible(true)
                    updateNotification(playing = false)
                }
            }
            MediaPlayer.Event.EncounteredError -> {
                loading.visibility = View.GONE
                showOsd("Erreur de lecture : ${current?.title ?: ""}")
            }
        }
    }

    // ---------- Accueil, panneaux, commandes ----------

    private fun showEmpty() {
        empty.visibility = View.VISIBLE
        controls.visibility = View.GONE
        audioArt.visibility = View.GONE
        loading.visibility = View.GONE
        tracksPanel.visibility = View.GONE
        titleView.text = ""
        showRecents()
    }

    private fun showRecents() {
        recentsList.removeAllViews()
        val list = recents.list().take(12)
        recentsBox.visibility = if (list.isEmpty()) View.GONE else View.VISIBLE
        list.forEach { r ->
            val row = layoutInflater.inflate(R.layout.item_media, recentsList, false)
            row.findViewById<TextView>(R.id.title).text = r.title
            row.findViewById<ImageView>(R.id.icon).setImageResource(if (r.audioOnly) R.drawable.ic_music else R.drawable.ic_movie)
            val progress = row.findViewById<ProgressBar>(R.id.progress)
            val subtitle = row.findViewById<TextView>(R.id.subtitle)
            if (r.duration > 0) {
                val done = r.position >= r.duration * 0.95
                subtitle.text = if (done) "Terminé · ${Naming.formatTime(r.duration)}"
                else "Reprise à ${Naming.formatTime(r.position)} / ${Naming.formatTime(r.duration)}"
                progress.progress = if (done) 1000 else (r.position * 1000 / r.duration).toInt()
            } else {
                subtitle.text = ""
                progress.visibility = View.GONE
            }
            row.background = getDrawable(R.drawable.item_current)
            row.isFocusable = true
            row.setOnClickListener { enqueue(listOf(PlayItem(r.uri, r.title, audioOnly = r.audioOnly)), replace = true) }
            row.setOnLongClickListener {
                recents.remove(r.uri)
                showRecents()
                true
            }
            recentsList.addView(row)
        }
    }

    /** Un seul panneau flottant à la fois sur la vidéo, comme setPanel du bureau. */
    private fun setPanel(panel: View) {
        val open = panel.visibility != View.VISIBLE
        if (panel === tracksPanel) {
            if (open && current == null) return
            tracksPanel.visibility = if (open) View.VISIBLE else View.GONE
            if (open) {
                refreshTracks()
                setControlsVisible(true)
            } else scheduleHide()
        } else {
            playlistPanel.visibility = if (open) View.VISIBLE else View.GONE
            if (open) playlistView.setSelection(index.coerceAtLeast(0))
        }
        findViewById<View>(R.id.tracks_toggle).isActivated = tracksPanel.visibility == View.VISIBLE
        tintToggle(R.id.tracks_toggle, tracksPanel.visibility == View.VISIBLE)
        tintToggle(R.id.playlist_toggle, playlistPanel.visibility == View.VISIBLE)
        adaptLayout()
    }

    /** Bouton actif en orange, comme aria-expanded="true" sur le bureau. */
    private fun tintToggle(id: Int, active: Boolean) {
        findViewById<ImageButton>(id).imageTintList =
            android.content.res.ColorStateList.valueOf(getColor(if (active) R.color.accent else R.color.text))
    }

    private fun updateNavButtons() {
        findViewById<View>(R.id.next).alpha = if (index < items.size - 1) 1f else 0.4f
    }

    private fun setControlsVisible(visible: Boolean) {
        handler.removeCallbacks(hideControls)
        if (current == null || isInPip()) {
            controls.visibility = View.GONE
            return
        }
        controls.visibility = if (visible) View.VISIBLE else View.GONE
        if (fullscreen) menubar.visibility = View.GONE
        if (visible) scheduleHide()
    }

    private fun keepControls() = handler.removeCallbacks(hideControls)

    /** Commandes masquées après quelques secondes d'inactivité pendant la lecture, comme le bureau. */
    private fun scheduleHide() {
        handler.removeCallbacks(hideControls)
        if (player.isPlaying && !dragging && tracksPanel.visibility != View.VISIBLE) {
            handler.postDelayed(hideControls, 3_000)
        }
    }

    private fun showOsd(text: String) {
        osd.text = text
        osd.visibility = View.VISIBLE
        handler.removeCallbacks(hideOsd)
        handler.postDelayed(hideOsd, 1_600)
    }

    private fun showPreview(t: Long) {
        previewTime.text = Naming.formatTime(t)
        previewBox.visibility = View.VISIBLE
        val bar = seek
        val loc = IntArray(2)
        val stageLoc = IntArray(2)
        bar.getLocationInWindow(loc)
        stage.getLocationInWindow(stageLoc)
        val usable = bar.width - bar.paddingLeft - bar.paddingRight
        val x = loc[0] - stageLoc[0] + bar.paddingLeft + usable * bar.progress / 1000f
        previewBox.post {
            val half = previewBox.width / 2f
            previewBox.translationX = (x - half).coerceIn(0f, (stage.width - previewBox.width).toFloat())
            previewBox.translationY = -(stage.height - (loc[1] - stageLoc[1]) + 8 * dp)
        }
        if (current?.audioOnly == true || !hasVideo) {
            previewImage.visibility = View.GONE
            return
        }
        preview.request(t, length) { bitmap ->
            if (bitmap != null) {
                previewImage.setImageBitmap(bitmap)
                previewImage.visibility = View.VISIBLE
            } else {
                previewImage.visibility = View.GONE
            }
        }
    }

    // ---------- Plein écran, format, rotation ----------

    @Suppress("DEPRECATION")
    private fun setFullscreen(value: Boolean) {
        fullscreen = value
        menubar.visibility = if (value) View.GONE else View.VISIBLE
        fullscreenButton.setImageResource(if (value) R.drawable.ic_fullscreen_exit else R.drawable.ic_fullscreen)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                if (value) {
                    it.hide(WindowInsets.Type.systemBars())
                    it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    it.show(WindowInsets.Type.systemBars())
                }
            }
        } else {
            window.decorView.systemUiVisibility = if (value) {
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            } else 0
        }
        if (value) adaptOrientation() else if (orientationChoice == 0) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
        showOsd(if (value) "Plein écran — Échap ou retour pour quitter" else "Plein écran désactivé")
        adaptLayout()
    }

    /** En plein écran, une vidéo plus large que haute passe en paysage. */
    private fun adaptOrientation() {
        if (orientationChoice != 0) return
        val track = player.currentVideoTrack ?: return
        if (track.width <= 0 || track.height <= 0) return
        requestedOrientation = if (track.width >= track.height) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    private fun setScale(i: Int) {
        scaleIndex = i
        player.setVideoScale(SCALES[i].first)
        showOsd("Format : ${SCALES[i].second}")
    }

    private fun setOrientation(i: Int) {
        orientationChoice = i
        requestedOrientation = when (i) {
            1 -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            2 -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
        showOsd("Rotation : ${ROTATIONS[i]}")
    }

    // ---------- Gestes ----------

    private enum class ScrollMode { NONE, SEEK, VOLUME, BRIGHTNESS }

    private var scrollMode = ScrollMode.NONE
    private var seekPreviewTarget: Long? = null
    private var gestureStartTime = 0L
    private var gestureStartValue = 0f

    private inner class Gestures : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        /** Toucher : affiche les commandes, puis lecture/pause (le clic sur la vidéo du bureau). */
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            if (current == null) return false
            when {
                tracksPanel.visibility == View.VISIBLE -> setPanel(tracksPanel)
                controls.visibility != View.VISIBLE -> setControlsVisible(true)
                else -> togglePlay()
            }
            return true
        }

        /** Double toucher : plein écran au centre (double-clic du bureau), ±10 s sur les côtés. */
        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (current == null) return false
            val third = stage.width / 3f
            when {
                e.x < third -> run(Command.Seek(-10))
                e.x > 2 * third -> run(Command.Seek(10))
                else -> run(Command.ToggleFullscreen)
            }
            return true
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            if (current == null || e1 == null) return false
            val totalX = e2.x - e1.x
            val totalY = e1.y - e2.y
            if (scrollMode == ScrollMode.NONE) {
                scrollMode = when {
                    abs(totalX) > abs(totalY) && length > 0 -> ScrollMode.SEEK
                    e1.x < stage.width / 2f -> ScrollMode.BRIGHTNESS
                    else -> ScrollMode.VOLUME
                }
                gestureStartTime = player.time
                gestureStartValue = when (scrollMode) {
                    ScrollMode.VOLUME -> settings.volume.toFloat()
                    ScrollMode.BRIGHTNESS -> currentBrightness()
                    else -> 0f
                }
            }
            when (scrollMode) {
                ScrollMode.SEEK -> {
                    // Toute la largeur = 90 s, comme VLC pour Android.
                    val delta = (totalX / stage.width * 90_000).toLong()
                    val target = (gestureStartTime + delta).coerceIn(0, length)
                    seekPreviewTarget = target
                    showOsd("${Naming.formatTime(target)} (${if (delta >= 0) "+" else "−"}${abs(delta) / 1000} s)")
                }
                ScrollMode.VOLUME -> setVolume((gestureStartValue + totalY / stage.height * 200).toInt())
                ScrollMode.BRIGHTNESS -> {
                    val value = (gestureStartValue + totalY / stage.height).coerceIn(0.01f, 1f)
                    window.attributes = window.attributes.apply { screenBrightness = value }
                    showOsd("Luminosité : ${(value * 100).toInt()} %")
                }
                ScrollMode.NONE -> Unit
            }
            return true
        }
    }

    private fun currentBrightness(): Float {
        val value = window.attributes.screenBrightness
        if (value >= 0) return value
        return runCatching {
            android.provider.Settings.System.getInt(contentResolver, android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255f
        }.getOrDefault(0.5f)
    }

    // ---------- Liste de lecture ----------

    private val playlistAdapter = object : BaseAdapter() {
        override fun getCount() = items.size
        override fun getItem(position: Int) = items[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: layoutInflater.inflate(R.layout.item_playlist, parent, false)
            val name = view.findViewById<TextView>(R.id.name)
            name.text = items[position].title
            val isCurrent = position == index
            name.setTextColor(getColor(if (isCurrent) R.color.accent else R.color.text))
            name.setTypeface(null, if (isCurrent) Typeface.BOLD else Typeface.NORMAL)
            view.findViewById<View>(R.id.remove).setOnClickListener { removeFromPlaylist(position) }
            return view
        }
    }

    // ---------- Capture d'écran ----------

    private fun snapshot() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQUEST_STORAGE)
            return
        }
        val bitmap = findTexture(videoLayout)?.bitmap
        if (!hasVideo || bitmap == null) {
            showOsd("Pas d'image à capturer")
            return
        }
        val stamp = Naming.formatTime(player.time).replace(':', '-')
        val day = SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.ROOT).format(Date())
        val name = "${Naming.stem(current?.title ?: "KEAPlayer")} $stamp ($day).png"
        val saved = runCatching { savePicture(bitmap, name) }.isSuccess
        bitmap.recycle()
        showOsd(if (saved) "Capture enregistrée dans Images/KEAPlayer" else "Capture impossible")
    }

    private fun findTexture(view: View): TextureView? {
        if (view is TextureView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findTexture(view.getChildAt(i))?.let { return it }
        return null
    }

    private fun savePicture(bitmap: Bitmap, name: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name)
                put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/KEAPlayer")
            }
            val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("MediaStore")
            contentResolver.openOutputStream(uri)?.use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } else {
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "KEAPlayer")
            dir.mkdirs()
            val file = File(dir, name)
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            MediaScannerConnection.scanFile(this, arrayOf(file.absolutePath), arrayOf("image/png"), null)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_STORAGE && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) snapshot()
    }

    // ---------- Lecture en arrière-plan ----------

    /** Commandes de la notification, de l'écran de verrouillage et du casque. */
    private val remote = object : PlaybackService.Controller {
        override fun togglePlay() = this@MainActivity.togglePlay()
        override fun next() = this@MainActivity.run(Command.Next)
        override fun previous() = this@MainActivity.run(Command.Previous)
        override fun pause() {
            if (player.isPlaying) player.pause()
        }
        override fun stopPlayback() {
            pause()
            saveResume()
            PlaybackService.stop(this@MainActivity)
        }
    }

    private fun updateNotification(playing: Boolean) {
        val item = current ?: return PlaybackService.stop(this)
        PlaybackService.update(
            this,
            PlaybackService.State(item.title, playing, player.time.coerceAtLeast(0), length, settings.speed),
        )
    }

    /** Android 13 et plus : la notification de lecture demande une autorisation (demandée une fois). */
    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        if (prefs.getBoolean("asked_notifications", false)) return
        prefs.edit().putBoolean("asked_notifications", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    // ---------- Image dans l'image ----------

    private fun isInPip() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode

    private fun enterPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !hasVideo) return
        val track = player.currentVideoTrack
        val ratio = if (track != null && track.width > 0 && track.height > 0) {
            Rational(track.width, track.height).let {
                // Android refuse les formats plus extrêmes que 2,39:1.
                if (it.toFloat() > 2.39f) Rational(239, 100) else if (it.toFloat() < 0.42f) Rational(100, 239) else it
            }
        } else Rational(16, 9)
        runCatching { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(ratio).build()) }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Bouton Accueil pendant une vidéo : elle continue dans une petite fenêtre.
        if (player.isPlaying && hasVideo) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        menubar.visibility = if (isInPictureInPictureMode || fullscreen) View.GONE else View.VISIBLE
        if (isInPictureInPictureMode) {
            controls.visibility = View.GONE
            osd.visibility = View.GONE
            tracksPanel.visibility = View.GONE
            playlistPanel.visibility = View.GONE
        } else {
            setControlsVisible(true)
        }
    }

    // ---------- Aide ----------

    private fun showHelp() {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * dp).toInt(), (8 * dp).toInt(), (20 * dp).toInt(), 0)
        }
        fun section(title: String, rows: List<Pair<String, String>>) {
            content.addView(TextView(this).apply {
                text = title
                setTextColor(getColor(R.color.muted))
                setTypeface(typeface, Typeface.BOLD)
                setPadding(0, (12 * dp).toInt(), 0, (4 * dp).toInt())
            })
            rows.forEach { (key, what) ->
                content.addView(LinearLayout(this).apply {
                    addView(TextView(this@MainActivity).apply {
                        text = key
                        setTypeface(typeface, Typeface.BOLD)
                        setTextColor(getColor(R.color.text))
                    }, LinearLayout.LayoutParams((130 * dp).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT))
                    addView(TextView(this@MainActivity).apply {
                        text = what
                        setTextColor(getColor(R.color.muted))
                    }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                    setPadding(0, (3 * dp).toInt(), 0, (3 * dp).toInt())
                })
            }
        }
        section("Clavier", Shortcuts.HELP)
        section("Écran tactile", Shortcuts.GESTURES)
        AlertDialog.Builder(this)
            .setTitle("Raccourcis clavier et gestes")
            .setView(android.widget.ScrollView(this).apply { addView(content) })
            .setPositiveButton("Fermer", null)
            .show()
    }

    private fun showAbout() {
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""
        AlertDialog.Builder(this)
            .setTitle("KEAPlayer $version")
            .setMessage(
                "Lecteur multimédia inspiré de VLC.\n\n" +
                    "Conçu par ERIC KYERE.\n\n" +
                    "La lecture est assurée par libVLC (VideoLAN, licence LGPL 2.1 ou ultérieure).",
            )
            .setPositiveButton("Fermer", null)
            .show()
    }

    companion object {
        private const val REQUEST_FILES = 1
        private const val REQUEST_FOLDER = 2
        private const val REQUEST_STORAGE = 3
        private const val REQUEST_SUBTITLE = 4
        private const val REQUEST_ADD_FILES = 5
        private const val REQUEST_NOTIFICATIONS = 6

        val SCALES = listOf(
            MediaPlayer.ScaleType.SURFACE_BEST_FIT to "Ajusté à l'écran",
            MediaPlayer.ScaleType.SURFACE_FIT_SCREEN to "Remplir l'écran (rogné)",
            MediaPlayer.ScaleType.SURFACE_FILL to "Étiré",
            MediaPlayer.ScaleType.SURFACE_16_9 to "16:9",
            MediaPlayer.ScaleType.SURFACE_4_3 to "4:3",
            MediaPlayer.ScaleType.SURFACE_ORIGINAL to "Taille d'origine",
        )

        val ROTATIONS = listOf("Automatique", "Paysage", "Portrait")
    }
}
