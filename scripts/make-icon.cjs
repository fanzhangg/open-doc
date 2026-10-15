// Generate desktop assets from the approved artwork: npm run icon:desktop.
const { app, nativeImage } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(join(build, 'icon-source.png'));
  if (source.isEmpty()) throw new Error('Cannot load build/icon-source.png');
  // Pad to a square rather than stretching the approved artwork.
  const { width, height } = source.getSize();
  const side = Math.max(width, height);
  const pixels = Buffer.alloc(side * side * 4);
  const input = source.toBitmap();
  const left = Math.floor((side - width) / 2);
  const top = Math.floor((side - height) / 2);
  for (let y = 0; y < height; y++) {
    input.copy(pixels, ((top + y) * side + left) * 4,
      y * width * 4, (y + 1) * width * 4);
  }
  const square = nativeImage.createFromBitmap(pixels, { width: side, height: side });
  const png = (size) => square.resize({ width: size, height: size, quality: 'best' }).toPNG();
  writeFileSync(join(build, 'icon.png'), png(1024));
  // PNG-backed ICO entries for Windows taskbar and shell sizes.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, ...images]));
  console.log('Generated build/icon.png (1024px) and build/icon.ico (16-256px).');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
