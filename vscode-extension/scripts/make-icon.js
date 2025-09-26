const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

(async () => {
  try {
    const root = path.resolve(__dirname, '..');
    const inSvg = path.join(root, 'media', 'icon.svg');
    const outPng = path.join(root, 'media', 'icon.png');

    if (!fs.existsSync(inSvg)) {
      console.error('icon.svg not found at', inSvg);
      process.exit(1);
    }

    await sharp(inSvg)
      .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(outPng);

    console.log('Wrote', outPng);
  } catch (err) {
    console.error('Icon build failed:', err);
    process.exit(1);
  }
})();
