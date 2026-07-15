import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { SIGN_FONT_FAMILY } from './fonts';
import { windowMaskVariants } from './windowMask';
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

/**
 * 4拍子のビートグリッド: period拍ごと・slot拍目にフラッシュし、1拍かけて減衰する。
 * 全要素がこのグリッドに乗るので、テンポが「小節」として感じられる。
 */
function beatHit(beat: number, slot: number, period: number) {
  const f = (((beat - slot) % period) + period) % period;
  return f < 1 ? (1 - f) * (1 - f) : 0;
}

// 最終段のカラーグレード: 彩度・コントラスト・シャドウの紫転び・ビネット
// OutputPass の後（表示色空間）に掛けるので、写真のLUT補正と同じ感覚で効く
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSaturation: { value: 1.25 },
    uContrast: { value: 1.06 },
    uTint: { value: 0.5 },
    uTintColor: { value: new THREE.Color(0.42, 0.28, 1.0) },
    uVignette: { value: 0.35 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation, uContrast, uTint, uVignette;
    uniform vec3 uTintColor;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSaturation);
      c.rgb = (c.rgb - 0.5) * uContrast + 0.5;
      // 暗部だけ紫に持ち上げる（黒が紺紫に転ぶネオン夜景のルック）
      c.rgb += uTintColor * (uTint * 0.14 * (1.0 - smoothstep(0.0, 0.55, l)));
      vec2 q = vUv - 0.5;
      c.rgb *= 1.0 - uVignette * smoothstep(0.2, 0.9, dot(q, q) * 2.4);
      gl_FragColor = clamp(c, 0.0, 1.0);
    }
  `,
};

/**
 * 濡れたアスファルトの反射シェーダー（Reflector用）。
 * 鏡像カメラで描いたシーン(tDiffuse)を、
 * - 骨材ノイズでUVを揺らし（濡れ面の歪み）
 * - 下方向に減衰サンプルして光を縦に伸ばし（ストリークブラー）
 * - 水たまりマスクで場所ごとの反射強度を変えて
 * アスファルトの粒感と合成する。
 */
const WetAsphaltShader = {
  name: 'WetAsphaltShader',
  uniforms: {
    color: { value: null as THREE.Color | null }, // Reflectorが設定する（未使用）
    tDiffuse: { value: null as THREE.Texture | null },
    textureMatrix: { value: null as THREE.Matrix4 | null },
    tAsphalt: { value: null as THREE.Texture | null },
    tPuddle: { value: null as THREE.Texture | null },
    uWet: { value: 0.5 },
    uBlur: { value: 0.013 },
    uDistort: { value: 0.02 },
    uFogColor: { value: new THREE.Color(0x231a70) },
    uFogDensity: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUvProj;
    varying vec2 vUvLocal;
    varying float vDist;
    void main() {
      vUvProj = textureMatrix * vec4(position, 1.0);
      vUvLocal = uv;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vDist = -mvPosition.z;
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D tAsphalt;
    uniform sampler2D tPuddle;
    uniform float uWet, uBlur, uDistort, uFogDensity;
    uniform vec3 uFogColor;
    varying vec4 vUvProj;
    varying vec2 vUvLocal;
    varying float vDist;
    void main() {
      // 濡れた路面の歪み: 骨材ノイズで反射UVを揺らす
      float n1 = texture2D(tAsphalt, vUvLocal * vec2(26.0, 52.0)).b;
      float n2 = texture2D(tAsphalt, vUvLocal * vec2(13.0, 21.0) + 0.37).b;
      vec2 uv = vUvProj.xy / vUvProj.w + vec2(n1 - 0.5, n2 - 0.5) * uDistort;
      // 縦ストリーク: 下方向に減衰サンプルして光を伸ばす
      vec3 refl = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float w = 1.0 - fi / 12.0;
        refl += texture2D(tDiffuse, uv - vec2(0.0, fi * uBlur)).rgb * w;
        wsum += w;
      }
      refl /= wsum;
      float puddle = 1.0 - texture2D(tPuddle, vUvLocal).g; // 1 = 水たまり
      vec3 asphalt = texture2D(tAsphalt, vUvLocal).rgb;
      float wet = clamp(uWet * (0.3 + 0.9 * puddle), 0.0, 1.0);
      vec3 col = asphalt * (1.0 - wet * 0.75) + refl * wet;
      float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
      gl_FragColor = vec4(mix(col, uFogColor, fogF), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// 窓スタンプの着色用の共有ワークキャンバス（source-inで色を乗せてから貼る）
let stampTmp: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx2D } | null = null;
function tintedStamp(stamp: CanvasImageSource, color: string): HTMLCanvasElement | OffscreenCanvas {
  if (!stampTmp) stampTmp = create2DCanvas(64, 64);
  const { canvas, ctx } = stampTmp;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, 64, 64);
  ctx.drawImage(stamp, 0, 0, 64, 64);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

// メインスレッド（HTMLCanvasElement）とWorker（OffscreenCanvas）の両方で動くcanvas生成
function create2DCanvas(width: number, height: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx2D } {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: canvas.getContext('2d')! };
  }
  const canvas = new OffscreenCanvas(width, height);
  return { canvas, ctx: canvas.getContext('2d') as OffscreenCanvasRenderingContext2D };
}

type FacadeStyle = 'office' | 'residential' | 'glass' | 'dark';

// 参照の色域を青・紫・赤へ限定。黄／緑を混ぜないことで夜景全体の色を統一する。
const NEON_PALETTE = ['#2878ff', '#4cc9ff', '#5b42ff', '#9b3dff', '#d830d7', '#ff2e67', '#ff4ca0'];
const SIGN_WORDS = ['CORIS', 'DANCE', 'GUM', 'GUMGUM', 'COMECOME', 'FUEGUM'];
const FLOOR_ICONS = ['♪', '★', '♥', '◆'];

const CITY_LENGTH = 420; // 街の奥行き
const STREET_HALF = 15; // 中央の通りを広く取り、近景ビルを画面両端へ退避
const CAMERA_BASE_Z = 34; // カメラの基準z（大きいほど手前に下がりステージが広く見える）
const CITY_START_Z = -12; // ビル群の手前端（ステージ広場との間に間合いを作り、都市を奥に離す）
const CAP_START_Z = -115; // 中央の建物は十分に遠方から開始し、手前の通りを開けておく

// ダンスフロアのグリッド
const FLOOR_COLS = 9;
const FLOOR_ROWS = 6; // ステージの奥行きを半分に（タイルが正方形を保つよう幅列数の半分に設定）
const FLOOR_CELL = 84; // px
const FLOOR_W = FLOOR_COLS * FLOOR_CELL;
const FLOOR_H = FLOOR_ROWS * FLOOR_CELL;

interface Sign {
  material: THREE.MeshBasicMaterial;
  baseColor: THREE.Color;
  phase: number; // フリッカーゲート用の乱数
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
  icon: string | null;
}

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;

  private backdrop!: THREE.Mesh; // 遠景の光（カメラ追従）
  private backdropMat!: THREE.MeshBasicMaterial;
  private groundUniforms!: Record<string, THREE.IUniform>; // 濡れアスファルト反射のuniforms
  private city = new THREE.Group(); // 静的な街（ビル）
  private signGroup = new THREE.Group(); // 文字ネオン看板（トグルで表示切替）
  private signs: Sign[] = [];
  private beacons: Beacon[] = [];
  private facadeMats: THREE.MeshStandardMaterial[] = [];
  // 建物の輪郭線（全ブロック共有。LineSegmentsはMeshではないのでdisposeループの対象外）
  private outlineMat = new THREE.LineBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.3 });
  private edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  private disposables: { dispose(): void }[] = [];

  // ダンスフロア
  private floorMesh!: THREE.Mesh;
  private floorCtx: Ctx2D;
  private floorTex: THREE.CanvasTexture<HTMLCanvasElement | OffscreenCanvas>;
  private floorTiles: FloorTile[] = [];

  readonly params: Params;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, params: Params) {
    this.params = params;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080630);
    this.scene.fog = new THREE.FogExp2(0x231a70, params.fogDensity);

    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);

    this.scene.add(this.city, this.signGroup);
    this.scene.add(new THREE.AmbientLight(0x2a2070, 1.4));

    // 地面: 本物の平面リフレクション（鏡像カメラでシーンを毎フレーム描く）。
    // カスタムシェーダーで縦ストリーク・ノイズ歪み・水たまりマスクを掛けて濡れたアスファルトにする
    const asphalt = this.makeAsphaltTextures();
    asphalt.map.wrapS = asphalt.map.wrapT = THREE.RepeatWrapping; // 歪みノイズ用にタイル参照する
    const ground = new Reflector(new THREE.PlaneGeometry(160, CITY_LENGTH + 100), {
      textureWidth: 1024,
      textureHeight: 1024,
      clipBias: 0.003,
      shader: WetAsphaltShader,
    });
    const groundMat = ground.material as THREE.ShaderMaterial;
    this.groundUniforms = groundMat.uniforms;
    this.groundUniforms.tAsphalt.value = asphalt.map;
    this.groundUniforms.tPuddle.value = asphalt.alphaMap;
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0.001, -CITY_LENGTH / 2 + 30);
    ground.renderOrder = 1;
    this.scene.add(ground);
    this.disposables.push(ground.geometry, groundMat, asphalt.map, asphalt.alphaMap, {
      dispose: () => ground.dispose(),
    });

    // ダンスフロア: 手前の広場。毎フレーム canvas を描き直してパルスさせる
    const { canvas: floorCanvas, ctx: floorCtx } = create2DCanvas(FLOOR_W, FLOOR_H);
    this.floorCtx = floorCtx;
    this.floorTex = new THREE.CanvasTexture(floorCanvas);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    const floorMat = new THREE.MeshBasicMaterial({ map: this.floorTex, toneMapped: false });
    // 奥行きは stageDepth パラメータで可変（手前端 z=28 固定、update() でスケール反映）
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 16), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.02, 20);
    floor.renderOrder = 2;
    this.floorMesh = floor;
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
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade); // OutputPass後 = 表示色空間でのグレーディング

    this.regenerate();
  }

  /** params の生成系パラメータ（seed / density / heightScale / signDensity）から街を作り直す */
  regenerate() {
    for (const group of [this.city, this.signGroup]) {
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
    // 床反射はReflector（鏡像カメラ）が毎フレーム描くので、上下反転コピーは不要
  }

  // ---- 街の生成 ----

  private buildCity(rng: () => number) {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.95 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.9 });
    // 窓テクスチャだけに頼らず、近景の壁面に実体のある縦リブ／機械階を与える。
    // 参照画像のように、建物が一枚の平面に見えないための暗い構造材。
    const facadeTrimMat = new THREE.MeshStandardMaterial({ color: 0x02040d, roughness: 0.88, metalness: 0.35 });

    // 1棟ぶんのボックス（各面に階・列が揃った窓テクスチャ）
    const makeBlock = (
      w: number,
      h: number,
      d: number,
      style: FacadeStyle,
      storefront: boolean,
      windowScale = 1,
    ) => {
      // 参照のビルは黒に近い藍の外装。その上に窓と縦ネオンだけが立つよう、
      // 壁面自体は明るい青にしない。
      const floors = Math.max(5, Math.round((h / 1.65) * windowScale));
      const bodyColor = new THREE.Color().setHSL(0.62 + rng() * 0.07, 0.38 + rng() * 0.16, 0.012 + rng() * 0.018);
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
      // 小さめの窓ピッチにし、近景でも「大きな発光ブロック」ではなく
      // 住居・オフィスの窓が密集した壁面に見せる。
      const matZ = mkMat(Math.max(3, Math.round((w / 1.15) * windowScale))); // 前後面
      const matX = mkMat(Math.max(3, Math.round((d / 1.15) * windowScale))); // 側面
      const mesh = new THREE.Mesh(boxGeo, [matX, matX, roofMat, roofMat, matZ, matZ]);
      mesh.scale.set(w, h, d);
      return mesh;
    };

    // 建物の輪郭線: ブロックと同じ変形のワイヤーフレームを重ねる（Outlineフェーダーで濃度をライブ調整）
    const addOutline = (m: THREE.Mesh) => {
      const e = new THREE.LineSegments(this.edgesGeo, this.outlineMat);
      e.position.copy(m.position);
      e.scale.copy(m.scale);
      this.city.add(e);
    };

    const { heightScale, edgeLights } = this.params;
    // この構図はランダムな都市ではなく、参照画像と同じ「画面両端のビル群／中央の抜け」を
    // 作るための固定レイアウト。近景は巨大な壁にせず、低めの箱を雑に数個並べる。
    const referenceSideLayout: Array<{ row: number; z: number; x: number; w: number; d: number; h: number; style: FacadeStyle }> = [
      { row: 0, z: -18, x: 30, w: 5, d: 7, h: 42, style: 'residential' },
      { row: 0, z: -32, x: 26, w: 6, d: 6, h: 36, style: 'office' },
      { row: 0, z: -50, x: 32, w: 5, d: 8, h: 54, style: 'residential' },
      { row: 0, z: -70, x: 28, w: 6, d: 7, h: 48, style: 'office' },
      { row: 1, z: -40, x: 39, w: 7, d: 9, h: 84, style: 'office' },
      { row: 1, z: -72, x: 43, w: 6, d: 8, h: 72, style: 'residential' },
      { row: 1, z: -98, x: 37, w: 7, d: 9, h: 96, style: 'office' },
      { row: 2, z: -58, x: 52, w: 6, d: 8, h: 82, style: 'dark' },
      { row: 2, z: -92, x: 48, w: 6, d: 8, h: 78, style: 'office' },
    ];
    for (const side of [-1, 1] as const) {
      for (const spec of referenceSideLayout) {
          const { row, z: cz, w, d, style } = spec;
          // 左右を完全な鏡像にせず、雑に置かれた都市ブロックのズレを出す。
          const h = spec.h * heightScale * (side === -1 ? 0.9 + rng() * 0.12 : 0.98 + rng() * 0.14);
          const x = side * (spec.x + (rng() - 0.35) * (row === 0 ? 3.5 : 2.2));
          const zJitter = cz + (rng() - 0.5) * (row === 0 ? 5 : 3);

          const base = makeBlock(w, h, d, style, row === 0 && rng() < 0.6);
          base.position.set(x, h / 2, zJitter);
          this.city.add(base);
          addOutline(base);

          if (row < 2) {
            // 前面（カメラ側）に縦リブを重ねる。リブ間隔をランダムにして、
            // 一様なグリッドではなくビルごとの構造差を作る。
            const ribs = 2 + Math.floor(rng() * 3);
            for (let i = 1; i <= ribs; i++) {
              const rib = new THREE.Mesh(boxGeo, facadeTrimMat);
              const rx = x - w / 2 + (w * i) / (ribs + 1);
              rib.scale.set(0.10 + rng() * 0.06, h, 0.14);
              rib.position.set(rx, h / 2, zJitter + d / 2 + 0.075);
              this.city.add(rib);
            }
            // 低い機械階の帯を少数だけ設け、立面に尺度を与える。
            if (rng() < 0.7) {
              const belt = new THREE.Mesh(boxGeo, facadeTrimMat);
              belt.scale.set(w + 0.06, 0.18, 0.16);
              belt.position.set(x, h * (0.18 + rng() * 0.48), zJitter + d / 2 + 0.08);
              this.city.add(belt);
            }
          }

          if (row >= 2) {
            // 遠景の簡易スカイライン: 描画コストを抑え、まれにクラウン照明のみ
            if (h > 90 && rng() < 0.3) {
              const color = new THREE.Color(NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)]);
              const crown = new THREE.Mesh(
                boxGeo,
                new THREE.MeshBasicMaterial({ color: color.multiplyScalar(1.1), toneMapped: false }),
              );
              crown.scale.set(w + 0.15, 0.12, d + 0.15);
              crown.position.set(x, h + 0.06, zJitter);
              this.city.add(crown);
            }
            continue;
          }

          // ビル正面エッジの細い縦ライン（参照画像の構造ライト。Edge Lightsフェーダーで密度調整）
          if (rng() < edgeLights) {
            const edgeColor = new THREE.Color(['#2878ff', '#9b3dff', '#ff2e67'][Math.floor(rng() * 3)]);
            const edgeMat = new THREE.MeshBasicMaterial({ color: edgeColor.multiplyScalar(0.55), toneMapped: false });
            for (const corner of [-1, 1]) {
              const line = new THREE.Mesh(boxGeo, edgeMat);
              const lh = h * (0.85 + rng() * 0.15);
              line.scale.set(0.035, lh * 0.72, 0.035);
              line.position.set(x + corner * (w / 2 + 0.025), lh * 0.36, zJitter + d / 2 + 0.025);
              this.city.add(line);
            }
          }

          // セットバック（段状の塔屋）
          let topY = h;
          let topW = w;
          let topD = d;
          let topX = x;
          let topZ = zJitter;
          if (h > 22 && rng() < 0.55) {
            topW = w * (0.5 + rng() * 0.25);
            topD = d * (0.5 + rng() * 0.25);
            const h2 = h * (0.3 + rng() * 0.3);
            topX = x + (rng() - 0.5) * (w - topW) * 0.5;
            topZ = zJitter + (rng() - 0.5) * (d - topD) * 0.5;
            const upper = makeBlock(topW, h2, topD, style, false);
            upper.position.set(topX, h + h2 / 2, topZ);
            this.city.add(upper);
            addOutline(upper);
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
            band.position.set(x, h * (0.3 + rng() * 0.5), zJitter);
            this.city.add(band);
          }

          // 手前列: 広場側コーナーのネオン管（参照画像の太い縦チューブ）
          if (row === 0 && rng() < 0.28) {
            const color = new THREE.Color(NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)]);
            const tubeMat = new THREE.MeshBasicMaterial({ color: color.multiplyScalar(1.8), toneMapped: false });
            for (const corner of [-1, 1]) {
              const tube = new THREE.Mesh(boxGeo, tubeMat);
              tube.scale.set(0.065, h * 0.56, 0.065);
              tube.position.set(x - side * (w / 2 + 0.04), h * 0.48, zJitter + corner * (d / 2 + 0.04));
              this.city.add(tube);
            }
          }
          // 2列目のタワーにも縦ネオン管（画面の左右上部に青白い縦線が立つ）
          if (row === 1 && rng() < 0.16) {
            const color = new THREE.Color(rng() < 0.6 ? '#4cc9ff' : NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)]);
            const tubeMat = new THREE.MeshBasicMaterial({ color: color.multiplyScalar(1.7), toneMapped: false });
            const tube = new THREE.Mesh(boxGeo, tubeMat);
            const th = h * (0.5 + rng() * 0.45);
            tube.scale.set(0.07, th * 0.65, 0.07);
            tube.position.set(x - side * (w / 2 + 0.04), h - th * 0.34, zJitter + d / 2 + 0.04);
            this.city.add(tube);
          }
      }
    }

    // 通りの中央は手前から空け、消失点の奥に横長のスカイラインを置く。
    // ただし同一Zに揃えると壁になるため、前後3層に分けて奥行きの段差を見せる。
    const distantTowers: Array<{ x: number; z: number; w: number; d: number; h: number; style: FacadeStyle }> = [
      { x: -46, z: -126, w: 4.5, d: 6.5, h: 66, style: 'dark' },
      { x: -33, z: -138, w: 4.5, d: 6.5, h: 86, style: 'office' },
      { x: -18, z: -124, w: 4, d: 6, h: 74, style: 'residential' },
      { x: -6, z: -142, w: 4.5, d: 6.5, h: 98, style: 'glass' },
      { x: 8, z: -130, w: 4, d: 6, h: 90, style: 'residential' },
      { x: 22, z: -146, w: 4.5, d: 6.5, h: 104, style: 'office' },
      { x: 38, z: -132, w: 4.5, d: 6.5, h: 76, style: 'glass' },
      { x: -40, z: -166, w: 3.8, d: 5.8, h: 58, style: 'residential' },
      { x: -27, z: -184, w: 4, d: 6, h: 78, style: 'office' },
      { x: -13, z: -170, w: 3.8, d: 5.5, h: 92, style: 'office' },
      { x: 0, z: -190, w: 3.5, d: 5.5, h: 104, style: 'glass' },
      { x: 14, z: -174, w: 3.8, d: 5.5, h: 88, style: 'residential' },
      { x: 29, z: -186, w: 4, d: 6, h: 80, style: 'office' },
      { x: 43, z: -168, w: 3.8, d: 5.8, h: 62, style: 'dark' },
      { x: -34, z: -218, w: 3.2, d: 5, h: 52, style: 'dark' },
      { x: -20, z: -232, w: 3.2, d: 5, h: 64, style: 'residential' },
      { x: -7, z: -214, w: 3, d: 4.8, h: 72, style: 'office' },
      { x: 7, z: -226, w: 3, d: 4.8, h: 70, style: 'glass' },
      { x: 21, z: -212, w: 3.2, d: 5, h: 62, style: 'residential' },
      { x: 35, z: -236, w: 3.2, d: 5, h: 54, style: 'office' },
    ];
    for (const tower of distantTowers) {
      const h = tower.h * heightScale;
      const cap = makeBlock(tower.w, h, tower.d, tower.style, false, 1.35);
      const depthSink = Math.max(0, (-tower.z - 150) * 0.055);
      cap.position.set(tower.x, h / 2 - depthSink, tower.z);
      this.city.add(cap);
      addOutline(cap);
    }

    // 遠景の隙間を埋める細いビル群。固定の大きめタワーの間に置き、奥の密度だけを増やす。
    for (let i = 0; i < 36; i++) {
      const layer = i % 3;
      const t = i / 35;
      const sideBias = (i % 2 === 0 ? -1 : 1) * (1.5 + rng() * 4.5);
      const x = -44 + t * 88 + sideBias;
      const z = layer === 0 ? -154 - rng() * 24 : layer === 1 ? -190 - rng() * 34 : -230 - rng() * 42;
      const depth = (-z - 150) / 120;
      const w = Math.max(2.1, 3.4 - depth * 0.75 + rng() * 0.55);
      const d = Math.max(3.8, 5.2 - depth * 0.65 + rng() * 0.8);
      const h = (46 + rng() * 54 - depth * 12) * heightScale;
      const style = this.pickStyle(rng);
      const filler = makeBlock(w, h, d, style, false, 1.45);
      const depthSink = Math.max(0, (-z - 150) * 0.06);
      filler.position.set(x, h / 2 - depthSink, z);
      this.city.add(filler);
      addOutline(filler);
    }
  }

  private pickStyle(rng: () => number): FacadeStyle {
    const r = rng();
    if (r < 0.5) return 'office';
    if (r < 0.88) return 'residential';
    if (r < 0.96) return 'glass';
    return 'dark';
  }

  // ---- 看板 ----

  private buildSigns(rng: () => number) {
    // 参考構図のヒーロー看板（必ず出る・広場の上空でビルに隠れない位置）
    this.addSign('CORIS', '#ff4cd2', -4.8, 12, -20, 8, false, rng);
    this.addSign('DANCE', '#b44cff', 5.2, 11, -30, 7, false, rng);

    // カメラから見える3つの帯に配置して画面全体に散らす:
    // 低層帯 = ステージ際の手前ビル正面 / 中層帯 = 手前ビル屋上より上・2列目タワーの正面 / 奥 = 通りの上空
    const target = Math.round(this.params.signDensity * 30);
    for (let i = 0; i < target; i++) {
      const word = SIGN_WORDS[Math.floor(rng() * SIGN_WORDS.length)];
      const color = NEON_PALETTE[Math.floor(rng() * NEON_PALETTE.length)];
      const side = rng() < 0.5 ? -1 : 1;
      const r = rng();
      let x: number, y: number, z: number, s: number;
      if (r < 0.4) {
        // 低層帯（画面の左右下寄り）
        s = 2 + rng() * 2.5;
        x = side * (9.6 + rng() * 1.6);
        y = 2.2 + rng() * 5;
        z = -5 - rng() * 40;
      } else if (r < 0.8) {
        // 中層帯（画面の左右上寄り、手前ビルの屋上より上なので隠れない）
        s = 3 + rng() * 3.5;
        x = side * (12.5 + rng() * 6);
        y = 10 + rng() * 15;
        z = -8 - rng() * 55;
      } else {
        // 奥（消失点まわりの深度感）
        s = 3 + rng() * 4;
        x = side * (9 + rng() * 5);
        y = 8 + rng() * 20;
        z = -60 - rng() * 100;
      }
      this.addSign(word, color, x, y, z, s, rng() < 0.3, rng);
    }
  }

  /** カメラ正対のネオン看板を1枚追加 */
  private addSign(
    word: string, colorHex: string,
    x: number, y: number, z: number, size: number,
    flickery: boolean, rng: () => number,
  ) {
    const { canvas: c, ctx } = create2DCanvas(512, 256);
    ctx.fillStyle = 'rgba(4,4,12,0.9)';
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 10;
    ctx.shadowColor = colorHex;
    ctx.shadowBlur = 24;
    ctx.strokeRect(18, 18, 476, 220);
    ctx.font = `700 ${word.length > 5 ? 72 : 96}px "${SIGN_FONT_FAMILY}", "Hiragino Sans", sans-serif`;
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
    this.signGroup.add(sign);

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
        if (col >= 2 && col <= 6 && row >= 2 && row <= 3) continue;
        this.floorTiles.push({
          col,
          row,
          colorIdx: Math.floor(rng() * NEON_PALETTE.length),
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

    // BPM同期: 床は基本点灯のまま、拍のたびに一部のタイルだけがランダムに選ばれてフラッシュする。
    // どのタイルが光るかは拍番号から決定論的に決まる（書き出しでも同じ結果）。
    // beatDepth (Intensity) はフラッシュの強さ、floorPulse は拍レート倍率。
    const beat = (t * p.bpm / 60) * p.floorPulse;
    const beatIdx = Math.floor(beat);
    const frac = beat - beatIdx;
    const flashEnv = (1 - frac) * (1 - frac); // 拍頭で1 → 拍内で減衰
    const depth = p.beatDepth;
    const downbeat = beatIdx % 4 === 0; // 小節頭は少し多めに光る
    const selectProb = downbeat ? 0.22 : 0.12;

    for (let i = 0; i < this.floorTiles.length; i++) {
      const tile = this.floorTiles[i];
      const chosen = hash01(i * 13.37 + beatIdx * 101.7) < selectProb;
      const flash = chosen ? flashEnv * depth : 0;
      const pulse = 0.68 + 0.32 * flash; // ベース0.68で常時点灯、選ばれたタイルだけ持ち上がる
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
    const panelY = 2 * FLOOR_CELL;
    const panelW = 5 * FLOOR_CELL;
    const panelH = 2 * FLOOR_CELL;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(3,3,10,0.92)';
    ctx.fillRect(panelX + 4, panelY + 4, panelW - 8, panelH - 8);
    // CORISパネルは小節頭に1回だけ控えめにフラッシュ
    const pulse2 = 0.8 + 0.2 * depth * beatHit(beat, 0, 4);
    ctx.globalAlpha = pulse2 * glow;
    ctx.strokeStyle = '#ff4cd2';
    ctx.lineWidth = 4;
    ctx.strokeRect(panelX + 8, panelY + 8, panelW - 16, panelH - 16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 104px "${SIGN_FONT_FAMILY}", "Hiragino Sans", sans-serif`;
    ctx.fillStyle = '#ff4cd2';
    ctx.fillText('CORIS', panelX + panelW / 2, panelY + panelH / 2);

    // 床全体の外周フレーム: 3拍目に応答（コール&レスポンス）
    const framePulse = 0.75 + 0.25 * depth * beatHit(beat, 2, 4);
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

  /**
   * 雨上がりのアスファルト用テクスチャを生成する（固定シードで決定論的）。
   * map: 粒状のざらつき + 補修痕・汚れの明暗ムラ（暗い青灰）
   * alphaMap: 白=乾いた路面（下の鏡像を隠す）/ 暗=水たまり（鏡像が透けて反射に見える）
   */
  private makeAsphaltTextures(): { map: THREE.Texture; alphaMap: THREE.Texture } {
    const rng = mulberry32(4242);

    // 粒状ノイズ: アスファルトの骨材。青寄りの暗いグレー
    const W = 1024, H = 2048;
    const { canvas: mc, ctx: mctx } = create2DCanvas(W, H);
    const img = mctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const g = rng();
      const v = 8 + g * g * 24; // 大半は暗く、まれに明るい粒
      img.data[i * 4] = v * 0.9;
      img.data[i * 4 + 1] = v * 0.92;
      img.data[i * 4 + 2] = v * 1.35;
      img.data[i * 4 + 3] = 255;
    }
    mctx.putImageData(img, 0, 0);
    // 大きめの明暗ムラ（パッチ補修・オイル汚れ）
    for (let i = 0; i < 40; i++) {
      const x = rng() * W, y = rng() * H, r = 60 + rng() * 260;
      const gr = mctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, rng() < 0.5 ? 'rgba(0,0,8,0.25)' : 'rgba(40,44,70,0.10)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      mctx.fillStyle = gr;
      mctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    const map = new THREE.CanvasTexture(mc);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;

    // 水たまりマップ（アルファ）: 路面はうっすら濡れ、ところどころに濃い水たまり
    const AW = 512, AH = 1024;
    const { canvas: ac, ctx: actx } = create2DCanvas(AW, AH);
    actx.fillStyle = '#e0e0e0';
    actx.fillRect(0, 0, AW, AH);
    for (let i = 0; i < 60; i++) {
      const x = rng() * AW, y = rng() * AH;
      const r = 5 + rng() * rng() * 45;
      const g = actx.createRadialGradient(x, y, 0, x, y, r);
      const depth = 0.55 + rng() * 0.4;
      g.addColorStop(0, `rgba(18,18,18,${depth})`);
      g.addColorStop(0.7, `rgba(40,40,40,${depth * 0.55})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      actx.fillStyle = g;
      actx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // 湿った縦筋（雨水の流れた跡）
    for (let i = 0; i < 70; i++) {
      const x = rng() * AW, y = rng() * AH, sw = 2 + rng() * 8, sh = 40 + rng() * 200;
      actx.fillStyle = `rgba(70,70,70,${0.05 + rng() * 0.1})`;
      actx.fillRect(x, y, sw, sh);
    }
    const alphaMap = new THREE.CanvasTexture(ac);
    alphaMap.anisotropy = 8;

    return { map, alphaMap };
  }

  private makeBackdropTexture(): THREE.Texture {
    const { canvas: c, ctx } = create2DCanvas(1024, 512);
    // 地平線に沈む光のグラデーション（青紫のアトモスフィアを基調に、白く飛ばさない）
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, 'rgba(12,8,50,0)');
    grad.addColorStop(0.5, 'rgba(22,50,175,0.38)');
    grad.addColorStop(0.8, 'rgba(38,90,225,0.62)');
    grad.addColorStop(1.0, 'rgba(70,150,255,0.78)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);
    // 消失点のコア。白いモヤではなく、冷たい青の霞として見せる。
    const core = ctx.createRadialGradient(512, 500, 10, 512, 500, 300);
    core.addColorStop(0, 'rgba(90,190,255,0.58)');
    core.addColorStop(0.35, 'rgba(55,120,255,0.28)');
    core.addColorStop(1, 'rgba(30,70,220,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, 1024, 512);
    // 遠景ビルのシルエット + 窓の点（決定論: 固定シード、紫〜青系中心に密集させる）
    const rng = mulberry32(777);
    for (let i = 0; i < 220; i++) {
      const bw = 6 + rng() * 20;
      const bh = 40 + rng() * 320;
      const x = rng() * 1024;
      const hue = [265, 245, 225, 290][Math.floor(rng() * 4)];
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `hsla(${hue}, 85%, ${40 + rng() * 25}%, ${0.07 + rng() * 0.13})`;
      ctx.fillRect(x, 512 - bh, bw, bh);
      // 窓の点
      ctx.fillStyle = `hsla(${hue + 15}, 70%, 82%, 0.45)`;
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
    const cw = 20, ch = 20; // 高密度な窓セル。参照の細かい窓明かりに合わせる
    const { canvas: c, ctx } = create2DCanvas(cols * cw, floors * ch);
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
      // 同一ビル内でも赤紫の生活光と青紫のオフィス光を混在させる。
      const warmRatio = style === 'office' ? 0.2 + rng() * 0.3 : 0.5 + rng() * 0.35;
      for (let f = 0; f < floors; f++) {
        // 階ごとに点灯率が偏る: 全点灯のフロアも真っ暗なフロアもある
        let bias = litBase * (0.3 + rng() * 1.3);
        if (style === 'office' && rng() < 0.12) bias = 0.95;
        if (rng() < 0.1) bias = 0.02;
        const stamps = windowMaskVariants();
        for (let x = 0; x < cols; x++) {
          const wx = x * cw + 3, wy = f * ch + 3, ww = cw - 6, wh = ch - 6;
          // 窓の形: window.png のスタンプ（あれば）をビル・窓ごとに選ぶ
          const stamp = stamps ? stamps[Math.floor(rng() * stamps.length)] : null;
          if (rng() > bias) {
            // 消灯窓もガラスの照り返しでうっすら見える
            const dim = 'rgba(50,70,120,0.13)';
            if (stamp) ctx.drawImage(tintedStamp(stamp, dim), wx - 2, wy - 2, ww + 4, wh + 4);
            else { ctx.fillStyle = dim; ctx.fillRect(wx, wy, ww, wh); }
            continue;
          }
          let hue: number, sat: number, lum: number;
          if (rng() < warmRatio) {
            hue = 332 + rng() * 22; sat = 70 + rng() * 25; lum = 56 + rng() * 20; // 赤〜マゼンタの生活光
          } else {
            hue = 190 + rng() * 65; sat = 60 + rng() * 35; lum = 56 + rng() * 20; // シアン〜青紫のオフィス光
          }
          // 色物（ネオンテナント・テレビの光）: ピンク/シアン/紫
          if (rng() < 0.12) {
            hue = [315, 190, 275][Math.floor(rng() * 3)]; sat = 90; lum = 68;
          }
          // まれにとても明るい窓 → ブルームが拾って滲む（色は残す）
          const hot = rng() < 0.06;
          if (hot) { lum = 80 + rng() * 8; sat = Math.max(sat, 70); }
          const fill = `hsla(${hue}, ${sat}%, ${lum}%, ${hot ? 1 : 0.55 + rng() * 0.45})`;
          if (stamp) {
            // スタンプは窓枠・カーテンごと描かれているので追加ディテールは不要
            ctx.drawImage(tintedStamp(stamp, fill), wx - 2, wy - 2, ww + 4, wh + 4);
          } else {
            ctx.fillStyle = fill;
            ctx.fillRect(wx, wy, ww, wh);
            // 窓の桟（十字）で解像感を出す
            ctx.fillStyle = 'rgba(3,3,9,0.5)';
            ctx.fillRect(wx + ww / 2 - 1, wy, 1, wh);
            if (rng() < 0.5) ctx.fillRect(wx, wy + wh / 2 - 1, ww, 1);
            // カーテン・部屋の奥行きの明暗
            if (rng() < 0.35) {
              ctx.fillStyle = 'rgba(0,0,0,0.45)';
              const half = rng() < 0.5;
              ctx.fillRect(wx, wy + (half ? wh / 2 : 0), ww, wh / 2);
            }
            // レジデンスはベランダの手すり影
            if (style === 'residential' && rng() < 0.5) {
              ctx.fillStyle = 'rgba(0,0,0,0.55)';
              ctx.fillRect(wx - 2, wy + wh - 3, ww + 4, 3);
            }
          }
        }
      }
      // 床スラブの暗線と縦マリオンで構造感を出す
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (let f = 0; f <= floors; f++) ctx.fillRect(0, f * ch - 1, c.width, 2);
      ctx.fillStyle = 'rgba(10,16,38,0.75)';
      for (let x = 0; x <= cols; x++) ctx.fillRect(x * cw - 1, 0, 2, c.height);
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

    // ビート時刻（窓・看板の明滅で共用）: 拍頭で1 → 拍内で二乗減衰
    const beat = t * p.bpm / 60;
    const beatIdx = Math.floor(beat);
    const beatFrac = beat - beatIdx;
    const beatEnv = (1 - beatFrac) * (1 - beatFrac);

    // ルック系パラメータの反映（毎フレーム代入するだけなので安い）
    this.renderer.toneMappingExposure = p.exposure;
    this.bloom.strength = p.bloomStrength;
    this.bloom.radius = p.bloomRadius;
    this.bloom.threshold = p.bloomThreshold;
    (this.scene.fog as THREE.FogExp2).density = p.fogDensity;
    // 濡れアスファルト反射: Reflectionフェーダー = 全体の濡れ具合
    this.groundUniforms.uWet.value = Math.min(1, p.reflection * 2.5);
    this.groundUniforms.uFogDensity.value = p.fogDensity;
    this.backdropMat.opacity = p.backdropGlow;
    this.grade.uniforms.uSaturation.value = p.grdSaturation;
    this.grade.uniforms.uContrast.value = p.grdContrast;
    this.grade.uniforms.uTint.value = p.grdTint;
    this.grade.uniforms.uVignette.value = p.grdVignette;
    this.outlineMat.opacity = p.outlineStrength;
    this.outlineMat.visible = p.outlineStrength > 0.005;
    // 窓のビート明滅: 拍ごとにランダムなビル面が選ばれ、明るく瞬く面と沈む面が散らばる。
    // どの面が選ばれるかは拍番号から決定論的（書き出しでも同じ）。Win Flicker が振幅。
    const wAmp = p.windowBeat;
    for (let i = 0; i < this.facadeMats.length; i++) {
      const pick = hash01(i * 3.71 + beatIdx * 47.9);
      let gain = 1;
      if (pick < 0.18) gain = 1 + 1.2 * wAmp * beatEnv; // 瞬く面
      else if (pick > 0.9) gain = 1 - 0.55 * wAmp * beatEnv; // 沈む面
      this.facadeMats[i].emissiveIntensity = p.windowGlow * gain;
    }
    if (this.camera.fov !== p.fov) {
      this.camera.fov = p.fov;
      this.camera.updateProjectionMatrix();
    }

    // カメラ: デフォルトは広場に静止（Speed 0）。上げると奥へドリーする。
    // 揺れも含めてカメラ時間 camT = t * speed で動かす → Speed 0 で完全静止
    const camT = t * p.camSpeed;
    const z = CAMERA_BASE_Z - (camT % (CITY_LENGTH - 60));
    const swayX = Math.sin(camT * 0.11) * p.camSway;
    this.camera.position.set(swayX, p.camHeight + Math.sin(camT * 0.175) * 0.4, z);
    this.camera.lookAt(swayX * 0.3, p.camHeight + 1.4, z - 40);

    // 遠景はカメラに追従（無限遠のフェイク）。下端を地平線(y=0)に合わせる
    this.backdrop.position.set(0, 75, z - 160);

    // 表示トグル（paramsに載せているので書き出し時のWorkerシーンにも反映される）
    this.floorMesh.visible = p.floorVisible;
    this.signGroup.visible = p.signsVisible;

    // ステージの奥行き（手前端 z=28 を固定して奥へ伸縮）
    this.floorMesh.scale.y = p.stageDepth / 16;
    this.floorMesh.position.z = 28 - p.stageDepth / 2;

    // ダンスフロアのパルス
    this.drawFloor(t);

    // 看板: 基本は点灯したまま、拍ごとに一部だけがフラッシュ（+ 従来のフリッカー）
    const bd = p.beatDepth;
    for (let i = 0; i < this.signs.length; i++) {
      const sign = this.signs[i];
      const chosen = hash01(i * 7.77 + beatIdx * 31.3) < 0.2;
      let level = 0.82 + (chosen ? 0.18 * bd * beatEnv : 0);
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
