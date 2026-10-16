package com.anselmekyere.keaplayer

import android.Manifest
import android.app.Activity
import android.app.PictureInPictureParams
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.media.AudioManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.util.Rational
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.SeekBar
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

/**
 * Lecteur : libVLC (le moteur de VLC) pour décoder, KEAPlayer pour
 * l'interface : gestes, pistes, sous-titres, vitesse, égaliseur, captures,
 * image dans l'image et reprise de la lecture.
 */
class PlayerActivity : Activity() {
    private lateinit var libVlc: LibVLC
    private lateinit var player: MediaPlayer
    private lateinit var settings: Settings
    private lateinit var recents: Recents
    private lateinit var audio: AudioManager

    private lateinit var videoLayout: VLCVideoLayout
    private lateinit var controls: View
    private lateinit var osd: TextView
    private lateinit var loading: ProgressBar
    private lateinit var audioArt: ImageView
    private lateinit var title: TextView
    private lateinit var timeView: TextView
    private lateinit var durationView: TextView
    private lateinit var seek: SeekBar
    private lateinit var playButton: ImageButton
    private lateinit var speedView: TextView
    private lateinit var unlock: ImageButton

    private val handler = Handler(Looper.getMainLooper())
    private var fd: ParcelFileDescriptor? = null
    private var length = 0L
    private var pendingResume: Long? = null
    private var dragging = false
    private var locked = false
    private var hasVideo = false
    private var finished = false
    private var orientationChoice = 0 // 0 : automatique, 1 : paysage, 2 : portrait
    private var scaleIndex = 0

    private val items get() = Playlist.items
    private val current get() = items.getOrNull(Playlist.index)

    private val hideControls = Runnable { setControlsVisible(false) }
    private val hideOsd = Runnable { osd.visibility = View.GONE }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        settings = Settings(this)
        recents = Recents(this)
        audio = getSystemService(AUDIO_SERVICE) as AudioManager
        volumeControlStream = AudioManager.STREAM_MUSIC

        libVlc = LibVLC(
            this,
            arrayListOf(
                "--audio-time-stretch", // vitesse modifiée sans voix aiguë
                "--deinterlace=-1", // désentrelacement automatique (TNT, DVD, caméscope)
                "--deinterlace-mode=yadif",
                "--subsdec-encoding=Windows-1252", // sous-titres .srt français non UTF-8
                "--freetype-rel-fontsize=16",
            ),
        )
        player = MediaPlayer(libVlc)
        player.setEventListener { onPlayerEvent(it) }

        bindViews()
        enterImmersive()
        // La surface vidéo doit être attachée avant la première lecture.
        attachVideo()
        if (!handleIntent(intent)) finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** Liste préparée par l'accueil, ou fichier ouvert depuis une autre appli. */
    private fun handleIntent(intent: Intent): Boolean {
        if (intent.action == Intent.ACTION_VIEW) {
            val uri = intent.data ?: return false
            Playlist.items = listOf(Library.item(this, uri))
            Playlist.index = 0
        }
        if (items.isEmpty()) return false
        load(Playlist.index)
        return true
    }

    override fun onStart() {
        super.onStart()
        attachVideo()
    }

    override fun onStop() {
        super.onStop()
        saveResume()
        player.pause()
        if (attached) {
            player.detachViews()
            attached = false
        }
    }

    private var attached = false

    /** Sous-titres dessinés par libVLC ; TextureView pour pouvoir capturer l'image. */
    private fun attachVideo() {
        if (attached) return
        player.attachViews(videoLayout, null, true, true)
        player.setVideoScale(SCALES[scaleIndex].first)
        attached = true
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
        player.setEventListener(null as MediaPlayer.EventListener?)
        player.stop()
        player.release()
        libVlc.release()
        closeFd()
    }

    // ---------- Chargement ----------

    private fun load(index: Int) {
        saveResume()
        val item = items.getOrNull(index) ?: return
        Playlist.index = index
        finished = false
        length = 0
        hasVideo = false
        title.text = item.title
        loading.visibility = View.VISIBLE
        audioArt.visibility = if (item.audioOnly) View.VISIBLE else View.GONE

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
            return
        }
        media.setHWDecoderEnabled(true, false)
        player.setMedia(media)
        media.release()

        // Sous-titres du même nom trouvés dans le dossier : le premier est activé, comme sur le bureau.
        item.subtitles.forEachIndexed { i, sub ->
            runCatching { player.addSlave(IMedia.Slave.Type.Subtitle, Library.localCopy(this, sub), i == 0) }
        }

