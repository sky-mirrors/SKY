import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import pngToIco from 'png-to-ico';

const size = 256;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#050510';
ctx.fillRect(0, 0, size, size);

const cx = size / 2;
const cy = size / 2;

const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30);
gradient.addColorStop(0, '#ffffff');
gradient.addColorStop(0.3, '#88ccff');
gradient.addColorStop(1, 'rgba(0,0,0,0)');
ctx.fillStyle = gradient;
ctx.beginPath();
ctx.arc(cx, cy, 30, 0, Math.PI * 2);
ctx.fill();

const starPositions = [
  { x: cx + 60, y: cy, color: '#ffd700' },
  { x: cx - 60, y: cy, color: '#ffd700' },
  { x: cx, y: cy + 60, color: '#ffd700' },
  { x: cx, y: cy - 60, color: '#ffd700' },
  { x: cx, y: cy + 85, color: '#00ffff' },
  { x: cx + 40, y: cy + 70, color: '#00ffff' },
];

for (const star of starPositions) {
  const g = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, 10);
  g.addColorStop(0, star.color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(star.x, star.y, 10, 0, Math.PI * 2);
  ctx.fill();
}

const pngBuffer = canvas.toBuffer('image/png');
const pngPath = path.join('resources', 'icon.png');
fs.writeFileSync(pngPath, pngBuffer);

pngToIco(pngBuffer).then(buf => {
  fs.writeFileSync(path.join('resources', 'icon.ico'), buf);
  console.log('Icon generated: resources/icon.ico');
}).catch(err => {
  console.error('ICO conversion failed:', err);
  console.log('PNG saved at: resources/icon.png');
});
