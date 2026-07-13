# citygen

Three.js のシーンをオフラインレンダリングして mp4 に書き出す Web アプリ。
CM 用背景映像（ネオン都市など）の生成パイプラインの雛形。

## 仕組み

リアルタイム録画（MediaRecorder）ではなく、**固定タイムステップのオフラインレンダリング**:

```
t = frame / fps で scene.update(t) → render → canvas
  → VideoFrame → VideoEncoder (WebCodecs / H.264 HW encode)
  → mp4-muxer → mp4 Blob → ダウンロード
```

- フレーム落ちが原理的に起きない（1フレーム何秒かかってもOK）
- 4K 60fps、ビットレート指定可
- `scene.update(t)` が t のみに依存する限り、プレビューと書き出しが完全一致

## 使い方

```bash
npm install
npm run dev   # http://localhost:5173
```

右上パネルで解像度 / fps / 尺 / ビットレートを指定して **EXPORT MP4**。

## 構成

- `src/scene.ts` — シーン定義。`update(t)` に決定論的アニメーションを書く。Bloom などポストプロセスもここ
- `src/exporter.ts` — WebCodecs + mp4-muxer の書き出しパイプライン（シーン非依存）
- `src/main.ts` — UI とプレビューループ

## シーンを作るときのルール

- アニメーションは `update(t)` の **t だけ** から決める（`Date.now()` / 無シードの `Math.random()` 禁止。乱数はシード付きで）
- 重いエフェクトを足しても書き出し品質には影響しない（時間がかかるだけ）

## 制約

- WebCodecs 必須: Chrome / Edge / Safari 16.4+
- H.264 High Profile (avc1.640033)。4K60 まで対応