        pendingResume = recents.get(item.uri)?.let { Naming.resumePosition(it.position, it.duration) }
        player.setRate(settings.speed)
        player.setVolume(settings.volume)
        applyEqualizer()
        player.play()
        updateSpeedLabel()
        updateNavButtons()
        setControlsVisible(true)
    }

    private fun closeFd() {
        runCatching { fd?.close() }
        fd = null
    }

    private fun saveResume() {
        val item = current ?: return
        if (length <= 0) return
        val position = if (finished) length else player.time
        recents.save(item, position, length)
    }

    // ---------- Évènements de libVLC ----------

    private fun onPlayerEvent(event: MediaPlayer.Event) {
        when (event.type) {
            MediaPlayer.Event.Playing -> {
                loading.visibility = View.GONE
                playButton.setImageResource(R.drawable.ic_pause)
                playButton.contentDescription = getString(R.string.pause)
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                scheduleHide()
            }
            MediaPlayer.Event.Paused, MediaPlayer.Event.Stopped -> {
                playButton.setImageResource(R.drawable.ic_play)
                playButton.contentDescription = getString(R.string.play)
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            MediaPlayer.Event.LengthChanged -> {
                length = event.lengthChanged
                durationView.text = Naming.formatTime(length)
                pendingResume?.let { at ->
                    pendingResume = null
                    if (length <= 0 || at < length) {
                        player.setTime(at)
                        showOsd("Reprise à ${Naming.formatTime(at)}")
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
                if (hasVideo) {
                    audioArt.visibility = View.GONE
                    adaptOrientation()
                }
            }
            MediaPlayer.Event.EndReached -> {
                finished = true
                saveResume()
                if (Playlist.index < items.size - 1) load(Playlist.index + 1)
                else {
                    setControlsVisible(true)
                    playButton.setImageResource(R.drawable.ic_play)
                }
            }
            MediaPlayer.Event.EncounteredError -> {
                loading.visibility = View.GONE
                showOsd("Lecture impossible : ${current?.title ?: ""}")
            }
        }
    }

    // ---------- Commandes ----------

    private fun bindViews() {
        videoLayout = findViewById(R.id.video)
        controls = findViewById(R.id.controls)
        osd = findViewById(R.id.osd)
        loading = findViewById(R.id.loading)
        audioArt = findViewById(R.id.audio_art)
        title = findViewById(R.id.title)
        timeView = findViewById(R.id.time)
        durationView = findViewById(R.id.duration)
        seek = findViewById(R.id.seek)
        playButton = findViewById(R.id.play)
        speedView = findViewById(R.id.speed)
        unlock = findViewById(R.id.unlock)

        findViewById<View>(R.id.back).setOnClickListener { finish() }
        playButton.setOnClickListener { togglePlay() }
        findViewById<View>(R.id.previous).setOnClickListener { previous() }
        findViewById<View>(R.id.next).setOnClickListener { next() }
        findViewById<View>(R.id.tracks).setOnClickListener {
            TracksDialog(this, player, settings, onEqualizer = { applyEqualizer() }, onAddSubtitle = { pickSubtitle() }).show()
        }
        findViewById<View>(R.id.playlist).setOnClickListener { showPlaylist() }
        findViewById<View>(R.id.aspect).setOnClickListener { cycleScale() }
        findViewById<View>(R.id.rotate).setOnClickListener { cycleOrientation() }
        findViewById<View>(R.id.snapshot).setOnClickListener { snapshot() }
        findViewById<View>(R.id.pip).setOnClickListener { enterPip() }
        speedView.setOnClickListener { chooseSpeed() }
        findViewById<View>(R.id.lock).setOnClickListener { setLocked(true) }
        unlock.setOnClickListener { setLocked(false) }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) findViewById<View>(R.id.pip).visibility = View.GONE

        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser && length > 0) {
                    val t = length * progress / 1000
                    timeView.text = Naming.formatTime(t)
                    showOsd(Naming.formatTime(t))
                }
            }

            override fun onStartTrackingTouch(bar: SeekBar) {
                dragging = true
                handler.removeCallbacks(hideControls)
            }

            override fun onStopTrackingTouch(bar: SeekBar) {
                dragging = false
                if (length > 0) player.setTime(length * bar.progress / 1000)
                scheduleHide()
            }
        })

        val gestures = GestureDetector(this, Gestures())
        findViewById<View>(R.id.touch).setOnTouchListener { v, e ->
            if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) {
                scrollMode = ScrollMode.NONE
                if (seekPreview != null) {
                    player.setTime(seekPreview!!)
                    seekPreview = null
                }
            }
            gestures.onTouchEvent(e)
            if (e.actionMasked == MotionEvent.ACTION_UP) v.performClick()
            true
        }
    }

    private fun togglePlay() {
        if (player.isPlaying) {
            player.pause()
            setControlsVisible(true)
            handler.removeCallbacks(hideControls)
        } else {
            if (finished) {
                finished = false
                player.stop()
                player.play()
            } else {
                player.play()
            }
        }
    }

    private fun previous() {
        // Comme VLC : au-delà de 5 s, « précédent » revient au début du fichier.
        if (player.time > 5_000 || Playlist.index == 0) player.setTime(0) else load(Playlist.index - 1)
    }

    private fun next() {
        if (Playlist.index < items.size - 1) load(Playlist.index + 1)
    }

    private fun updateNavButtons() {
        findViewById<View>(R.id.previous).alpha = 1f
        findViewById<View>(R.id.next).alpha = if (Playlist.index < items.size - 1) 1f else 0.35f
        findViewById<View>(R.id.playlist).visibility = if (items.size > 1) View.VISIBLE else View.GONE
    }

    private fun seekBy(deltaMs: Long) {
        val target = (player.time + deltaMs).coerceIn(0, if (length > 0) length - 500 else Long.MAX_VALUE)
        player.setTime(target)
        showOsd("${if (deltaMs > 0) "+" else "−"}${abs(deltaMs) / 1000} s · ${Naming.formatTime(target)}")
    }

    private fun chooseSpeed() {
        val labels = SPEEDS.map { "${format(it)}×" }.toTypedArray()
        android.app.AlertDialog.Builder(this)
            .setTitle("Vitesse de lecture")
            .setSingleChoiceItems(labels, SPEEDS.indexOfFirst { it == settings.speed }.coerceAtLeast(0)) { d, i ->
                settings.speed = SPEEDS[i]
                player.setRate(SPEEDS[i])
                updateSpeedLabel()
                showOsd("Vitesse : ${labels[i]}")
                d.dismiss()
            }
            .show()
    }

    private fun updateSpeedLabel() {
        speedView.text = "${format(settings.speed)}×"
    }

    private fun cycleScale() {
        scaleIndex = (scaleIndex + 1) % SCALES.size
        player.setVideoScale(SCALES[scaleIndex].first)
        showOsd(SCALES[scaleIndex].second)
    }

    private fun cycleOrientation() {
        orientationChoice = (orientationChoice + 1) % 3
        requestedOrientation = when (orientationChoice) {
            1 -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            2 -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        }
        showOsd(arrayOf("Rotation automatique", "Paysage", "Portrait")[orientationChoice])
    }

    /** Une vidéo plus large que haute passe en paysage, sauf choix contraire de l'utilisateur. */
    private fun adaptOrientation() {
        if (orientationChoice != 0) return
        val track = player.currentVideoTrack ?: return
        if (track.width <= 0 || track.height <= 0) return
        requestedOrientation = if (track.width >= track.height) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        else ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
    }

    private fun applyEqualizer() {
        val preset = settings.equalizerPreset
        player.setEqualizer(if (preset >= 0) MediaPlayer.Equalizer.createFromPreset(preset) else null)
    }

    private fun showPlaylist() {
        val labels = items.mapIndexed { i, it -> if (i == Playlist.index) "▶  ${it.title}" else it.title }.toTypedArray()
        android.app.AlertDialog.Builder(this)
            .setTitle("Liste de lecture (${items.size})")
            .setItems(labels) { _, i -> if (i != Playlist.index) load(i) }
            .show()
    }

    private fun pickSubtitle() {
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
        val uri = data?.data
        if (requestCode != REQUEST_SUBTITLE || resultCode != RESULT_OK || uri == null) return
        val name = Library.displayName(this, uri)
        if (!Naming.isSubtitle(name)) {
            showOsd("Format de sous-titres non reconnu (.srt, .vtt, .ass, .ssa)")
            return
        }
        val ok = runCatching { player.addSlave(IMedia.Slave.Type.Subtitle, Library.localCopy(this, uri), true) }.getOrDefault(false)
        showOsd(if (ok) "Sous-titres : $name" else "Sous-titres illisibles")
    }

    // ---------- Affichage des commandes ----------

    private fun setControlsVisible(visible: Boolean) {
        handler.removeCallbacks(hideControls)
        if (locked || isInPip()) {
            controls.visibility = View.GONE
            return
        }
        controls.visibility = if (visible) View.VISIBLE else View.GONE
        if (visible) scheduleHide()
    }

    private fun scheduleHide() {
        handler.removeCallbacks(hideControls)
        if (player.isPlaying && !dragging) handler.postDelayed(hideControls, 3_500)
    }

    private fun setLocked(value: Boolean) {
        locked = value
        unlock.visibility = if (value) View.VISIBLE else View.GONE
        setControlsVisible(!value)
        showOsd(if (value) "Commandes verrouillées" else "Commandes déverrouillées")
    }

    private fun showOsd(text: String) {
        osd.text = text
        osd.visibility = View.VISIBLE
        handler.removeCallbacks(hideOsd)
        handler.postDelayed(hideOsd, 1_400)
    }

    @Suppress("DEPRECATION")
    private fun enterImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    // ---------- Gestes (comme VLC pour Android) ----------

    private enum class ScrollMode { NONE, SEEK, VOLUME, BRIGHTNESS }

    private var scrollMode = ScrollMode.NONE
    private var seekPreview: Long? = null
    private var gestureStartTime = 0L
    private var gestureStartValue = 0f

    private inner class Gestures : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            if (locked) {
                unlock.visibility = View.VISIBLE
                return true
            }
            setControlsVisible(controls.visibility != View.VISIBLE)
            return true
        }

        /** Double toucher : à gauche −10 s, à droite +10 s, au centre lecture/pause. */
        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (locked) return true
            val third = videoLayout.width / 3f
            when {
                e.x < third -> seekBy(-10_000)
                e.x > 2 * third -> seekBy(10_000)
                else -> togglePlay()
            }
            return true
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            if (locked || e1 == null) return false
            val totalX = e2.x - e1.x
            val totalY = e1.y - e2.y
            if (scrollMode == ScrollMode.NONE) {
                scrollMode = when {
                    abs(totalX) > abs(totalY) && length > 0 -> ScrollMode.SEEK
                    e1.x < videoLayout.width / 2f -> ScrollMode.BRIGHTNESS
                    else -> ScrollMode.VOLUME
                }
                gestureStartTime = player.time
                gestureStartValue = when (scrollMode) {
                    ScrollMode.VOLUME -> currentVolumePercent().toFloat()
                    ScrollMode.BRIGHTNESS -> currentBrightness()
                    else -> 0f
                }
            }
            when (scrollMode) {
                ScrollMode.SEEK -> {
                    // Toute la largeur de l'écran = 90 s, comme VLC.
                    val delta = (totalX / videoLayout.width * 90_000).toLong()
                    val target = (gestureStartTime + delta).coerceIn(0, length)
                    seekPreview = target
                    showOsd("${Naming.formatTime(target)} (${if (delta >= 0) "+" else "−"}${abs(delta) / 1000} s)")
                }
                ScrollMode.VOLUME -> {
                    val percent = (gestureStartValue + totalY / videoLayout.height * 200).toInt().coerceIn(0, 200)
                    setVolumePercent(percent)
                    showOsd("Volume : $percent %")
                }
                ScrollMode.BRIGHTNESS -> {
                    val value = (gestureStartValue + totalY / videoLayout.height).coerceIn(0.01f, 1f)
                    window.attributes = window.attributes.apply { screenBrightness = value }
                    showOsd("Luminosité : ${(value * 100).toInt()} %")
                }
                ScrollMode.NONE -> Unit
            }
            return true
        }
    }

    /** Volume de 0 à 200 % : le système jusqu'à 100 %, puis l'amplification de libVLC (comme le bureau). */
    private fun currentVolumePercent(): Int {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val system = audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100 / max
        return if (system >= 100) player.volume.coerceAtLeast(100) else system
    }

    private fun setVolumePercent(percent: Int) {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, (percent.coerceAtMost(100) * max + 50) / 100, 0)
        val vlc = if (percent > 100) percent else 100
        player.setVolume(vlc)
        settings.volume = vlc
    }

    private fun currentBrightness(): Float {
        val value = window.attributes.screenBrightness
        if (value >= 0) return value
        return runCatching {
            android.provider.Settings.System.getInt(contentResolver, android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255f
        }.getOrDefault(0.5f)
    }

    // ---------- Capture d'écran ----------

    private fun snapshot() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQUEST_STORAGE)
            return
        }
        val texture = findTexture(videoLayout)
        val bitmap = texture?.bitmap
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
        if (isInPictureInPictureMode) {
            controls.visibility = View.GONE
            osd.visibility = View.GONE
        } else {
            setControlsVisible(true)
        }
    }

    companion object {
        const val ACTION_PLAYLIST = "com.anselmekyere.keaplayer.PLAYLIST"
        private const val REQUEST_STORAGE = 3
        private const val REQUEST_SUBTITLE = 4

        val SPEEDS = floatArrayOf(0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f).toList()

        val SCALES = listOf(
            MediaPlayer.ScaleType.SURFACE_BEST_FIT to "Ajusté à l'écran",
            MediaPlayer.ScaleType.SURFACE_FIT_SCREEN to "Remplir l'écran (rogné)",
            MediaPlayer.ScaleType.SURFACE_FILL to "Étiré",
            MediaPlayer.ScaleType.SURFACE_16_9 to "16:9",
            MediaPlayer.ScaleType.SURFACE_4_3 to "4:3",
            MediaPlayer.ScaleType.SURFACE_ORIGINAL to "Taille d'origine",
        )

        fun format(speed: Float): String =
            if (speed == speed.toInt().toFloat()) speed.toInt().toString()
            else speed.toString().replace('.', ',')
    }
}
