export const SIGN_FONT_FAMILY = 'PixelMplus12';

const FONT_SOURCES = [
  {
    weight: '400',
    url: 'https://cdn.leafscape.be/PixelMplus/PixelMplus12-Regular_web.woff2',
  },
  {
    weight: '700',
    url: 'https://cdn.leafscape.be/PixelMplus/PixelMplus12-Bold_web.woff2',
  },
] as const;

let sceneFontsReady: Promise<void> | null = null;

function getFontSet(): FontFaceSet | undefined {
  if (typeof document !== 'undefined') return document.fonts;
  return (globalThis as typeof globalThis & { fonts?: FontFaceSet }).fonts;
}

export function loadSceneFonts(): Promise<void> {
  if (sceneFontsReady) return sceneFontsReady;

  sceneFontsReady = (async () => {
    if (typeof FontFace === 'undefined') return;
    const fontSet = getFontSet();
    if (!fontSet) return;

    await Promise.all(
      FONT_SOURCES.map(async ({ weight, url }) => {
        const face = new FontFace(SIGN_FONT_FAMILY, `url(${url}) format("woff2")`, {
          display: 'swap',
          weight,
        });
        const loaded = await face.load();
        fontSet.add(loaded);
      }),
    );
  })().catch((err) => {
    console.warn('PixelMplus font loading failed; falling back to system font.', err);
  });

  return sceneFontsReady;
}
