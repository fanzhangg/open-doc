// Generate SVG and desktop assets from the avatar renderer: npm run icon:desktop.
const { app, BrowserWindow, nativeImage } = require('electron');
const { writeFileSync } = require('node:fs');
const { buildSync } = require('esbuild');
const { join } = require('node:path');

const build = join(__dirname, '..', 'build');

// PNG-backed ICO entries for Windows taskbar and shell sizes.
function ico(png) {
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
  return Buffer.concat([header, ...images]);
}

// PNG-backed ICNS for macOS, written here so it does not depend on a Mac tool.
function icns(png) {
  const types = [['icp4', 16], ['ic11', 32], ['icp5', 32], ['ic12', 64], ['ic07', 128],
    ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
  const entries = types.map(([type, size]) => {
    const data = png(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<html></html>');
  // Bundled, since faces.js imports from src/.
  const renderer = buildSync({ entryPoints: [join(__dirname, '..', 'web', 'faces.js')], bundle: true, format: 'iife', globalName: 'faces', write: false }).outputFiles[0].text;
  const draw = (fn) => window.webContents.executeJavaScript(`(() => { ${renderer}\nreturn faces.${fn}().outerHTML; })()`);
  // One mark everywhere: the app icon is also the favicon and the wordmark's mark.
  const svg = await draw('appIcon');
  writeFileSync(join(build, 'icon.svg'), svg + '\n');
  const mark = svg.replace('<svg ', '<svg x="0" y="0" width="80" height="80" ');
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 80" width="270" height="80" role="img" aria-label="OpenDoc">
    <style>text{fill:#1f1d24;font:600 38px Inter,"Segoe UI",sans-serif;letter-spacing:-1px}@media(prefers-color-scheme:dark){text{fill:#f4f2ec}}</style>
    ${mark}<text x="82" y="54">OpenDoc</text>
  </svg>`;
  writeFileSync(join(build, 'logo.svg'), logo + '\n');
  const documentSvg = await draw('documentIcon');
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
    const png = (size) => size === 1024 ? source.toPNG() : source.resize({ width: size, height: size, quality: 'best' }).toPNG();
    writeFileSync(join(build, `${name}.png`), png(1024));
    writeFileSync(join(build, `${name}.ico`), ico(png));
    writeFileSync(join(build, `${name}.icns`), icns(png));
  }
  window.destroy();
  console.log('Generated application and document SVG, PNG (1024px), ICO (16-256px), ICNS (16-1024px), and the OpenDoc wordmark.');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
