/**
 * Wall backdrop: PBR maps from `public/textures/wall/` (served as `/textures/wall/...`).
 * Place files with these names, or symlink your pack. Optional maps may be omitted (404 → ignored).
 * If the base color map fails to load, the teal canvas gradient is kept.
 */

import * as THREE from 'three';
import { params } from './params.js';
import { EXRLoader } from 'three/examples/jsm/Addons.js';

const loader = new THREE.TextureLoader();
const exrLoader = new EXRLoader();

/** @public — adjust paths/names here to match your files */
export const WALL_TEXTURE_MAPS = {
  color:        '/textures/wall/wood_table_001_diff_4k.jpg',
  normal:       '/textures/wall/wood_table_001_nor_gl_4k.exr',
  roughness:    '/textures/wall/wood_table_001_rough_4k.png',
  displacement: '/textures/wall/wood_table_001_disp_4k.png',
  ao:           '/textures/wall/AO.jpg',
  metalness:    '/textures/wall/Metalness.jpg',
};

/**
 * Target world size (width × height) of one texture repeat on the wall.
 * Repeat is derived from `wallHalfWidth` / `wallHalfHeight` so tall walls keep ~square tiles (no vertical stretch).
 */
const WALL_TEX_TILE_WORLD = 200;

const WALL_DISPLACEMENT_SCALE = 0.25;
const WALL_DISPLACEMENT_BIAS = 0;
const WALL_PLANE_SEGMENTS = 96;

/**
 * @param {THREE.CanvasTexture} tex
 */
export function fillWallGradientTexture(tex) {
  const sc = params.scene;
  const canvas = tex.image;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const h = canvas.height;
  const grd = ctx.createLinearGradient(0, h, 0, 0);
  grd.addColorStop(0, sc.wallGradientBottom);
  grd.addColorStop(1, sc.wallGradientTop);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  tex.needsUpdate = true;
}

export function getWallPlaneSegmentCount() {
  if (WALL_TEXTURE_MAPS.displacement?.trim()) {
    return Math.max(4, Math.min(512, WALL_PLANE_SEGMENTS));
  }
  return 1;
}

/**
 * UV repeat so each tile covers ~`WALL_TEX_TILE_WORLD` units in both X and Y on the wall plane
 * (matches plane aspect ratio: rx/ry = width/height).
 * @param {object} [sceneParams] `params.scene`
 */
export function getWallUvRepeat(sceneParams) {
  const p = sceneParams ?? params.scene;
  const W = p.wallHalfWidth * 2;
  const H = p.wallHalfHeight * 2;
  const tile = WALL_TEX_TILE_WORLD;
  return {
    x: Math.max(0.25, W / tile),
    y: Math.max(0.25, H / tile),
  };
}

/**
 * Call after wall size changes (e.g. GUI) so PBR maps stay correctly tiled.
 * @param {THREE.Mesh} wallMesh
 */
export function applyWallTextureUvRepeat(wallMesh) {
  if (wallMesh.userData.wallUsesGradient) return;
  const mat = wallMesh.material;
  if (!mat?.isMeshStandardMaterial) return;
  const { x, y } = getWallUvRepeat();
  for (const tex of [
    mat.map,
    mat.normalMap,
    mat.roughnessMap,
    mat.metalnessMap,
    mat.aoMap,
    mat.displacementMap,
  ]) {
    if (tex?.repeat) tex.repeat.set(x, y);
  }
}

/** @param {object} [sc] params.scene */
export function buildWallPlaneGeometry(sc) {
  const p = sc ?? params.scene;
  const hw = p.wallHalfWidth;
  const hh = p.wallHalfHeight;
  const segs = getWallPlaneSegmentCount();
  const geo = new THREE.PlaneGeometry(hw * 2, hh * 2, segs, segs);
  ensureUv2ForAo(geo);
  return geo;
}

function ensureUv2ForAo(geometry) {
  const uv = geometry.attributes.uv;
  if (!uv || geometry.attributes.uv2) return;
  geometry.setAttribute('uv2', new THREE.BufferAttribute(uv.array.slice(), uv.itemSize));
}

