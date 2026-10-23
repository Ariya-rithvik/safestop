// Fits demo/safestop-demo.mp4 under 3:00 for Devpost: drops the "status" scene and speeds up slightly if needed.
//   node scripts/fit-demo.mjs   (after scripts/record-demo.ts)
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
const { marks } = JSON.parse(readFileSync('demo/marks.json', 'utf8'));
const st = marks.find((m) => m.id === 'status');
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
copyFileSync('demo/safestop-demo.mp4', 'demo/safestop-demo.long.mp4');
const full = dur('demo/safestop-demo.long.mp4');
const S = st.at, E = st.at + st.len; // the insert is spliced after "stop", which comes after "status": times unchanged
const after = full - (E - S);
const speed = Math.max(1, after / 179.0);
const fc = `[0:v]split[a][b];[0:a]asplit[c][d];[a]trim=0:${S},setpts=PTS-STARTPTS[v0];[c]atrim=0:${S},asetpts=PTS-STARTPTS[a0];[b]trim=start=${E},setpts=PTS-STARTPTS[v1];[d]atrim=start=${E},asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][au];[v]setpts=PTS/${speed.toFixed(4)}[vv];[au]atempo=${speed.toFixed(4)}[aa]`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', 'demo/safestop-demo.long.mp4', '-filter_complex', fc, '-map', '[vv]', '-map', '[aa]', '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', 'demo/safestop-demo.mp4'], { stdio: 'inherit' });
console.log(`fitted: ${dur('demo/safestop-demo.mp4').toFixed(1)} s (speed ${speed.toFixed(3)})`);
