package com.anselmekyere.keaplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder

/**
 * Lecture en arrière-plan : tant qu'un fichier est chargé, ce service tient
 * l'application en vie (écran éteint, autre appli au premier plan) et affiche
 * une notification avec précédent / lecture-pause / suivant / arrêt, aussi
 * sur l'écran de verrouillage et pour les boutons du casque.
 * Le lecteur reste celui de [MainActivity], qui s'enregistre comme [controller].
 */
class PlaybackService : Service() {

    /** Ce que la notification sait commander. */
    interface Controller {
        fun togglePlay()
        fun next()
        fun previous()
        fun stopPlayback()
        fun pause()
    }

    private lateinit var session: MediaSession
    private var ending = false
    private var noisyRegistered = false

    /** Casque débranché ou Bluetooth coupé : pause, comme VLC. */
    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) controller?.pause()
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        session = MediaSession(this, "KEAPlayer").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() { controller?.togglePlay() }
                override fun onPause() { controller?.pause() }
                override fun onSkipToNext() { controller?.next() }
                override fun onSkipToPrevious() { controller?.previous() }
                override fun onStop() { controller?.stopPlayback() }
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ending = false
        when (intent?.action) {
            ACTION_TOGGLE -> controller?.togglePlay()
            ACTION_NEXT -> controller?.next()
            ACTION_PREVIOUS -> controller?.previous()
            ACTION_STOP -> controller?.stopPlayback()
        }
        // Lancé par startForegroundService : Android exige startForeground, même si la lecture vient de s'arrêter.
        refresh(foreground = intent?.action == null || state.playing)
        return START_NOT_STICKY
    }

    /** Glisser l'appli hors des applications récentes arrête la lecture. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        controller?.stopPlayback()
        stopSelf()
    }

    override fun onDestroy() {
        if (noisyRegistered) runCatching { unregisterReceiver(noisy) }
        noisyRegistered = false
        session.release()
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun refresh(foreground: Boolean = state.playing) {
        if (ending) return
        val playing = state.playing
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, state.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "KEAPlayer")
                .putLong(MediaMetadata.METADATA_KEY_DURATION, state.duration)
                .build(),
        )
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP,
                )
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, state.position, if (playing) state.speed else 0f)
                .build(),
        )

        if (playing && !noisyRegistered) {
            registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
            noisyRegistered = true
        } else if (!playing && noisyRegistered) {
            runCatching { unregisterReceiver(noisy) }
            noisyRegistered = false
        }

        val notification = buildNotification(playing)
        if (foreground) runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        }
        if (!playing) {
            // En pause : la notification reste (on peut reprendre), mais Android peut libérer l'appli.
            stopForeground(STOP_FOREGROUND_DETACH)
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(playing: Boolean): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return builder
            .setSmallIcon(R.drawable.ic_music)
            .setContentTitle(state.title)
            .setContentText(if (playing) "Lecture en cours" else "En pause")
            .setContentIntent(open)
            .setDeleteIntent(action(ACTION_STOP, 4))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .addAction(button(R.drawable.ic_previous, "Précédent", ACTION_PREVIOUS, 1))
            .addAction(
                if (playing) button(R.drawable.ic_pause, "Pause", ACTION_TOGGLE, 2)
                else button(R.drawable.ic_play, "Lecture", ACTION_TOGGLE, 2),
            )
            .addAction(button(R.drawable.ic_next, "Suivant", ACTION_NEXT, 3))
            .addAction(button(R.drawable.ic_close, "Arrêter", ACTION_STOP, 4))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    private fun button(icon: Int, label: String, name: String, code: Int): Notification.Action =
        Notification.Action.Builder(Icon.createWithResource(this, icon), label, action(name, code)).build()

    private fun action(name: String, code: Int): PendingIntent = PendingIntent.getService(
        this, code,
        Intent(this, PlaybackService::class.java).setAction(name),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(CHANNEL_ID, "Lecture", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Commandes de lecture en arrière-plan"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** Ce que la notification affiche. */
    data class State(
        val title: String = "",
        val playing: Boolean = false,
        val position: Long = 0,
        val duration: Long = 0,
        val speed: Float = 1f,
    )

    companion object {
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_TOGGLE = "com.anselmekyere.keaplayer.TOGGLE"
        private const val ACTION_NEXT = "com.anselmekyere.keaplayer.NEXT"
        private const val ACTION_PREVIOUS = "com.anselmekyere.keaplayer.PREVIOUS"
        private const val ACTION_STOP = "com.anselmekyere.keaplayer.STOP"

        var controller: Controller? = null
        private var instance: PlaybackService? = null
        private var state = State()

        /**
         * Met la notification à jour. Démarre le service quand la lecture
         * commence (l'appli est alors au premier plan, ce qu'Android exige).
         */
        fun update(context: Context, newState: State) {
            state = newState
            val service = instance
            if (service != null && !service.ending) {
                service.refresh()
            } else if (newState.playing) {
                val intent = Intent(context, PlaybackService::class.java)
                runCatching {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                    else context.startService(intent)
                }
            }
        }

        /** Plus rien à lire : notification retirée, service arrêté. */
        fun stop(context: Context) {
            state = State()
            instance?.let {
                it.ending = true
                it.stopForeground(STOP_FOREGROUND_REMOVE)
            }
            context.stopService(Intent(context, PlaybackService::class.java))
        }
    }
}
