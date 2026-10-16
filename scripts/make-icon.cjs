// Generate SVG and desktop assets from the avatar renderer: npm run icon:desktop.
const { app, BrowserWindow, nativeImage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<html></html>');
  const renderer = readFileSync(join(__dirname, '..', 'web', 'faces.js'), 'utf8').replace(/^export /gm, '');
  const svg = await window.webContents.executeJavaScript(`(() => { ${renderer}\nreturn clippyFace().outerHTML; })()`);
  writeFileSync(join(build, 'icon.svg'), svg + '\n');
  // Share the actual avatar mark with the wordmark, so they cannot drift apart.
  const mark = svg.replace('<svg ', '<svg x="0" y="0" width="80" height="80" ');
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 80" width="280" height="80" role="img" aria-label="OpenDoc">
    <style>text{fill:#1f1d24;font:600 38px Inter,"Segoe UI",sans-serif;letter-spacing:-1px}@media(prefers-color-scheme:dark){text{fill:#f4f2ec}}</style>
    ${mark}<text x="88" y="54">OpenDoc</text>
  </svg>`;
  writeFileSync(join(build, 'logo.svg'), logo + '\n');
  const documentSvg = await window.webContents.executeJavaScript(`(() => { ${renderer}\nreturn documentIcon().outerHTML; })()`);
  writeFileSync(join(build, 'document.svg'), documentSvg + '\n');
  for (const [name, artwork] of [['icon', svg], ['document', documentSvg]]) {
    const data = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(artwork)});
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
      return canvas.toDataURL('image/png');
    })()`);
    const source = nativeImage.createFromDataURL(data);
    if (source.isEmpty()) throw new Error(`Cannot render ${name}`);
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
    writeFileSync(join(build, `${name}.png`), png(1024));
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
    writeFileSync(join(build, `${name}.ico`), Buffer.concat([header, ...images]));
  }
  window.destroy();
  console.log('Generated application and document SVG, PNG (1024px), ICO (16-256px), and the OpenDoc wordmark.');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
