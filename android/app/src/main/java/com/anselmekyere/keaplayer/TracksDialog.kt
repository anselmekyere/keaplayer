package com.anselmekyere.keaplayer

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.TextView
import org.videolan.libvlc.MediaPlayer

/**
 * Panneau « Pistes, sous-titres et son » : l'équivalent du panneau Pistes de
 * la version de bureau (touche T).
 */
class TracksDialog(
    private val activity: Activity,
    private val player: MediaPlayer,
    private val settings: Settings,
    private val onEqualizer: () -> Unit,
    private val onAddSubtitle: () -> Unit,
) {
    private val dp = activity.resources.displayMetrics.density
    private lateinit var dialog: AlertDialog

    fun show() {
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(20), px(8), px(20), px(8))
        }

        content.addView(heading("Piste audio"))
        content.addView(trackGroup(player.audioTracks, player.audioTrack, "Aucune piste audio") { player.setAudioTrack(it) })

        content.addView(heading("Sous-titres"))
        content.addView(trackGroup(player.spuTracks, player.spuTrack, "Aucun sous-titre dans ce fichier") { player.setSpuTrack(it) })
        content.addView(Button(activity).apply {
            text = "Ajouter un fichier de sous-titres…"
            isAllCaps = false
            setOnClickListener {
                dialog.dismiss()
                onAddSubtitle()
            }
        })

        content.addView(heading("Décalages"))
        content.addView(delayRow("Son", { player.audioDelay }, { player.setAudioDelay(it) }))
        content.addView(delayRow("Sous-titres", { player.spuDelay }, { player.setSpuDelay(it) }))

        content.addView(heading("Égaliseur"))
        content.addView(equalizerSpinner())

        content.addView(heading("Amplification du volume"))
        content.addView(boostRow())

        dialog = AlertDialog.Builder(activity)
            .setTitle("Pistes, sous-titres et son")
            .setView(ScrollView(activity).apply { addView(content) })
            .setPositiveButton("Fermer", null)
            .create()
        dialog.show()
    }

    private fun heading(text: String) = TextView(activity).apply {
        this.text = text
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(activity.getColor(R.color.accent))
        setPadding(0, px(16), 0, px(4))
    }

    private fun trackGroup(
        tracks: Array<MediaPlayer.TrackDescription>?,
        selected: Int,
        emptyText: String,
        select: (Int) -> Unit,
    ): View {
        if (tracks.isNullOrEmpty()) return TextView(activity).apply { text = emptyText }
        return RadioGroup(activity).apply {
            tracks.forEach { track ->
                addView(RadioButton(activity).apply {
                    id = View.generateViewId()
                    text = if (track.id == -1) "Désactivés" else track.name
                    isChecked = track.id == selected
                    setOnClickListener { select(track.id) }
                })
            }
        }
    }

    /** Pas de 50 ms, comme les touches J/K et G/H du bureau ; libVLC compte en microsecondes. */
    private fun delayRow(label: String, get: () -> Long, set: (Long) -> Unit): View {
        val value = TextView(activity).apply {
            gravity = Gravity.CENTER
            minWidth = px(84)
        }
        fun refresh() {
            value.text = "${get() / 1000} ms"
        }
        refresh()
        fun step(delta: Long) = Button(activity).apply {
            text = if (delta < 0) "−" else "+"
            setOnClickListener {
                set(get() + delta)
                refresh()
            }
        }
        return LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(activity).apply { text = label }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(step(-50_000))
            addView(value)
            addView(step(50_000))
        }
    }

    /** Les 18 préréglages de VLC, comme le menu Audio du bureau. */
    private fun equalizerSpinner(): View {
        val count = MediaPlayer.Equalizer.getPresetCount()
        val names = listOf("Désactivé") + (0 until count).map { MediaPlayer.Equalizer.getPresetName(it) }
        return Spinner(activity).apply {
            adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, names)
            setSelection(settings.equalizerPreset + 1)
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    if (position - 1 != settings.equalizerPreset) {
                        settings.equalizerPreset = position - 1
                        onEqualizer()
                    }
                }

                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
    }

    private fun boostRow(): View {
        val label = TextView(activity).apply { minWidth = px(56) }
        fun refresh(v: Int) {
            label.text = "$v %"
        }
        refresh(settings.volume)
        return LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(SeekBar(activity).apply {
                max = 100
                progress = settings.volume - 100
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(bar: SeekBar, p: Int, fromUser: Boolean) {
                        settings.volume = 100 + p
                        player.setVolume(100 + p)
                        refresh(100 + p)
                    }

                    override fun onStartTrackingTouch(bar: SeekBar) = Unit
                    override fun onStopTrackingTouch(bar: SeekBar) = Unit
                })
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(label)
        }
    }

    private fun px(v: Int) = (v * dp).toInt()
}
