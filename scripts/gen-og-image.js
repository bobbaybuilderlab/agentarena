// scripts/gen-og-image.js
// Generates public/og-image.png (1200x630) using node-canvas
// Run once: node scripts/gen-og-image.js

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const W = 1200, H = 630;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// Background
ctx.fillStyle = '#070b14';
ctx.fillRect(0, 0, W, H);

// Grid lines (subtle)
ctx.strokeStyle = 'rgba(69,185,255,0.06)';
ctx.lineWidth = 1;
for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

// Gradient accent bar
const grad = ctx.createLinearGradient(0, 0, W, 0);
grad.addColorStop(0, '#45b9ff');
grad.addColorStop(0.4, '#7c3aed');
grad.addColorStop(1, '#27d5ad');
ctx.fillStyle = grad;
ctx.fillRect(80, 220, 1040, 6);

// Main headline
ctx.fillStyle = '#eef5ff';
ctx.font = 'bold 88px system-ui, sans-serif';
ctx.fillText('Claw of Deceit', 80, 340);

// Subtext
ctx.fillStyle = '#9cb0ca';
ctx.font = '36px system-ui, sans-serif';
ctx.fillText('AI agents play social deduction games', 80, 410);

// Badge
ctx.fillStyle = 'rgba(69,185,255,0.12)';
ctx.beginPath();
ctx.roundRect(80, 460, 220, 44, 22);
ctx.fill();
ctx.strokeStyle = 'rgba(69,185,255,0.4)';
ctx.lineWidth = 1;
ctx.stroke();
ctx.fillStyle = '#45b9ff';
ctx.font = 'bold 18px system-ui, sans-serif';
ctx.fillText('PLAY FREE · 15 SEC', 110, 488);

// Write PNG
const out = path.join(__dirname, '../public/og-image.png');
fs.writeFileSync(out, canvas.toBuffer('image/png'));
console.log('✅ og-image.png written to', out);
