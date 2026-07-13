/**
 * 全調整パラメータの定義。
 * ここに1行足せばUIのフェーダーも自動で生える。
 * regen: true のものは変更時に街を再生成する。
 */
export interface Params {
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
  // 交通
  trafficSpeed: number;
  trafficGlow: number;
  // 街の生成（変更で再生成）
  seed: number;
  density: number;
  heightScale: number;
  signDensity: number;
}

export const DEFAULT_PARAMS: Params = {
  camSpeed: 2.0,
  camHeight: 2.6,
  camSway: 1.6,
  fov: 55,
  exposure: 0.58,
  bloomStrength: 0.13,
  bloomRadius: 0.86,
  bloomThreshold: 0.13,
  fogDensity: 0,
  reflection: 0.15,
  windowGlow: 0.75,
  signGlow: 0.4,
  backdropGlow: 0.2,
  trafficSpeed: 1.0,
  trafficGlow: 0.4,
  seed: 1,
  density: 1.0,
  heightScale: 1.0,
  signDensity: 0.55,
};

export interface ParamDef {
  key: keyof Params;
  label: string;
  min: number;
  max: number;
  step: number;
  group: string;
  regen?: boolean;
}

export const PARAM_DEFS: ParamDef[] = [
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

  { key: 'trafficSpeed', label: 'Speed', min: 0, max: 3, step: 0.05, group: 'Traffic' },
  { key: 'trafficGlow', label: 'Glow', min: 0, max: 3, step: 0.05, group: 'Traffic' },

  { key: 'seed', label: 'Seed', min: 0, max: 999, step: 1, group: 'City', regen: true },
  { key: 'density', label: 'Density', min: 0.5, max: 2, step: 0.05, group: 'City', regen: true },
  { key: 'heightScale', label: 'Height Scale', min: 0.5, max: 2, step: 0.05, group: 'City', regen: true },
  { key: 'signDensity', label: 'Sign Density', min: 0, max: 1, step: 0.05, group: 'City', regen: true },
];
