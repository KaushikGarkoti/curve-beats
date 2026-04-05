/**
 * SCENE SYSTEM
 * ------------
 * Sets up the Three.js scene, renderer, camera, lights, and all geometry factories.
 *
 * Visual language (matches reference image):
 *   - Teal vertical gradient wall at Z = 0 (dark bottom → cyan top)
 *   - Colorful rectangular platform pads with L-bracket wall struts
 *   - Multi-rail track at the bottom for the roll section
 *   - Warm directional light casting platform shadows onto the wall
 *   - Ball with emissive point light (optional GLB mesh)
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { TexturePass } from 'three/examples/jsm/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { pitchToNeonRailEmissive } from './midi/pitchColor.js';
import { SustainArcCurve3, isValidSustainArcData } from './sustainArc.js';
import { applyPadBaseEmissive } from './platforms.js';
import { params } from './params.js';
import { applyWallTextureUvRepeat, buildWallPlaneGeometry, fillWallGradientTexture } from './wallTextures.js';
import { ensurePadGeometryUv2, publicTextureUrl } from './platformTextures.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// Scene / Renderer / Camera
// ---------------------------------------------------------------------------

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(params.scene.backgroundColor);
  return scene;
}

export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  /** Tone mapping applied in post (OutputPass); keep linear HDR in the main render targets. */
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  container.appendChild(renderer.domElement);
  return renderer;
}

/** Layer mask: platform pads only — isolated for bloom; rest of scene is layer 0. */
export const BLOOM_LAYER = 1;

const _blackBloomBg = new THREE.Color(0x000000);