function configureRepeat(tex, rx, ry) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx, ry);
}

/**
 * @param {string | null | undefined} url
 * @returns {Promise<THREE.Texture | null>}
 */
function loadTextureOptional(url) {
  if (!url?.trim()) return Promise.resolve(null);
  return new Promise(resolve => {
    loader.load(url, resolve, undefined, () => resolve(null));
  });
}

/**
 * @param {string | null | undefined} url
 * @returns {Promise<THREE.Texture | null>}
 */
function loadExrOptional(url) {
  if (!url?.trim()) return Promise.resolve(null);
  return new Promise(resolve => {
    exrLoader.load(url, resolve, undefined, () => resolve(null));
  });
}

/**
 * JPG/PNG via TextureLoader, or `.exr` normals via EXRLoader.
 * @param {string | null | undefined} url
 * @returns {Promise<THREE.Texture | null>}
 */
async function loadNormalMapOptional(url) {
  if (!url?.trim()) return null;
  if (url.toLowerCase().endsWith('.exr')) {
    const t = await loadExrOptional(url);
    if (!t) return null;
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = false;
    return t;
  }
  return loadTextureOptional(url);
}

function disposeMap(mat, key) {
  const t = mat[key];
  if (t && typeof t.dispose === 'function') t.dispose();
  mat[key] = null;
}

function disposeMaterialMaps(mat) {
  if (!mat) return;
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'displacementMap']) {
    disposeMap(mat, k);
  }
}

function setupDataMap(t, rx, ry) {
  if (!t) return;
  t.colorSpace = THREE.NoColorSpace;
  configureRepeat(t, rx, ry);
}

/**
 * @param {THREE.Mesh} wallMesh
 */
export async function loadWallTexturesAsync(wallMesh) {
  const sc = params.scene;
  const m = WALL_TEXTURE_MAPS;

  const [colorMap, roughnessMap, displacementMap, aoMap, metalnessMap, normalMap] = await Promise.all([
    loadTextureOptional(m.color),
    loadTextureOptional(m.roughness),
    loadTextureOptional(m.displacement),
    loadTextureOptional(m.ao),
    loadTextureOptional(m.metalness),
    loadNormalMapOptional(m.normal),
  ]);

  if (!colorMap) {
    console.warn(
      'wallTextures: could not load base color — add',
      m.color,
      'or check path/extension (see WALL_TEXTURE_MAPS in wallTextures.js).',
    );
    return;
  }

  const { x: rx, y: ry } = getWallUvRepeat(sc);

  colorMap.colorSpace = THREE.SRGBColorSpace;
  configureRepeat(colorMap, rx, ry);

  setupDataMap(normalMap, rx, ry);
  setupDataMap(roughnessMap, rx, ry);
  setupDataMap(displacementMap, rx, ry);
  setupDataMap(aoMap, rx, ry);
  setupDataMap(metalnessMap, rx, ry);

  const oldMat = wallMesh.material;
  disposeMaterialMaps(oldMat);
  oldMat.dispose();

  const newMat = new THREE.MeshStandardMaterial({
    color:             0xffffff,
    map:               colorMap,
    normalMap:         normalMap ?? undefined,
    roughnessMap:      roughnessMap ?? undefined,
    metalnessMap:      metalnessMap ?? undefined,
    aoMap:             aoMap ?? undefined,
    displacementMap:   displacementMap ?? undefined,
    displacementScale: WALL_DISPLACEMENT_SCALE,
    displacementBias:  WALL_DISPLACEMENT_BIAS,
    roughness:         roughnessMap ? 1 : 0.92,
    metalness:         metalnessMap ? 1 : 0,
  });

  wallMesh.material = newMat;
  wallMesh.userData.wallUsesGradient = false;

  const oldGeo = wallMesh.geometry;
  wallMesh.geometry = buildWallPlaneGeometry(sc);
  oldGeo.dispose();
}
