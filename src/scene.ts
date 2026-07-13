import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Params } from './params';

/**
 * ネオンシティ + ダンスフロアシーン。
 * 構図: 手前にダンスフロア広場、左右にビルの壁、奥にパースの効いた都市の光。
 * update(t) は経過秒数 t と params だけからすべての状態を決める（決定論的）。
 * 生成の乱数はシード付きPRNGのみ。Math.random() / Date.now() 禁止。
 */

// 決定論的PRNG (mulberry32)
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// t から作る決定論的ノイズ（フリッカー用）
function hash01(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

type FacadeStyle = 'office' | 'residential' | 'glass' | 'dark';

const NEON_PALETTE = ['#ff4cd2', '#b44cff', '#4cc9ff', '#4c6bff', '#ffb84c', '#ff6b9d', '#7dffd4'];
const SIGN_WORDS = ['CORIS', 'DANCE', 'GUM', 'GUMGUM', 'COMECOME', 'FUEGUM'];
const FLOOR_ICONS = ['♪', '★', '♥', '◆'];

const CITY_LENGTH = 320; // 街の奥行き
const STREET_HALF = 9; // 広場の半幅（ビルはこの外側）

// ダンスフロアのグリッド
const FLOOR_COLS = 9;
const FLOOR_ROWS = 12;
const FLOOR_CELL = 84; // px
const FLOOR_W = FLOOR_COLS * FLOOR_CELL;
const FLOOR_H = FLOOR_ROWS * FLOOR_CELL;

interface Sign {
  material: THREE.MeshBasicMaterial;
  baseColor: THREE.Color;
  phase: number;
  flickery: boolean;
}

interface Beacon {
  material: THREE.MeshBasicMaterial;
  phase: number;
}

interface FloorTile {
  col: number;
  row: number;
  colorIdx: number;
  phase: number;
  speed: number;
  icon: string | null;
}

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;

  private backdrop!: THREE.Mesh; // 遠景の光（カメラ追従）
  private backdropMat!: THREE.MeshBasicMaterial;
  private groundMat!: THREE.MeshBasicMaterial; // 反射の見える暗い地面
  private city = new THREE.Group(); // 静的な街（ビル・看板）
  private mirror = new THREE.Group(); // 床反射用の上下反転コピー
  private signs: Sign[] = [];
  private beacons: Beacon[] = [];
  private facadeMats: THREE.MeshStandardMaterial[] = [];
  private disposables: { dispose(): void }[] = [];

  // ダンスフロア
  private floorCtx: CanvasRenderingContext2D;
  private floorTex: THREE.CanvasTexture;
  private floorTiles: FloorTile[] = [];

  readonly params: Params;

  constructor(canvas: HTMLCanvasElement, params: Params) {
    this.params = params;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x060612);
    this.scene.fog = new THREE.FogExp2(0x0a0a24, params.fogDensity);

    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);

    this.scene.add(this.city, this.mirror);
    this.scene.add(new THREE.AmbientLight(0x223, 1.2));

    // 地面: 反射コピーが透けて見える半透明の黒
    this.groundMat = new THREE.MeshBasicMaterial({ color: 0x04040a, transparent: true, opacity: 0.85 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, CITY_LENGTH + 100), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0.001, -CITY_LENGTH / 2 + 30);
    ground.renderOrder = 1;
    this.scene.add(ground);
    this.disposables.push(ground.geometry, this.groundMat);

    // ダンスフロア: 手前の広場。毎フレーム canvas を描き直してパルスさせる
    const floorCanvas = document.createElement('canvas');
    floorCanvas.width = FLOOR_W;
    floorCanvas.height = FLOOR_H;
    this.floorCtx = floorCanvas.getContext('2d')!;
    this.floorTex = new THREE.CanvasTexture(floorCanvas);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    const floorMat = new THREE.MeshBasicMaterial({ map: this.floorTex, toneMapped: false });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(22, 30), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.02, 6); // z: 21 〜 -9
    floor.renderOrder = 2;
    this.scene.add(floor);
    this.disposables.push(floor.geometry, floorMat, this.floorTex);

    // 遠景: パースの効いた都市の光（フォグの外側、カメラ追従）
    const bdTex = this.makeBackdropTexture();
    this.backdropMat = new THREE.MeshBasicMaterial({
      map: bdTex,
      transparent: true,
      fog: false,
      toneMapped: false,
      depthWrite: false,
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(360, 150), this.backdropMat);
    this.scene.add(this.backdrop);
    this.disposables.push(this.backdrop.geometry, this.backdropMat, bdTex);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1920, 1080), 0.9, 0.65, 0.35);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.regenerate();
  }

  /** params の生成系パラメータ（seed / density / heightScale / signDensity）から街を作り直す */
  regenerate() {
    for (const group of [this.city, this.mirror]) {
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => {
            for (const key of ['map', 'emissiveMap'] as const) {
              const tex = (m as THREE.MeshStandardMaterial)[key as 'map'];
              if (tex) tex.dispose();
            }
            m.dispose();
          });
        }
      });
      group.clear();
    }
    this.signs = [];
    this.beacons = [];
    this.facadeMats = [];

    const rng = mulberry32(Math.round(this.params.seed));
    this.buildCity(rng);
    this.buildSigns(rng);
    this.buildFloorTiles(rng);

    // 床反射: 静的な街を上下反転コピー（半透明の地面越しに見える）
    const mirrored = this.city.clone(true);
    mirrored.scale.y = -1;
    this.mirror.add(mirrored);
  }

  // ---- 街の生成 ----

  private buildCity(rng: () => number) {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.95 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.9 });

    // 1棟ぶんのボックス（各面に階・列が揃った窓テクスチャ）
    const makeBlock = (w: number, h: number, d: number, style: FacadeStyle, storefront: boolean) => {
      const floors = Math.max(3, Math.round(h / 2.6));
      const bodyColor = new THREE.Color().setHSL(0.58 + rng() * 0.12, 0.25, 0.02 + rng() * 0.03);
      const mkMat = (cols: number) => {
        const mat = new THREE.MeshStandardMaterial({
          color: bodyColor,
          emissive: 0xffffff,
          emissiveMap: this.makeFacadeTexture(rng, cols, floors, style, storefront),
          emissiveIntensity: this.params.windowGlow,
          roughness: 0.75,
          metalness: 0.25,
        });
        this.facadeMats.push(mat);
        return mat;
      };
      const matZ = mkMat(Math.max(2, Math.round(w / 1.7))); // 前後面
      const matX = mkMat(Math.max(2, Math.round(d / 1.7))); // 側面
      const mesh = new THREE.Mesh(boxGeo, [matX, matX, roofMat, roofMat, matZ, matZ]);
      mesh.scale.set(w, h, d);
      return mesh;
    };

    const { density, heightScale } = this.params;
    for (let z = 18; z > -CITY_LENGTH; z -= (7 + rng() * 4) / density) {
      if (rng() < 0.12) continue; // 交差点の抜け
      for (const side of [-1, 1]) {
        // 手前の列 + 奥の列（奥ほど高い）
        for (let row = 0; row < 2; row++) {
          const h = (row === 0 ? 8 + rng() * 22 : 20 + rng() * 45) * heightScale;
          const w = 4 + rng() * 5;
          const d = 4 + rng() * 5;
          const x = side * (STREET_HALF + w / 2 + row * (7 + rng() * 5) + rng() * 2);
          const cz = z - d / 2;
          const style = this.pickStyle(rng);

          const base = makeBlock(w, h, d, style, row === 0 && rng() < 0.6);
          base.position.set(x, h / 2, cz);
          this.city.add(base);

          // セットバック（段状の塔屋）
          let topY = h;
          let topW = w;
          let topD = d;
          let topX = x;
          let topZ = cz;
          if (h > 22 && rng() < 0.55) {
            topW = w * (0.5 + rng() * 0.25);
            topD = d * (0.5 + rng() * 0.25);
            const h2 = h * (0.3 + rng() * 0.3);
            topX = x + (rng() - 0.5) * (w - topW) * 0.5;
            topZ = cz + (rng() - 0.5) * (d - topD) * 0.5;
            const upper = makeBlock(topW, h2, topD, style, false);
            upper.position.set(topX, h + h2 / 2, topZ);
            this.city.add(upper);
            topY = h + h2;
          }

          // 屋上設備（機械室）
          if (rng() < 0.5) {
            const mw = topW * 0.3, md = topD * 0.3, mh = 0.8 + rng() * 1.2;
            const box = new THREE.Mesh(boxGeo, roofMat);
            box.scale.set(mw, mh, md);
            box.position.set(
              topX + (rng() - 0.5) * (topW - mw) * 0.7,
              topY + mh / 2,
              topZ + (rng() - 0.5) * (topD - md) * 0.7,
            );
            this.city.add(box);
          }

          // クラウン照明（屋上の縁が光る）
          if (h > 26 && rng() < 0.45) {
            const color = new THREE.Color(NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)]);
            const crown = new THREE.Mesh(
              boxGeo,
              new THREE.MeshBasicMaterial({ color: color.multiplyScalar(1.4), toneMapped: false }),
            );
            crown.scale.set(topW + 0.2, 0.14, topD + 0.2);
            crown.position.set(topX, topY + 0.07, topZ);
            this.city.add(crown);
          }

          // アンテナ（先端にビーコン）
          let beaconY = topY;
          if (topY > 30 && rng() < 0.5) {
            const aH = 3 + rng() * 6;
            const mast = new THREE.Mesh(boxGeo, darkMat);
            mast.scale.set(0.09, aH, 0.09);
            mast.position.set(topX, topY + aH / 2, topZ);
            this.city.add(mast);
            beaconY = topY + aH;
          }
          if (beaconY > 34 && rng() < 0.75) this.addBeacon(topX, beaconY, topZ, rng);

          // 中間階の光る帯（機械階・展望フロア風）
          if (h > 18 && rng() < 0.35) {
            const color = new THREE.Color(NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)]);
            const band = new THREE.Mesh(
              boxGeo,
              new THREE.MeshBasicMaterial({ color: color.multiplyScalar(0.6), toneMapped: false }),
            );
            band.scale.set(w + 0.06, 0.2, d + 0.06);
            band.position.set(x, h * (0.3 + rng() * 0.5), cz);
            this.city.add(band);
          }

          // 手前列: 広場側コーナーのネオン管
          if (row === 0 && rng() < 0.55) {
            const color = new THREE.Color(NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)]);
            const tubeMat = new THREE.MeshBasicMaterial({ color: color.multiplyScalar(1.6), toneMapped: false });
            for (const corner of [-1, 1]) {
              const tube = new THREE.Mesh(boxGeo, tubeMat);
              tube.scale.set(0.09, h, 0.09);
              tube.position.set(x - side * (w / 2 + 0.06), h / 2, cz + corner * (d / 2 + 0.06));
              this.city.add(tube);
            }
          }
        }
      }
    }
  }

  private pickStyle(rng: () => number): FacadeStyle {
    const r = rng();
    if (r < 0.4) return 'office';
    if (r < 0.72) return 'residential';
    if (r < 0.9) return 'glass';
    return 'dark';
  }

  // ---- 看板 ----

  private buildSigns(rng: () => number) {
    // 参考構図のヒーロー看板（必ず出る・広場の上空でビルに隠れない位置）
    this.addSign('CORIS', '#ff4cd2', -4.8, 12, -14, 8, false, rng);
    this.addSign('DANCE', '#b44cff', 5.2, 11, -24, 7, false, rng);

    // 街路の壁面ぎわに吊るす看板（ビルに隠れないよう |x| < STREET_HALF）
    const n = Math.round(this.params.signDensity * 30);
    for (let i = 0; i < n; i++) {
      const word = SIGN_WORDS[Math.floor(rng() * SIGN_WORDS.length)];
      const color = NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)];
      const side = rng() < 0.5 ? -1 : 1;
      const s = 3 + rng() * 4;
      const x = side * (STREET_HALF - 0.3 - rng() * 1.5 - s / 4);
      const y = 5 + rng() * 25;
      const z = -8 - rng() * 160;
      this.addSign(word, color, x, y, z, s, rng() < 0.3, rng);
    }
  }

  /** カメラ正対のネオン看板を1枚追加 */
  private addSign(
    word: string, colorHex: string,
    x: number, y: number, z: number, size: number,
    flickery: boolean, rng: () => number,
  ) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(4,4,12,0.9)';
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 10;
    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 24;
    ctx.strokeRect(18, 18, 476, 220);
    ctx.font = `bold ${word.length > 5 ? 88 : 120}px "Hiragino Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 32;
    ctx.fillText(word, 256, 134);
    ctx.shadowBlur = 0;
    ctx.fillStyle = colorHex;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillRect(0, 0, 512, 256);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(size, size / 2), mat);
    sign.position.set(x, y, z);
    // カメラ（+z側）に正対、わずかに内側へ振る
    sign.rotation.y = -Math.sign(x) * rng() * 0.15;
    this.city.add(sign);

    const entry: Sign = {
      material: mat,
      baseColor: new THREE.Color(1.6, 1.6, 1.6), // >1 でブルームに乗せる
      phase: rng() * 100,
      flickery,
    };
    mat.color.copy(entry.baseColor);
    this.signs.push(entry);
  }

  private addBeacon(x: number, h: number, z: number, rng: () => number) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2244, toneMapped: false });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), mat);
    beacon.position.set(x, h + 0.5, z);
    this.city.add(beacon);
    this.beacons.push({ material: mat, phase: rng() * 10 });
  }

  // ---- ダンスフロア ----

  private buildFloorTiles(rng: () => number) {
    this.floorTiles = [];
    for (let row = 0; row < FLOOR_ROWS; row++) {
      for (let col = 0; col < FLOOR_COLS; col++) {
        // 中央のテキストパネル領域は空けておく
        if (col >= 2 && col <= 6 && row >= 4 && row <= 7) continue;
        this.floorTiles.push({
          col,
          row,
          colorIdx: Math.floor(rng() * NEON_PALETTE.length),
          phase: rng() * Math.PI * 2,
          speed: 0.5 + rng() * 1.5,
          icon: rng() < 0.3 ? FLOOR_ICONS[Math.floor(rng() * FLOOR_ICONS.length)] : null,
        });
      }
    }
  }

  /** ダンスフロアを t 時点の状態に描き直す（t / params / タイル配置のみに依存） */
  private drawFloor(t: number) {
    const p = this.params;
    const ctx = this.floorCtx;
    const glow = Math.min(1, p.floorGlow);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#04040a';
    ctx.fillRect(0, 0, FLOOR_W, FLOOR_H);

    for (const tile of this.floorTiles) {
      const pulse = 0.55 + 0.45 * Math.sin(t * p.floorPulse * tile.speed + tile.phase);
      const col = NEON_PALETTE[tile.colorIdx];
      const px = tile.col * FLOOR_CELL;
      const py = tile.row * FLOOR_CELL;
      // タイルの淡い面
      ctx.globalAlpha = pulse * glow * 0.14;
      ctx.fillStyle = col;
      ctx.fillRect(px + 4, py + 4, FLOOR_CELL - 8, FLOOR_CELL - 8);
      // ネオン枠
      ctx.globalAlpha = pulse * glow;
      ctx.strokeStyle = col;
      ctx.lineWidth = 5;
      ctx.strokeRect(px + 6, py + 6, FLOOR_CELL - 12, FLOOR_CELL - 12);
      // アイコン
      if (tile.icon) {
        ctx.font = '46px "Hiragino Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = col;
        ctx.fillText(tile.icon, px + FLOOR_CELL / 2, py + FLOOR_CELL / 2 + 2);
      }
    }

    // 中央テキストパネル
    const panelX = 2 * FLOOR_CELL;
    const panelY = 4 * FLOOR_CELL;
    const panelW = 5 * FLOOR_CELL;
    const panelH = 4 * FLOOR_CELL;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(3,3,10,0.92)';
    ctx.fillRect(panelX + 4, panelY + 4, panelW - 8, panelH - 8);
    const pulse2 = 0.7 + 0.3 * Math.sin(t * p.floorPulse * 1.3);
    ctx.globalAlpha = pulse2 * glow;
    ctx.strokeStyle = '#ff4cd2';
    ctx.lineWidth = 4;
    ctx.strokeRect(panelX + 8, panelY + 8, panelW - 16, panelH - 16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 118px "Hiragino Sans", sans-serif';
    ctx.fillStyle = '#ff4cd2';
    ctx.fillText('CORIS', panelX + panelW / 2, panelY + panelH / 2);

    // 床全体の外周フレーム（二重のネオン枠）
    const framePulse = 0.75 + 0.25 * Math.sin(t * p.floorPulse * 0.9);
    ctx.globalAlpha = framePulse * glow;
    ctx.strokeStyle = '#4cc9ff';
    ctx.lineWidth = 10;
    ctx.strokeRect(7, 7, FLOOR_W - 14, FLOOR_H - 14);
    ctx.strokeStyle = '#ff4cd2';
    ctx.lineWidth = 3;
    ctx.strokeRect(22, 22, FLOOR_W - 44, FLOOR_H - 44);
    ctx.globalAlpha = 1;

    this.floorTex.needsUpdate = true;
  }

  // ---- テクスチャ生成 ----

  private makeBackdropTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 512;
    const ctx = c.getContext('2d')!;
    // 地平線に沈む光のグラデーション
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, 'rgba(10,10,40,0)');
    grad.addColorStop(0.55, 'rgba(90,50,200,0.35)');
    grad.addColorStop(0.8, 'rgba(255,80,220,0.75)');
    grad.addColorStop(1.0, 'rgba(160,220,255,0.95)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);
    // 消失点のコア（中央が最も明るい）
    const core = ctx.createRadialGradient(512, 500, 10, 512, 500, 340);
    core.addColorStop(0, 'rgba(255,240,255,0.9)');
    core.addColorStop(0.3, 'rgba(255,120,230,0.4)');
    core.addColorStop(1, 'rgba(255,120,230,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, 1024, 512);
    // 遠景ビルのシルエット + 窓の点（決定論: 固定シード）
    const rng = mulberry32(777);
    for (let i = 0; i < 110; i++) {
      const bw = 8 + rng() * 24;
      const bh = 50 + rng() * 280;
      const x = rng() * 1024;
      const hue = [300, 260, 200, 190][Math.floor(rng() * 4)];
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `hsla(${hue}, 90%, ${45 + rng() * 25}%, ${0.08 + rng() * 0.15})`;
      ctx.fillRect(x, 512 - bh, bw, bh);
      // 窓の点
      ctx.fillStyle = `hsla(${hue + 20}, 80%, 80%, 0.5)`;
      const nWin = Math.floor(bh / 14);
      for (let wy = 0; wy < nWin; wy++) {
        for (let wx = 0; wx < Math.floor(bw / 7); wx++) {
          if (rng() < 0.3) ctx.fillRect(x + 2 + wx * 7, 512 - bh + 4 + wy * 14, 3, 5);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * 1棟ぶんのファサード（窓）テクスチャ。
   * cols × floors のグリッドに窓を整列させ、スタイルごとの配色と
   * 「階ごとの点灯率の偏り」で実際の夜のビルらしさを出す。
   */
  private makeFacadeTexture(
    rng: () => number, cols: number, floors: number, style: FacadeStyle, storefront: boolean,
  ): THREE.Texture {
    const cw = 24, ch = 32; // 1窓セルのピクセルサイズ
    const c = document.createElement('canvas');
    c.width = cols * cw;
    c.height = floors * ch;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#030309';
    ctx.fillRect(0, 0, c.width, c.height);

    if (style === 'glass') {
      // カーテンウォール: 階ごとにガラス面全体が淡く光る
      for (let f = 0; f < floors; f++) {
        const bright = rng() < 0.12;
        const glow = bright ? 0.45 + rng() * 0.3 : 0.05 + rng() * 0.1;
        const hue = 195 + rng() * 30;
        ctx.fillStyle = `hsla(${hue}, 70%, 68%, ${glow})`;
        ctx.fillRect(0, f * ch + 3, c.width, ch - 4);
        // 床スラブの暗線
        ctx.fillStyle = 'rgba(0,0,0,0.9)';
        ctx.fillRect(0, f * ch, c.width, 3);
      }
      // 縦マリオン
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      for (let x = 0; x <= cols; x++) ctx.fillRect(x * cw - 1, 0, 2, c.height);
    } else {
      const litBase = style === 'office' ? 0.5 : style === 'residential' ? 0.4 : 0.08;
      for (let f = 0; f < floors; f++) {
        // 階ごとに点灯率が偏る: 全点灯のフロアも真っ暗なフロアもある
        let bias = litBase * (0.3 + rng() * 1.3);
        if (style === 'office' && rng() < 0.12) bias = 0.95;
        if (rng() < 0.1) bias = 0.02;
        for (let x = 0; x < cols; x++) {
          const wx = x * cw + 6, wy = f * ch + 7, ww = cw - 10, wh = ch - 12;
          if (rng() > bias) {
            // 消灯窓もガラスの照り返しでうっすら見える
            ctx.fillStyle = 'rgba(80,95,130,0.07)';
            ctx.fillRect(wx, wy, ww, wh);
            continue;
          }
          let hue: number, sat: number, lum: number;
          if (style === 'office') {
            hue = 200 + rng() * 40; sat = 15 + rng() * 30; lum = 75 + rng() * 20;
          } else {
            hue = 28 + rng() * 20; sat = 60 + rng() * 35; lum = 58 + rng() * 25;
          }
          // まれに色物（テレビの光・ネオンテナント）
          if (rng() < 0.05) { hue = rng() < 0.5 ? 190 : 315; sat = 90; lum = 65; }
          ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${0.55 + rng() * 0.45})`;
          ctx.fillRect(wx, wy, ww, wh);
          // カーテン・部屋の奥行きの明暗
          if (rng() < 0.35) {
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            const half = rng() < 0.5;
            ctx.fillRect(wx, wy + (half ? wh / 2 : 0), ww, wh / 2);
          }
        }
      }
      // 床スラブの暗線と縦マリオンで構造感を出す
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (let f = 0; f <= floors; f++) ctx.fillRect(0, f * ch - 1, c.width, 2);
      ctx.fillStyle = 'rgba(15,20,35,0.5)';
      for (let x = 0; x <= cols; x++) ctx.fillRect(x * cw - 1, 0, 1, c.height);
    }

    // 1階の店舗（明るい連続した光の帯）
    if (storefront) {
      const hue = [315, 190, 35, 280][Math.floor(rng() * 4)];
      ctx.fillStyle = `hsla(${hue}, 85%, 65%, 0.85)`;
      ctx.fillRect(2, c.height - ch + 4, c.width - 4, ch - 8);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      for (let x = 1; x < cols * 2; x++) ctx.fillRect(x * (cw / 2), c.height - ch + 4, 2, ch - 8);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ---- フレーム更新 ----

  setSize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** t 秒時点の状態にシーンを更新する（t と params のみに依存） */
  update(t: number) {
    const p = this.params;

    // ルック系パラメータの反映（毎フレーム代入するだけなので安い）
    this.renderer.toneMappingExposure = p.exposure;
    this.bloom.strength = p.bloomStrength;
    this.bloom.radius = p.bloomRadius;
    this.bloom.threshold = p.bloomThreshold;
    (this.scene.fog as THREE.FogExp2).density = p.fogDensity;
    this.groundMat.opacity = 1 - p.reflection;
    this.backdropMat.opacity = p.backdropGlow;
    for (const m of this.facadeMats) m.emissiveIntensity = p.windowGlow;
    if (this.camera.fov !== p.fov) {
      this.camera.fov = p.fov;
      this.camera.updateProjectionMatrix();
    }

    // カメラ: デフォルトは広場に静止（Speed 0）。上げると奥へドリーする。
    // 揺れも含めてカメラ時間 camT = t * speed で動かす → Speed 0 で完全静止
    const camT = t * p.camSpeed;
    const z = 17 - (camT % (CITY_LENGTH - 60));
    const swayX = Math.sin(camT * 0.11) * p.camSway;
    this.camera.position.set(swayX, p.camHeight + Math.sin(camT * 0.175) * 0.4, z);
    this.camera.lookAt(swayX * 0.3, p.camHeight + 1.4, z - 40);

    // 遠景はカメラに追従（無限遠のフェイク）。下端を地平線(y=0)に合わせる
    this.backdrop.position.set(0, 75, z - 160);

    // ダンスフロアのパルス
    this.drawFloor(t);

    // 看板のフリッカー
    for (const sign of this.signs) {
      let level = 0.88 + 0.12 * Math.sin(t * 3 + sign.phase);
      if (sign.flickery) {
        const gate = hash01(Math.floor(t * 9) + sign.phase);
        if (gate < 0.14) level *= 0.15; // ときどき消える
      }
      sign.material.color.copy(sign.baseColor).multiplyScalar(level * p.signGlow);
    }

    // 屋上ビーコンの点滅
    for (const b of this.beacons) {
      const on = Math.sin(t * 2.2 + b.phase) > 0.4;
      b.material.color.setScalar(on ? 1 : 0.08).multiply(new THREE.Color(3, 0.5, 0.8));
    }
  }

  render() {
    this.composer.render();
  }

  dispose() {
    this.regenerate(); // 生成物を破棄（cleared groups は空のまま捨てる）
    this.disposables.forEach((d) => d.dispose());
    this.composer.dispose();
    this.renderer.dispose();
  }
}