const CompositeAddShader = {
  uniforms: {
    tBase:  { value: null },
    tBloom: { value: null },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tBase;
    uniform sampler2D tBloom;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tBase, vUv);
      vec4 bloom = texture2D(tBloom, vUv);
      gl_FragColor = vec4(base.rgb + bloom.rgb, 1.0);
    }
  `,
};

/**
 * Selective bloom: only `BLOOM_LAYER` meshes (platform pads) get UnrealBloom;
 * the rest of the scene is rendered without bloom, then composited additively.
 */
export function createSelectiveBloomPipeline(renderer) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = Math.min(window.devicePixelRatio, 2);
  const s = params.scene;

  const rtOpt = {
    type:              THREE.HalfFloatType,
    minFilter:         THREE.LinearFilter,
    magFilter:         THREE.LinearFilter,
    depthBuffer:       true,
    stencilBuffer:     false,
  };

  const baseRT = new THREE.WebGLRenderTarget(w * pr, h * pr, rtOpt);
  const bloomSceneRT = new THREE.WebGLRenderTarget(w * pr, h * pr, rtOpt);

  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  const texturePass = new TexturePass(bloomSceneRT.texture);
  /** Default TexturePass leaves readBuffer stale; bloom must read the pad-only render. */
  texturePass.needsSwap = true;
  bloomComposer.addPass(texturePass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    s.bloomStrength,
    s.bloomRadius,
    s.bloomThreshold,
  );
  bloomComposer.addPass(bloomPass);

  const compositePass = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CompositeAddShader.uniforms),
      vertexShader: CompositeAddShader.vertexShader,
      fragmentShader: CompositeAddShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    }),
  );

  const finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(compositePass);
  finalComposer.addPass(new OutputPass());

  bloomComposer.setPixelRatio(pr);
  bloomComposer.setSize(w, h);
  finalComposer.setPixelRatio(pr);
  finalComposer.setSize(w, h);

  return {
    baseRT,
    bloomSceneRT,
    bloomComposer,
    bloomPass,
    finalComposer,
    compositePass,
  };
}

/**
 * @param {ReturnType<typeof createSelectiveBloomPipeline>} pipeline
 */
export function resizeSelectiveBloomPipeline(pipeline, width, height) {
  const pr = Math.min(window.devicePixelRatio, 2);
  const dw = Math.floor(width * pr);
  const dh = Math.floor(height * pr);
  pipeline.baseRT.setSize(dw, dh);
  pipeline.bloomSceneRT.setSize(dw, dh);
  pipeline.bloomComposer.setSize(width, height);
  pipeline.bloomComposer.setPixelRatio(pr);
  pipeline.finalComposer.setSize(width, height);
  pipeline.finalComposer.setPixelRatio(pr);
}

/**
 * @param {ReturnType<typeof createSelectiveBloomPipeline>} pipeline
 */
export function renderSelectiveBloom(renderer, scene, camera, pipeline) {
  const { baseRT, bloomSceneRT, bloomComposer, finalComposer, compositePass } = pipeline;

  camera.layers.set(0);
  renderer.setRenderTarget(baseRT);
  renderer.clear();
  renderer.render(scene, camera);

  const prevBg = scene.background;
  scene.background = _blackBloomBg;
  camera.layers.set(1);
  renderer.setRenderTarget(bloomSceneRT);
  renderer.clear();
  renderer.render(scene, camera);

  scene.background = prevBg;
  camera.layers.enable(0);
  camera.layers.enable(1);

  bloomComposer.render();

  compositePass.uniforms.tBase.value = baseRT.texture;
  compositePass.uniforms.tBloom.value = bloomComposer.readBuffer.texture;

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setRenderTarget(null);
  finalComposer.render();
  renderer.toneMapping = THREE.NoToneMapping;
}

export function createCamera() {
  const camera = new THREE.PerspectiveCamera(
    params.scene.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    300
  );
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  return camera;
}

// ---------------------------------------------------------------------------
// Lighting  (warm, sun-like — platforms cast shadows onto wall)
// ---------------------------------------------------------------------------

/**
 * Returns the directional light so main.js can move it with the ball each frame.
 */
export function createLights(scene) {
  const sc = params.scene;
  const ambient = new THREE.AmbientLight(0xfff4e0, sc.ambientIntensity);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffe8b0, sc.keyIntensity);
  key.position.set(6, 12, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // Shadow frustum covers a vertical slice; we'll move the light with ball in main.js
  key.shadow.camera.left   = -28;
  key.shadow.camera.right  =  28;
  key.shadow.camera.top    =  18;
  key.shadow.camera.bottom = -18;
  key.shadow.camera.near   =  2;
  key.shadow.camera.far    = 56;
  key.shadow.bias = -0.001;
  scene.add(key);
  scene.add(key.target); // target must be in scene for updates to work

  // Cool soft fill from left
  const fill = new THREE.DirectionalLight(0xd0e8ff, 0.25);
  fill.position.set(-5, 4, 6);
  scene.add(fill);

  return { key, ambient, fill };
}

// ---------------------------------------------------------------------------
// Wall  (the vertical Z=0 plane — the entire backdrop)
// ---------------------------------------------------------------------------

/**
 * Replace wall mesh geometry + position from `params.scene` (after GUI edits).
 * @param {THREE.Mesh} wallMesh
 */
export function applyWallDimensions(wallMesh) {
  const sc = params.scene;
  const old = wallMesh.geometry;
  wallMesh.geometry = buildWallPlaneGeometry(sc);
  old.dispose();
  wallMesh.position.set(0, sc.wallCenterY, 0);
  applyWallTextureUvRepeat(wallMesh);
}

/**
 * Clamp ball center so the sphere stays inside the wall rectangle (XY) and slightly in front of Z=0.
 * @param {THREE.Vector3} pos
 * @param {number} radius
 */
export function clampBallPositionToWall(pos, radius) {
  const sc = params.scene;
  const m = Math.max(0.001, radius);
  const xMin = -sc.wallHalfWidth + m;
  const xMax = sc.wallHalfWidth - m;
  const yMin = sc.wallCenterY - sc.wallHalfHeight + m;
  const yMax = sc.wallCenterY + sc.wallHalfHeight - m;
  pos.x = Math.min(xMax, Math.max(xMin, pos.x));
  pos.y = Math.min(yMax, Math.max(yMin, pos.y));
  const zMin = 0.08;
  const zMax = 2.0;
  pos.z = Math.min(zMax, Math.max(zMin, pos.z));
  return pos;
}

/**
 * Rebuild wall color map from `params.scene` (e.g. after GUI color tweaks). No-op when using PBR file maps.
 * @param {THREE.Mesh} wallMesh
 */
export function refreshWallGradient(wallMesh) {
  if (!wallMesh.userData.wallUsesGradient) return;
  const mat = wallMesh.material;
  if (mat.map?.isCanvasTexture) fillWallGradientTexture(mat.map);
}

/**
 * Large vertical plane at Z = 0 with a teal gradient (bottom → top).
 * Receives shadows from platforms (grounding effect).
 * @param {THREE.Scene} scene
 */
export function createWall(scene) {
  const sc = params.scene;
  const geo = buildWallPlaneGeometry(sc);

  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const mapTex = new THREE.CanvasTexture(canvas);
  mapTex.colorSpace = THREE.SRGBColorSpace;
  mapTex.minFilter = THREE.LinearFilter;
  mapTex.magFilter = THREE.LinearFilter;
  fillWallGradientTexture(mapTex);

  const mat = new THREE.MeshStandardMaterial({
    color:     0xffffff,
    map:       mapTex,
    roughness: 0.92,
    metalness: 0.0,
  });
  const plane = new THREE.Mesh(geo, mat);
  plane.userData.wallUsesGradient = true;
  plane.position.set(0, sc.wallCenterY, 0);
  plane.receiveShadow = true;
  scene.add(plane);
  return plane;
}

/**
 * Fog so depth reads against the gradient wall.
 *
 * @param {THREE.Scene} scene
 */
export function createWallBackground(scene) {
  const sc = params.scene;

  if (sc.fogFar > sc.fogNear) {
    scene.fog = new THREE.Fog(
      new THREE.Color(sc.backgroundColor),
      sc.fogNear,
      sc.fogFar,
    );
  }
}

// ---------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------

/** GLB in `public/modals/` — swap filename if you add another asset. */
const BALL_GLB_REL_PATH = 'modals/sample_2026-04-05T170210.021.glb';

const _gltfLoader = new GLTFLoader();

/** @type {Promise<import('three').Group | import('three').Object3D> | null} */
let ballGlbTemplatePromise = null;

/**
 * Loads the ball GLB once; clones are used per ball instance.
 * @returns {Promise<import('three').Object3D>}
 */
export function loadBallGlbTemplateOnce() {
  if (!ballGlbTemplatePromise) {
    const url = publicTextureUrl(BALL_GLB_REL_PATH);
    ballGlbTemplatePromise = _gltfLoader.loadAsync(url).then(gltf => gltf.scene);
  }
  return ballGlbTemplatePromise;
}

function disposeMeshHierarchy(obj) {
  obj.traverse(o => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach(mat => mat?.dispose?.());
      else m?.dispose?.();
    }
  });
}

/**
 * Uniform scale + center so the model fits `params.main.ballRadius` (world units).
 * @param {import('three').Object3D} object
 */
function fitBallModelToRadius(object) {
  const r = params.main.ballRadius;
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = (2 * r) / maxDim;
  object.scale.setScalar(s);
  object.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(object);
  const c = new THREE.Vector3();
  box2.getCenter(c);
  object.position.sub(c);
}

/**
 * @param {import('three').Group} bodyGroup  Holds either placeholder sphere or GLB clone
 * @param {import('three').Object3D} templateScene  Loaded gltf.scene (cloned inside)
 */
function replaceBodyWithGlbClone(bodyGroup, templateScene) {
  while (bodyGroup.children.length) {
    const o = bodyGroup.children[0];
    bodyGroup.remove(o);
    disposeMeshHierarchy(o);
  }
  const model = templateScene.clone(true);
  fitBallModelToRadius(model);
  model.traverse(o => {
    if (o.isMesh) o.castShadow = true;
  });
  bodyGroup.add(model);
}

/**
 * Ball hierarchy (stable indices for main.js):
 *   children[0] — point light
 *   children[1] — body `Group` (placeholder sphere → GLB when loaded)
 *   children[2..4] — roll dots
 *
 * @param {import('three').Scene} scene
 * @param {number} [tintColor=0xffffff]  Hex color used for the ball body, glow, and point light.
 */
export function createBall(scene, tintColor = 0xffffff) {
  const tint = new THREE.Color(tintColor);

  // Emissive: same hue as tint but shifted toward blue for a glow feel
  const emissive = tint.clone().multiplyScalar(0.55).lerp(new THREE.Color(0x99bbff), 0.45);

  const root = new THREE.Group();
  root.name = 'ball';

  const light = new THREE.PointLight(tint, 1.8, 5.5);
  root.add(light);

  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'ballBody';
  const geo = new THREE.SphereGeometry(params.main.ballRadius, 32, 32);
  const mat = new THREE.MeshStandardMaterial({
    color:             tint,
    emissive:          emissive,
    emissiveIntensity: 0.7,
    roughness:         0.15,
    metalness:         0.05,
  });
  const sphere = new THREE.Mesh(geo, mat);
  sphere.castShadow = true;
  bodyGroup.add(sphere);
  root.add(bodyGroup);

  const dotColor = tint.clone().multiplyScalar(0.35);
  const dotMat = new THREE.MeshBasicMaterial({ color: dotColor });
  const DOT_OFFSETS = [
    [ 0.26,  0.00,  0.14],
    [-0.13,  0.22,  0.14],
    [-0.13, -0.22,  0.14],
  ];
  for (const [dx, dy, dz] of DOT_OFFSETS) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.042, 7, 7), dotMat);
    dot.position.set(dx, dy, dz);
    root.add(dot);
  }

  scene.add(root);

  void loadBallGlbTemplateOnce()
    .then(templateScene => {
      replaceBodyWithGlbClone(bodyGroup, templateScene);
      setBallPitchTint(root, tintColor);
    })
    .catch(err => {
      console.warn('Ball GLB not used (keeping sphere):', err?.message ?? err);
    });

  return root;
}

function applyTintToBallBodyMeshes(bodyGroup, tint, emissive) {
  bodyGroup.traverse(child => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      if ('color' in m && m.color) m.color.copy(tint);
      if ('emissive' in m && m.emissive) {
        m.emissive.copy(emissive);
        if ('emissiveIntensity' in m) m.emissiveIntensity = 0.7;
      }
    }
  });
}

/**
 * Updates ball body meshes, point light, and roll dots to match a note color.
 * @param {import('three').Group} root  Return value of createBall
 * @param {number} hexColor  THREE hex (same as pitchToPlatformColor)
 */
export function setBallPitchTint(root, hexColor) {
  const tint = new THREE.Color(hexColor);
  const emissive = tint.clone().multiplyScalar(0.55).lerp(new THREE.Color(0x99bbff), 0.45);

  const bodyGroup = root.children[1];
  if (bodyGroup && bodyGroup.isGroup) {
    applyTintToBallBodyMeshes(bodyGroup, tint, emissive);
  }

  const pl = root.children[0];
  if (pl && 'color' in pl) pl.color.copy(tint);
  const dotCol = tint.clone().multiplyScalar(0.35);
  for (let i = 2; i <= 4; i++) {
    const dot = root.children[i];
    if (dot?.material?.color) dot.material.color.copy(dotCol);
  }
}

// ---------------------------------------------------------------------------
// Platform pool  (colorful pads + L-bracket wall struts)
// ---------------------------------------------------------------------------

const PLATFORM_COLORS = [
  0x4ddc5a,  // bright green
  0xf5c200,  // yellow
  0xff5fa0,  // hot pink / magenta
  0x4dc8e8,  // cyan/teal
  0xff8c2a,  // orange
  0xcc5de8,  // purple
  0x20c997,  // mint
  0xff6b6b,  // coral red
];

const STRUT_MAT = new THREE.MeshStandardMaterial({
  color: 0x8a8a8a, roughness: 0.75, metalness: 0.55,
});

/**
 * Build one strut (L-bracket) in local group space.
 * The bracket has a horizontal arm (going into the wall in -Z) and a
 * short vertical leg (going down -Y at the wall end).
 *
 * @param {number} sx  X side offset (e.g. ±0.72)
 * @returns {THREE.Group}
 */
/**
 * BALL_Z ≈ 0.55 (platform group is placed at that Z in world space).
 * The arm must span from under the pad edge (local Z ≈ 0) all the way back to
 * world Z = 0 (the wall), i.e. local Z ≈ −0.55.  Previous struts were ~0.45
 * long and didn't reach — they visually floated in mid-air.
 */
const ARM_Z_CENTER  = -0.28;  // local Z mid-point of the horizontal arm
const ARM_Z_LEN     = 0.62;   // reaches from local Z 0.03 to local Z −0.59
const WALL_LOCAL_Z  = -0.57;  // approx local Z of the wall face

function makeStrut(sx) {
  const g = new THREE.Group();

  // Horizontal arm: bridges pad underside → wall
  const armGeo = new THREE.BoxGeometry(0.09, 0.09, ARM_Z_LEN);
  const arm = new THREE.Mesh(armGeo, STRUT_MAT);
  arm.position.set(sx, -0.175, ARM_Z_CENTER);
  arm.castShadow = true;
  g.add(arm);

  // Vertical leg at the wall end (drops down the wall face)
  const legGeo = new THREE.BoxGeometry(0.08, 0.40, 0.08);
  const leg = new THREE.Mesh(legGeo, STRUT_MAT);
  leg.position.set(sx, -0.375, WALL_LOCAL_Z);
  leg.castShadow = true;
  g.add(leg);

  // Flush anchor plate against the wall surface
  const plateGeo = new THREE.BoxGeometry(0.15, 0.28, 0.05);
  const plate = new THREE.Mesh(plateGeo, STRUT_MAT);
  plate.position.set(sx, -0.36, WALL_LOCAL_Z - 0.03);
  plate.castShadow = true;
  g.add(plate);

  return g;
}

/**
 * Pre-allocate a pool of platform Groups.
 * Each Group contains: platform pad + 2 L-bracket struts.
 * Groups are hidden by default and activated per event.
 *
 * @param {THREE.Scene} scene
 * @param {number} poolSize
 * @returns {THREE.Group[]}
 */
export function createPlatformPool(scene, poolSize = 60) {
  const pool = [];

  for (let i = 0; i < poolSize; i++) {
    const color = PLATFORM_COLORS[i % PLATFORM_COLORS.length];
    const group = new THREE.Group();

    // Platform pad — subdivided for displacement; uv2 for aoMap
    const padGeo = new THREE.BoxGeometry(2.0, 0.30, 0.70, 32, 8, 12);
    ensurePadGeometryUv2(padGeo);
    const padMat = new THREE.MeshStandardMaterial({
      color,
      emissive:       0x000000,
      emissiveIntensity: 1,
      roughness: 0.32,
      metalness: 0.08,
    });
    applyPadBaseEmissive(padMat);
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.castShadow = true;
    pad.receiveShadow = true;
    /**
     * Default layer 0 + `BLOOM_LAYER`: pads must draw in the **base** pass (sharp albedo / textures).
     * `layers.set(BLOOM_LAYER)` alone removed layer 0, so pads only existed in the bloom RT — UnrealBloom
     * blurred them and hid surface detail. Bloom pass still uses camera layer 1 only (wall/struts stay off).
     */
    pad.layers.enable(BLOOM_LAYER);
    group.add(pad);

    // Two struts (left and right)
    group.add(makeStrut(-0.72));
    group.add(makeStrut(+0.72));

    group.visible = false;
    group.userData = { eventIndex: -1, scaleAnim: null };
    scene.add(group);
    pool.push(group);
  }

  return pool;
}

// ---------------------------------------------------------------------------
// Rail track  (multi-rail structure the ball rolls onto)
// ---------------------------------------------------------------------------

const RAIL_MAT = new THREE.MeshStandardMaterial({
  color: 0xaaaaaa, roughness: 0.45, metalness: 0.80,
});
const TIE_MAT = new THREE.MeshStandardMaterial({
  color: 0x888888, roughness: 0.80, metalness: 0.40,
});

/**
 * Build the two-rail track structure and anchor it to the wall at (cx, y, z≈0).
 *
 * The track runs in the X direction (horizontal along wall).
 * Two rails are offset in Z (one closer to wall, one protruding more)
 * so from the front they appear as two parallel horizontal lines.
 *
 * @param {THREE.Scene} scene
 * @param {number} cx   center X of the track
 * @param {number} y    vertical Y position on the wall
 * @returns {THREE.Group}
 */
export function createTrack(scene, cx, y) {
  const group = new THREE.Group();
  group.position.set(cx, y, 0);

  const LENGTH = 28;   // horizontal extent along wall for roll track
  const Z1     = 0.10; // inner rail Z (closer to wall)
  const Z2     = 0.30; // outer rail Z (protrudes more)

  // Two rails running in X
  for (const z of [Z1, Z2]) {
    const railGeo = new THREE.BoxGeometry(LENGTH, 0.055, 0.065);
    const rail = new THREE.Mesh(railGeo, RAIL_MAT);
    rail.position.set(0, 0, z);
    rail.castShadow = true;
    group.add(rail);
  }

  // Vertical support posts at regular X intervals
  const POST_XS = [-11, -6, -1, 4, 9];
  for (const px of POST_XS) {
    // Vertical post
    const postGeo = new THREE.BoxGeometry(0.065, 0.55, 0.065);
    const post = new THREE.Mesh(postGeo, TIE_MAT);
    post.position.set(px, -0.28, Z1);
    post.castShadow = true;
    group.add(post);

    // Cross tie connecting both rails
    const tieGeo = new THREE.BoxGeometry(0.065, 0.065, Z2 - Z1 + 0.05);
    const tie = new THREE.Mesh(tieGeo, TIE_MAT);
    tie.position.set(px, 0, (Z1 + Z2) / 2);
    tie.castShadow = true;
    group.add(tie);
  }

  scene.add(group);
  return group;
}

const _tubeUp = new THREE.Vector3(0, 1, 0);
const _quatTubeX180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

/** @param {THREE.Vector3} v */
function vec3Finite(v) {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * CylinderGeometry is Y-aligned; map local +Y to chord `dir`. Handles parallel / opposite without NaN quaternions.
 * @param {THREE.Mesh} mesh
 * @param {THREE.Vector3} dir unit chord direction
 */
function setCylinderMeshAlongChord(mesh, dir) {
  const dot = _tubeUp.dot(dir);
  if (dot > 1 - 1e-6) {
    mesh.quaternion.identity();
    return;
  }
  if (dot < -1 + 1e-6) {
    mesh.quaternion.copy(_quatTubeX180);
    return;
  }
  mesh.quaternion.setFromUnitVectors(_tubeUp, dir);
}

/**
 * Sustained notes: a floating arc tube with symmetric gaps at both ends.
 *
 * The tube starts GAP_WORLD units into the arc (after the platform) and ends
 * GAP_WORLD units before the arc finishes (before the next platform).  Both
 * gaps are clamped to MAX_GAP_FRAC of the arc so short arcs keep a visible tube.
 * The tube does not connect to either platform — it floats in the sustained space.
 *
 * Falls back to a trimmed chord cylinder when sustainArc data is absent.
 */
export function createSustainedRailsGroup(segments) {
  const GAP_WORLD    = 1.0;   // world-unit gap trimmed from each end of the arc
  const MAX_GAP_FRAC = 0.25;  // never trim more than 25 % from each end

  const group = new THREE.Group();
  for (const seg of segments) {
    if (seg.type !== 'SUSTAINED') continue;
    const start = seg.startPos;
    const end   = seg.endPos;
    if (!start || !end || typeof start.clone !== 'function' || typeof end.clone !== 'function') continue;

    const midi = seg.midi ?? 60;
    const emissive = pitchToNeonRailEmissive(midi);
    const mat = new THREE.MeshStandardMaterial({
      color:             0x0a1018,
      emissive,
      emissiveIntensity: 0.75,
      roughness:         0.22,
      metalness:         0.62,
      transparent:       true,
      opacity:           0.38,
      side:              THREE.DoubleSide,
      depthWrite:        false,
    });

    const tubeRadius = 0.48;
    const sa = seg.sustainArc;

    if (sa && isValidSustainArcData(sa)) {
      const raw = /** @type {{ center: import('three').Vector3 | { x: number, y: number, z: number }, radius: number, theta0: number, theta1: number, z: number, arcLength?: number }} */ (sa);
      let arcLength = raw.arcLength;
      if (arcLength == null || !Number.isFinite(arcLength)) {
        arcLength = raw.radius * Math.abs(raw.theta1 - raw.theta0);
      }

      if (arcLength > 1e-6) {
        const center = raw.center instanceof THREE.Vector3
          ? raw.center
          : new THREE.Vector3(raw.center.x, raw.center.y, raw.center.z);

        // Symmetric gap — same world-unit trim at entry and exit
        const gapFrac = Math.min(MAX_GAP_FRAC, GAP_WORLD / arcLength);
        const tStart  = gapFrac;
        const tEnd    = 1 - gapFrac;

        if (tEnd > tStart + 1e-4) {
          // Build a proper SustainArcCurve3 over the trimmed angle range so
          // TubeGeometry gets a real THREE.Curve with computeFrenetFrames.
          const dTheta   = raw.theta1 - raw.theta0;
          const subTheta0 = raw.theta0 + tStart * dTheta;
          const subTheta1 = raw.theta0 + tEnd   * dTheta;
          const subArc   = new SustainArcCurve3(center, raw.radius, subTheta0, subTheta1, raw.z);
          const visLen   = arcLength * (tEnd - tStart);
          const tubular  = Math.max(16, Math.min(160, Math.ceil(visLen * 4)));
          const geo      = new THREE.TubeGeometry(subArc, tubular, tubeRadius, 10, false);
          const mesh    = new THREE.Mesh(geo, mat);
          mesh.castShadow    = true;
          mesh.receiveShadow = true;
          group.add(mesh);
          continue;
        }
      }
    }

    // ── Fallback: trimmed chord cylinder (no arc data) ────────────────────────
    const dir = end.clone().sub(start);
    const len = dir.length();
    if (!Number.isFinite(len) || len < 1e-4) continue;
    dir.normalize();
    if (!vec3Finite(dir)) continue;

    const trimmedLen = len * (1 - 2 * MAX_GAP_FRAC);
    const geo  = new THREE.CylinderGeometry(tubeRadius, tubeRadius, trimmedLen, 22, 1, true);
    const mesh = new THREE.Mesh(geo, mat);
    setCylinderMeshAlongChord(mesh, dir);
    mesh.position.copy(start.clone().lerp(end, 0.5));
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Baked trajectory polylines (export / reference comparison)
// ---------------------------------------------------------------------------

const PATH_OVERLAY_MAX = 120_000;

/**
 * @param {import('three').Scene} scene
 * @param {number} color
 * @param {number} [opacity]
 */
export function createPathOverlayLine(scene, color, opacity = 0.5) {
  const positions = new Float32Array(PATH_OVERLAY_MAX * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setDrawRange(0, 0);

  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite:  false,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);
  return { line, positions, maxPoints: PATH_OVERLAY_MAX };
}

/**
 * @param {{ positions: Float32Array, line: import('three').Line, maxPoints: number }} overlay
 * @param {{ x: number, y: number, z: number }[]} points
 */
export function updatePathOverlayGeometry(overlay, points) {
  const n = Math.min(points.length, overlay.maxPoints);
  const pos = overlay.positions;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const x = p.x;
    const y = p.y;
    const z = p.z;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      pos[i * 3]     = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
    } else {
      pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0;
    }
  }
  overlay.line.geometry.attributes.position.needsUpdate = true;
  overlay.line.geometry.setDrawRange(0, n);
}

// ---------------------------------------------------------------------------
// Trail  (line following the ball's visual position)
// ---------------------------------------------------------------------------

const TRAIL_LENGTH = 60;

/**
 * @param {import('three').Scene} scene
 * @param {number} [tintColor=0x88aeff]  Trail base color; fades from dark to full tint along the tail.
 */
export function createTrail(scene, tintColor = 0x88aeff) {
  const positions = new Float32Array(TRAIL_LENGTH * 3);
  const colors    = new Float32Array(TRAIL_LENGTH * 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent:  true,
    opacity:      params.fx.trailOpacity,
    depthWrite:   false,
  });

  const line = new THREE.Line(geo, mat);
  scene.add(line);
  const tint = new THREE.Color(tintColor);
  return { line, positions, colors, tint };
}

// ---------------------------------------------------------------------------
// Particle burst pool
// ---------------------------------------------------------------------------

const PARTICLES_PER_BURST = 22;
const MAX_BURSTS           = 20;

export function createParticleSystem(scene) {
  const bursts = [];

  for (let b = 0; b < MAX_BURSTS; b++) {
    const positions  = new Float32Array(PARTICLES_PER_BURST * 3);
    const velocities = Array.from({ length: PARTICLES_PER_BURST }, () => new THREE.Vector3());

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color:          0xffffff,
      size:           params.fx.particleSize,
      transparent:    true,
      opacity:        0,
      depthWrite:     false,
      sizeAttenuation:true,
    });

    const points = new THREE.Points(geo, mat);
    scene.add(points);

    bursts.push({
      points, positions, velocities,
      active: false, birthTime: 0, lifetime: 0.7,
      origin: new THREE.Vector3(),
    });
  }

  return bursts;
}

export function triggerBurst(bursts, position, color, now) {
  let burst = bursts.find(b => !b.active) ?? bursts[0];

  burst.active    = true;
  burst.birthTime = now;
  burst.origin.copy(position);
  burst.points.material.color.set(color);
  burst.points.material.opacity = 1;

  const pos = burst.positions;
  for (let p = 0; p < PARTICLES_PER_BURST; p++) {
    pos[p * 3]     = position.x;
    pos[p * 3 + 1] = position.y;
    pos[p * 3 + 2] = position.z;

    const fx = params.fx;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.random() * Math.PI * 0.55;
    burst.velocities[p].set(
      Math.sin(phi) * Math.cos(theta) * fx.burstScatterXY,
      Math.cos(phi) * fx.burstScatterY + 0.8,
      Math.sin(phi) * Math.sin(theta) * fx.burstScatterZ
    );
  }

  burst.points.geometry.attributes.position.needsUpdate = true;
}

export function updateParticles(bursts, now, dt) {
  for (const burst of bursts) {
    if (!burst.active) continue;

    const age = now - burst.birthTime;
    if (age > burst.lifetime) {
      burst.active = false;
      burst.points.material.opacity = 0;
      continue;
    }

    const life = 1 - age / burst.lifetime;
    burst.points.material.opacity = life * 0.85;

    const pos = burst.positions;
    for (let p = 0; p < PARTICLES_PER_BURST; p++) {
      const v = burst.velocities[p];
      pos[p * 3]     += v.x * dt;
      pos[p * 3 + 1] += v.y * dt;
      pos[p * 3 + 2] += v.z * dt;
      v.multiplyScalar(params.fx.particleDamping);
    }
    burst.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Ripple rings
// ---------------------------------------------------------------------------

const RIPPLE_POOL_SIZE = 20;
// Shared geometry: thin ring ~mean radius 0.5 world units, scaled per-frame by rippleMaxRadius.
const _rippleGeo = new THREE.RingGeometry(0.41, 0.59, 48);

/**
 * Creates a pool of reusable ripple ring meshes and adds them to the scene.
 * @param {import('three').Scene} scene
 */
export function createRipplePool(scene) {
  const pool = [];
  for (let i = 0; i < RIPPLE_POOL_SIZE; i++) {
    const mat  = new THREE.MeshBasicMaterial({
      color:       0xffffff,
      transparent: true,
      opacity:     0,
      side:        THREE.DoubleSide,
      depthWrite:  false,
    });
    const mesh = new THREE.Mesh(_rippleGeo, mat);
    mesh.visible      = false;
    mesh.userData     = { active: false, birthTime: 0 };
    mesh.layers.enable(1); // bloom layer
    scene.add(mesh);
    pool.push(mesh);
  }
  return pool;
}

/**
 * Fire a ripple ring at `position`.
 * @param {Array<import('three').Mesh>} pool
 * @param {import('three').Vector3} position
 * @param {number | string} color
 * @param {number} now
 */
export function triggerRipple(pool, position, color, now) {
  const ring = pool.find(r => !r.userData.active) ?? pool[0];
  ring.userData.active    = true;
  ring.userData.birthTime = now;
  ring.position.set(position.x, position.y, 0.25); // flat against wall
  ring.scale.setScalar(0.05);
  ring.material.color.set(color);
  ring.material.opacity = 1;
  ring.visible = true;
}

/**
 * Advance all active ripple rings each frame.
 * @param {Array<import('three').Mesh>} pool
 * @param {number} now
 */
export function updateRipples(pool, now) {
  const fx = params.fx;
  for (const ring of pool) {
    if (!ring.userData.active) continue;
    const age = now - ring.userData.birthTime;
    const dur = fx.rippleDuration;
    if (age >= dur) {
      ring.userData.active  = false;
      ring.visible          = false;
      ring.material.opacity = 0;
      continue;
    }
    const p = age / dur;
    // Ease-out expansion: fast at start, slows as it reaches max radius
    ring.scale.setScalar(fx.rippleMaxRadius * (1 - Math.pow(1 - p, 2.2)));
    // Fade opacity — stay bright briefly then dim
    ring.material.opacity = Math.pow(1 - p, 0.7) * 0.9;
  }
}
