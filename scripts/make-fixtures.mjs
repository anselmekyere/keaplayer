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
