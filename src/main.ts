import { CityScene } from './scene';
import { exportMp4, exportMp4InWorker } from './exporter';
import { loadSceneFonts } from './fonts';
import { DEFAULT_PARAMS, PARAM_DEFS, type Params } from './params';

const params: Params = { ...DEFAULT_PARAMS };

const canvas = document.getElementById('view') as HTMLCanvasElement;
const previewArea = document.getElementById('preview')!;
const compWrap = document.getElementById('comp-wrap')!;
const compInfo = document.getElementById('comp-info')!;
const status = document.getElementById('status')!;

status.textContent = 'loading fonts';
await loadSceneFonts();
status.textContent = 'ready';

const scene = new CityScene(canvas, params);

// ---- パラメータフェーダーの自動生成 ----

const groupsRoot = document.getElementById('param-groups')!;
const groups = new Map<string, HTMLElement>();

function groupBody(name: string): HTMLElement {
  let body = groups.get(name);
  if (!body) {
    const details = document.createElement('details');
    details.className = 'group';
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = name;
    body = document.createElement('div');
    body.className = 'group-body';
    details.append(summary, body);
    groupsRoot.appendChild(details);
    groups.set(name, body);
  }
  return body;
}

let regenQueued = false;
function queueRegenerate() {
  // フェーダードラッグ中に毎tick再生成しないよう1フレームにまとめる
  if (regenQueued) return;
  regenQueued = true;
  requestAnimationFrame(() => {
    regenQueued = false;
    scene.regenerate();
  });
}

