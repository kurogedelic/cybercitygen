/**
 * 書き出し用Worker。
 * OffscreenCanvas上にシーンを丸ごと構築し、描画〜エンコードまで全部ここで行う。
 * メインスレッドはUIとプレビューを止めずに済む。
 */
import { CityScene } from './scene';
import { exportMp4 } from './exporter';
import { loadSceneFonts } from './fonts';
import { loadWindowMask } from './windowMask';
import type { Params } from './params';

interface WorkerRequest {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  bitrateMbps: number;
  params: Params;
}

const post = (message: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(message, transfer);

self.addEventListener('message', async (e: MessageEvent<WorkerRequest>) => {
  const { width, height, fps, durationSec, bitrateMbps, params } = e.data;
  let scene: CityScene | null = null;
  try {
    await Promise.all([loadSceneFonts(), loadWindowMask()]);
    const canvas = new OffscreenCanvas(width, height);
    scene = new CityScene(canvas, params);
    const blob = await exportMp4(scene, {
      width,
      height,
      fps,
      durationSec,
      bitrateMbps,
      onProgress: (done, total) => post({ type: 'progress', done, total }),
    });
    const buffer = await blob.arrayBuffer();
    post({ type: 'done', buffer }, [buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    scene?.dispose();
  }
});
