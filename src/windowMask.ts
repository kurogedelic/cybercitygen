/**
 * public/windows.png（グレースケールの窓タイルシート）を読み込み、
 * 等間隔グリッドで切り出して窓スタンプ群に変換する。
 *
 * シートの仕様:
 * - グレースケールPNG（アルファ不要）
 * - 白 = ガラス面（光る）/ 黒 = 壁・枠（光らない）/ グレー = 中間の明るさ
 * - 1タイル = 168×168px で好きな枚数を並べる（横×縦は自由）
 * - ほぼ真っ黒なセルは自動でスキップ
 *
 * ファサード生成時はスタンプに色を乗せて窓として貼る。
 * メインスレッドとWorkerの両方で動く（HTMLCanvasElement / OffscreenCanvas）。
 */

const CELL = 168; // 1タイルのピクセルサイズ

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(width: number, height: number): { canvas: AnyCanvas; ctx: AnyCtx2D } {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: canvas.getContext('2d')! };
  }
  const canvas = new OffscreenCanvas(width, height);
  return { canvas, ctx: canvas.getContext('2d') as OffscreenCanvasRenderingContext2D };
}

let variants: AnyCanvas[] | null = null;
let loading: Promise<void> | null = null;

/** 読み込み済みの窓スタンプ（未読み込み・失敗時は null → 呼び出し側は矩形描画にフォールバック） */
export function windowMaskVariants(): AnyCanvas[] | null {
  return variants;
}

export function loadWindowMask(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}windows.png`);
    if (!res.ok) return;
    const bmp = await createImageBitmap(await res.blob());
    const w = bmp.width;
    const h = bmp.height;
    const { ctx } = makeCanvas(w, h);
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const lumAt = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    };

    // 白背景のラフ画像など「マスクとして成立しない画像」はフォールバックさせる
    let sum = 0;
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) sum += lumAt(x, y);
    const mean = sum / (Math.ceil(w / 4) * Math.ceil(h / 4));
    if (mean > 150) {
      console.warn('windows.png が明るすぎます（白=ガラス/黒=壁のグレースケールを想定）。矩形窓にフォールバックします。');
      return;
    }

    // 168px グリッドで切り出し（端数は丸めるのでシート全体サイズは多少ずれてもよい）
    const cols = Math.max(1, Math.round(w / CELL));
    const rows = Math.max(1, Math.round(h / CELL));
    const cellW = Math.floor(w / cols);
    const cellH = Math.floor(h / rows);

    const found: AnyCanvas[] = [];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const { canvas: vc, ctx: vctx } = makeCanvas(cellW, cellH);
        const img = vctx.createImageData(cellW, cellH);
        let maxLum = 0;
        for (let y = 0; y < cellH; y++) {
          for (let x = 0; x < cellW; x++) {
            const lum = lumAt(cx * cellW + x, cy * cellH + y);
            if (lum > maxLum) maxLum = lum;
            const di = (y * cellW + x) * 4;
            img.data[di] = 255;
            img.data[di + 1] = 255;
            img.data[di + 2] = 255;
            img.data[di + 3] = Math.round(lum); // 輝度をそのままアルファに
          }
        }
        if (maxLum < 25) continue; // ほぼ真っ黒 = 空きセル
        vctx.putImageData(img, 0, 0);
        found.push(vc);
      }
    }
    if (found.length > 0) variants = found;
  })().catch((err) => {
    console.warn('windows.png の読み込みに失敗。矩形窓にフォールバックします。', err);
  });
  return loading;
}