for (const def of PARAM_DEFS) {
  const row = document.createElement('div');
  row.className = 'fader';

  const label = document.createElement('label');
  label.textContent = def.label;
  label.title = def.key;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(def.min);
  slider.max = String(def.max);
  slider.step = String(def.step);
  slider.value = String(params[def.key]);

  const num = document.createElement('input');
  num.type = 'number';
  num.min = String(def.min);
  num.max = String(def.max);
  num.step = String(def.step);
  num.value = String(params[def.key]);

  const apply = (v: number) => {
    if (Number.isNaN(v)) return;
    const clamped = Math.min(def.max, Math.max(def.min, v));
    params[def.key] = clamped;
    slider.value = String(clamped);
    num.value = String(clamped);
    if (def.regen) queueRegenerate();
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('change', () => apply(Number(num.value)));

  row.append(label, slider, num);
  groupBody(def.group).appendChild(row);
}

// ---- Export 用フェーダー（動画設定はシーンparamsと別管理） ----

const exportSettings = { duration: 5, bitrate: 20 };
const exportFadersRoot = document.getElementById('export-faders')!;

function makeExportFader(key: keyof typeof exportSettings, label: string, min: number, max: number, step: number) {
  const row = document.createElement('div');
  row.className = 'fader';
  const lab = document.createElement('label');
  lab.textContent = label;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(exportSettings[key]);
  const num = document.createElement('input');
  num.type = 'number';
  num.value = String(exportSettings[key]);
  const apply = (v: number) => {
    if (Number.isNaN(v)) return;
    exportSettings[key] = Math.min(max, Math.max(min, v));
    slider.value = String(exportSettings[key]);
    num.value = String(exportSettings[key]);
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('change', () => apply(Number(num.value)));
  row.append(lab, slider, num);
  exportFadersRoot.appendChild(row);
}
makeExportFader('duration', 'Duration (s)', 1, 120, 1);
makeExportFader('bitrate', 'Bitrate (Mbps)', 1, 100, 1);

// ---- オーバーレイ（overlay.png を透明度付きでプレビューに重ねる） ----

const overlayImg = document.getElementById('overlay-img') as HTMLImageElement;
const overlayEnable = document.getElementById('overlay-enable') as HTMLInputElement;
const overlayOpacity = document.getElementById('overlay-opacity') as HTMLInputElement;
const overlayOpacityNum = document.getElementById('overlay-opacity-num') as HTMLInputElement;

overlayImg.style.opacity = overlayOpacity.value;
overlayEnable.addEventListener('change', () => {
  overlayImg.style.display = overlayEnable.checked ? 'block' : 'none';
});
const applyOverlayOpacity = (v: number) => {
  if (Number.isNaN(v)) return;
  const clamped = Math.min(1, Math.max(0, v));
  overlayImg.style.opacity = String(clamped);
  overlayOpacity.value = String(clamped);
  overlayOpacityNum.value = String(clamped);
};
overlayOpacity.addEventListener('input', () => applyOverlayOpacity(Number(overlayOpacity.value)));
overlayOpacityNum.addEventListener('change', () => applyOverlayOpacity(Number(overlayOpacityNum.value)));

// ---- プレビュー: コンポジションを枠内にレターボックスフィット ----

const resolutionSel = document.getElementById('resolution') as HTMLSelectElement;
const fpsSel = document.getElementById('fps') as HTMLSelectElement;

let exporting = false; // 書き出し中（ボタン二度押し防止）
let mainThreadExport = false; // フォールバック時のみプレビューを止める

function compSize(): [number, number] {
  const [w, h] = resolutionSel.value.split('x').map(Number);
  return [w, h];
}

function fitPreview() {
  if (mainThreadExport) return;
  const [cw, ch] = compSize();
  const pad = 24;
  const availW = previewArea.clientWidth - pad * 2;
  const availH = previewArea.clientHeight - pad * 2;
  const scale = Math.min(availW / cw, availH / ch, 1);
  const dispW = Math.max(1, Math.floor(cw * scale));
  const dispH = Math.max(1, Math.floor(ch * scale));
  compWrap.style.width = `${dispW}px`;
  compWrap.style.height = `${dispH}px`;
  // 描画解像度は表示サイズ×DPR（フルコンポ解像度はエクスポート時のみ）
  const dpr = Math.min(window.devicePixelRatio, 2);
  scene.setSize(Math.floor(dispW * dpr), Math.floor(dispH * dpr));
  compInfo.textContent = `${cw}×${ch} @ ${Math.round(scale * 100)}%`;
}

new ResizeObserver(fitPreview).observe(previewArea);
resolutionSel.addEventListener('change', fitPreview);
fitPreview();

// ---- プレビューループ（エクスポート中は止める） ----

const startTime = performance.now();
function tick() {
  requestAnimationFrame(tick);
  if (mainThreadExport) return; // Worker書き出し中はプレビューを動かし続ける
  scene.update((performance.now() - startTime) / 1000);
  scene.render();
}
tick();

// ---- エクスポート ----

const exportBtn = document.getElementById('export') as HTMLButtonElement;
const progressBox = document.getElementById('progress')!;
const progressBar = progressBox.firstElementChild as HTMLElement;

exportBtn.addEventListener('click', async () => {
  if (exporting) return;
  exporting = true;
  exportBtn.disabled = true;
  progressBox.classList.add('active');

  const [w, h] = compSize();
  const fps = Number(fpsSel.value);
  const onProgress = (done: number, total: number) => {
    progressBar.style.width = `${(done / total) * 100}%`;
    status.textContent = `rendering ${done}/${total} frames`;
  };

  try {
    let blob: Blob;
    try {
      // Worker + OffscreenCanvas: プレビューを止めずにバックグラウンドで書き出す
      blob = await exportMp4InWorker(
        {
          width: w,
          height: h,
          fps,
          durationSec: exportSettings.duration,
          bitrateMbps: exportSettings.bitrate,
          params: { ...params },
        },
        onProgress,
      );
    } catch (workerErr) {
      // OffscreenCanvas非対応などの場合はメインスレッドで従来どおり書き出す
      console.warn('Worker書き出しに失敗、メインスレッドにフォールバック:', workerErr);
      mainThreadExport = true;
      blob = await exportMp4(scene, {
        width: w,
        height: h,
        fps,
        durationSec: exportSettings.duration,
        bitrateMbps: exportSettings.bitrate,
        onProgress,
      });
    }

    (window as unknown as { __lastExport?: Blob }).__lastExport = blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `citygen_${w}x${h}_${fps}fps_seed${params.seed}.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    status.textContent = `done — ${(blob.size / 1_000_000).toFixed(1)} MB`;
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
    console.error(e);
  } finally {
    exporting = false;
    mainThreadExport = false;
    exportBtn.disabled = false;
    progressBar.style.width = '0%';
    progressBox.classList.remove('active');
    fitPreview();
  }
});
