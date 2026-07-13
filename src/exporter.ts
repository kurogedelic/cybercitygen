import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { CityScene } from './scene';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  bitrateMbps: number;
  onProgress?: (done: number, total: number) => void;
}

// setTimeout はバックグラウンドタブで ~1s にスロットリングされるので、
// MessageChannel 経由で制御を返す（こちらはスロットリング対象外）
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

/**
 * 固定タイムステップのオフラインレンダリング。
 * リアルタイム性は捨てて 1 フレームずつ描画 → WebCodecs でエンコード。
 * フレーム落ちが原理的に発生しないので CM 用途の品質が出せる。
 */
export async function exportMp4(scene: CityScene, opts: ExportOptions): Promise<Blob> {
  const { width, height, fps, durationSec, bitrateMbps, onProgress } = opts;
  const totalFrames = Math.round(durationSec * fps);

  if (typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs (VideoEncoder) 非対応のブラウザです。Chrome / Edge / Safari 16.4+ を使ってください。');
  }

  // 4K でも通る High プロファイル。levelはfindしてもよいが5.1で4K60まで足りる
  const codec = 'avc1.640033';
  const config: VideoEncoderConfig = {
    codec,
    width,
    height,
    bitrate: bitrateMbps * 1_000_000,
    framerate: fps,
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`この設定はエンコーダ非対応です: ${width}x${height}@${fps} ${codec}`);
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure(config);

  const canvas = scene.renderer.domElement;
  scene.setSize(width, height);

  try {
    for (let frame = 0; frame < totalFrames; frame++) {
      if (encodeError) throw encodeError;

      const t = frame / fps;
      scene.update(t);
      scene.render();

      const videoFrame = new VideoFrame(canvas, {
        timestamp: Math.round((frame * 1_000_000) / fps),
        duration: Math.round(1_000_000 / fps),
      });
      // 2秒ごとにキーフレームを入れる（シーク耐性）
      encoder.encode(videoFrame, { keyFrame: frame % (fps * 2) === 0 });
      videoFrame.close();

      // エンコーダのキューが詰まったら描画を待たせる（メモリ保護）
      while (encoder.encodeQueueSize > 4) {
        await yieldToBrowser();
      }

      onProgress?.(frame + 1, totalFrames);
      // UI を固まらせないために制御を返す
      if (frame % 4 === 0) await yieldToBrowser();
    }

    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }

  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
