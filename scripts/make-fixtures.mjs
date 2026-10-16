// Génère les médias de test (tests/fixtures/media) avec FFmpeg.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpeg = process.env.KEAPLAYER_FFMPEG ?? require("ffmpeg-static");
const dir = "tests/fixtures/media";
mkdirSync(dir, { recursive: true });

const make = (name, args) => {
  const out = path.join(dir, name);
  if (existsSync(out)) return;
  // GCONV_PATH : voir binaryEnv() dans src/main/media/ffmpeg.ts.
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, out], {
    env: { ...process.env, GCONV_PATH: "/nonexistent-keaplayer-gconv" },
  });
  console.log(`créé : ${out}`);
};

const video = (d) => ["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${d}`];
const tone = (f, d) => ["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${d}`];

const srt = (lines) =>
  lines.map(([a, b, t], i) => `${i + 1}\n00:00:${a},000 --> 00:00:${b},000\n${t}\n`).join("\n");

writeFileSync(path.join(dir, "embedded.srt"), srt([["01", "30", "Sous-titre intégré"]]));
writeFileSync(path.join(dir, "multi.fr.srt"), srt([["01", "30", "Sous-titre externe"]]));

// MP4 H.264/AAC : lecture native.
make("native.mp4", [...video(60), ...tone(440, 60), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
// MKV H.264 + 2 pistes audio (AAC fr, AC-3 en) + sous-titres intégrés : remux.
make("multi.mkv", [
  ...video(40), ...tone(440, 40), ...tone(880, 40), "-i", path.join(dir, "embedded.srt"),
  "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a:0", "aac", "-c:a:1", "ac3", "-c:s", "srt",
  "-metadata:s:a:0", "language=fre", "-metadata:s:a:1", "language=eng", "-metadata:s:a:1", "title=VO",
  "-metadata:s:s:0", "language=fre", "-disposition:a:0", "default", "-shortest",
]);
// AVI MPEG-4 Part 2 / MP3 : transcodage.
make("legacy.avi", [...video(40), ...tone(330, 40), "-c:v", "mpeg4", "-q:v", "5", "-c:a", "libmp3lame", "-shortest"]);
// Enregistrement TNT : MPEG-2 + AC-3 en MPEG-TS (faisait planter ffprobe sous Linux).
make("recording.ts", [...video(20), ...tone(550, 20), "-c:v", "mpeg2video", "-q:v", "4", "-c:a", "ac3", "-shortest"]);
// HEVC : transcodage là où Chromium ne le décode pas (Linux), natif ailleurs.
make("hevc.mp4", [...video(20), ...tone(660, 20), "-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1", "-c:a", "aac", "-shortest"]);
// Vidéo entrelacée (trame haute d'abord, comme la TNT SD) : désentrelacée par yadif.
make("interlaced.ts", [
  "-f", "lavfi", "-i", "testsrc2=size=720x576:rate=25:duration=15", ...tone(440, 15),
  "-vf", "tinterlace=mode=interleave_top,setfield=tff", "-flags", "+ilme+ildct", "-top", "1",
  "-c:v", "mpeg2video", "-q:v", "4", "-c:a", "mp2", "-shortest",
]);
// MP3 seul : lecture native, audio uniquement.
make("music.mp3", [...tone(523, 20), "-c:a", "libmp3lame"]);

// Sous-titres ASS : styles, positions absolues et karaoké, rendus par libass.
const ass = (style, lines) => `\uFEFF[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
// Bloc rouge plein en haut à gauche (\\an7\\pos), facile à repérer sur l'image.
writeFileSync(path.join(dir, "styled.ass"), ass(
  "Rouge,Liberation Sans,48,&H000000FF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1",
  [
    "Dialogue: 0,0:00:00.50,0:00:30.00,Rouge,,0,0,0,,{\\an7\\pos(20,20)\\p1}m 0 0 l 200 0 200 80 0 80{\\p0}",
    "Dialogue: 0,0:00:00.50,0:00:30.00,Rouge,,0,0,0,,{\\an2\\k50}Ka{\\k50}ra{\\k50}o{\\k50}ké",
  ],
));
make("styled.mp4", [...video(30), ...tone(440, 30), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);

// MKV avec ASS intégré et police jointe (comme les animés « fansub »).
const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
writeFileSync(path.join(dir, "embedded.ass"), ass(
  "Vert,DejaVu Sans,40,&H0000FF00,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,20,1",
  ["Dialogue: 0,0:00:00.50,0:00:30.00,Vert,,0,0,0,,Police jointe"],
));
make("fonts.mkv", [
  ...video(30), ...tone(440, 30), "-i", path.join(dir, "embedded.ass"),
  ...(existsSync(font) ? ["-attach", font, "-metadata:s:t", "mimetype=application/x-truetype-font"] : []),
  "-map", "0:v", "-map", "1:a", "-map", "2:s",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "ass", "-shortest",
]);
