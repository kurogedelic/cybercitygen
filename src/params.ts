/**
 * 全調整パラメータの定義。
 * ここに1行足せばUIのフェーダーも自動で生える。
 * regen: true のものは変更時に街を再生成する。
 */
export interface Params {
  // リズム（フロア・看板・窓の明滅テンポと反応の深さ）
  bpm: number;
  beatDepth: number;
  windowBeat: number;
  // カメラ
  camSpeed: number;
  camHeight: number;
  camSway: number;
  fov: number;
  // ルック
  exposure: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  fogDensity: number;
  reflection: number;
  windowGlow: number;
  signGlow: number;
  backdropGlow: number;
  // カラーグレーディング（最終段のポスト処理）
  grdSaturation: number;
  grdContrast: number;
  grdTint: number;
  grdVignette: number;
  // 建物の輪郭線（ワイヤーフレームのエッジ発光）
  outlineStrength: number;
  // ダンスフロア
  floorVisible: boolean;
  floorGlow: number;
  floorPulse: number;
  stageDepth: number;
  // 看板
  signsVisible: boolean;
  // 街の生成（変更で再生成）
  seed: number;
  density: number;
  heightScale: number;
  signDensity: number;
  edgeLights: number;
}

export const DEFAULT_PARAMS: Params = {
  bpm: 120,
  beatDepth: 1.0,
  windowBeat: 0.5,
  camSpeed: 0,
  camHeight: 3.2,
  camSway: 1.6,
  fov: 40,
  exposure: 1.89,
  bloomStrength: 0.22,
  bloomRadius: 0,
  bloomThreshold: 0.09,
  fogDensity: 0,
  reflection: 0.1,
  windowGlow: 1.05,
  signGlow: 0.7,
  backdropGlow: 0.06,
  grdSaturation: 1.25,
  grdContrast: 1.06,
  grdTint: 0.65,
  grdVignette: 0.35,
  outlineStrength: 0.6,
  floorVisible: false,
  floorGlow: 1.0,
  floorPulse: 1.0,
  stageDepth: 16,
  signsVisible: false,
  seed: 1,
  density: 1.4,
  heightScale: 0.6,
  signDensity: 0.55,
  edgeLights: 0.35,
};

/** フェーダーを生やせる数値パラメータのキー（トグル系booleanは除外） */
export type NumericParamKey = { [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params];

export interface ParamDef {
  key: NumericParamKey;
  label: string;
  min: number;
  max: number;
  step: number;
  group: string;
  regen?: boolean;
}

export const PARAM_DEFS: ParamDef[] = [
  { key: 'bpm', label: 'BPM', min: 40, max: 200, step: 1, group: 'Rhythm' },
  { key: 'beatDepth', label: 'Intensity', min: 0, max: 1, step: 0.01, group: 'Rhythm' },
  { key: 'windowBeat', label: 'Win Flicker', min: 0, max: 1, step: 0.01, group: 'Rhythm' },

  { key: 'camSpeed', label: 'Speed', min: 0, max: 8, step: 0.1, group: 'Camera' },
  { key: 'camHeight', label: 'Height', min: 0.5, max: 25, step: 0.1, group: 'Camera' },
  { key: 'camSway', label: 'Sway', min: 0, max: 5, step: 0.1, group: 'Camera' },
  { key: 'fov', label: 'FOV', min: 20, max: 100, step: 1, group: 'Camera' },

  { key: 'exposure', label: 'Exposure', min: 0.2, max: 2.5, step: 0.01, group: 'Look' },
  { key: 'bloomStrength', label: 'Bloom Strength', min: 0, max: 2.5, step: 0.01, group: 'Look' },
  { key: 'bloomRadius', label: 'Bloom Radius', min: 0, max: 1.5, step: 0.01, group: 'Look' },
  { key: 'bloomThreshold', label: 'Bloom Threshold', min: 0, max: 1, step: 0.01, group: 'Look' },
  { key: 'fogDensity', label: 'Fog', min: 0, max: 0.06, step: 0.001, group: 'Look' },
  { key: 'reflection', label: 'Reflection', min: 0, max: 0.5, step: 0.01, group: 'Look' },
  { key: 'windowGlow', label: 'Window Glow', min: 0, max: 3, step: 0.05, group: 'Look' },
  { key: 'signGlow', label: 'Sign Glow', min: 0, max: 3, step: 0.05, group: 'Look' },
  { key: 'backdropGlow', label: 'Distant Glow', min: 0, max: 1, step: 0.01, group: 'Look' },

  { key: 'grdSaturation', label: 'Saturation', min: 0, max: 2, step: 0.01, group: 'Grade' },
  { key: 'grdContrast', label: 'Contrast', min: 0.6, max: 1.6, step: 0.01, group: 'Grade' },
  { key: 'grdTint', label: 'Purple Tint', min: 0, max: 1, step: 0.01, group: 'Grade' },
  { key: 'grdVignette', label: 'Vignette', min: 0, max: 1, step: 0.01, group: 'Grade' },
  { key: 'outlineStrength', label: 'Outline', min: 0, max: 1, step: 0.01, group: 'Look' },

  { key: 'floorGlow', label: 'Glow', min: 0, max: 3, step: 0.05, group: 'Floor' },
  { key: 'floorPulse', label: 'Pulse', min: 0, max: 4, step: 0.05, group: 'Floor' },
  { key: 'stageDepth', label: 'Depth', min: 8, max: 36, step: 0.5, group: 'Floor' },

  { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, group: 'City', regen: true },
  { key: 'density', label: 'Density', min: 0.5, max: 3, step: 0.05, group: 'City', regen: true },
  { key: 'heightScale', label: 'Height Scale', min: 0.5, max: 2, step: 0.05, group: 'City', regen: true },
  { key: 'signDensity', label: 'Sign Density', min: 0, max: 1, step: 0.05, group: 'City', regen: true },
  { key: 'edgeLights', label: 'Edge Lights', min: 0, max: 1, step: 0.05, group: 'City', regen: true },
];
