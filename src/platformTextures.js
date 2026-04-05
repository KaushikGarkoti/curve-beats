/**
 * PBR maps for platform pads from `public/textures/platforms/`.
 * Textures are shared across all pooled pads (same Texture objects).
 */

import * as THREE from 'three';
import { applyPadBaseEmissive } from './platforms.js';

const loader = new THREE.TextureLoader();

/**
 * `public/` URLs must include Vite `base` (e.g. `/repo/` on GitHub Pages).
 * @param {string} relFromPublic e.g. `textures/platforms/foo.jpg`
 */
export function publicTextureUrl(relFromPublic) {
  const base = import.meta.env.BASE_URL ?? '/';
  const path = relFromPublic.replace(/^\//, '');
  return `${base}${path}`;
}

/** @public — filenames under `public/textures/platforms/` */
export const PLATFORM_TEXTURE_MAPS = {
  color:        publicTextureUrl('textures/platforms/Poliigon_MetalSteelBrushed_7174_BaseColor.jpg'),
  normal:       publicTextureUrl('textures/platforms/Poliigon_MetalSteelBrushed_7174_Normal.png'),
  roughness:    publicTextureUrl('textures/platforms/Poliigon_MetalSteelBrushed_7174_Roughness.jpg'),
  metalness:    publicTextureUrl('textures/platforms/Poliigon_MetalSteelBrushed_7174_Metallic.jpg'),
  ao:           publicTextureUrl('textures/platforms/Poliigon_MetalSteelBrushed_7174_AmbientOcclusion.jpg'),
  /**
   * TIFF is not decodable by WebGL `TextureLoader` in most browsers — leave empty or set a PNG/JPG
   * (e.g. bake displacement to normal only, or export height as PNG).
   */
  displacement: '',
};

/** World units per texture repeat on the pad top face (width × depth). */
const PAD_TEX_TILE_U = 0.85;
const PAD_TEX_TILE_V = 0.85;

const DISPLACEMENT_SCALE = 0.035;
const DISPLACEMENT_BIAS = 0;

/**
 * @param {THREE.BufferGeometry} geometry
 */
export function ensurePadGeometryUv2(geometry) {
  const uv = geometry.attributes.uv;
  if (!uv || geometry.attributes.uv2) return;
  geometry.setAttribute('uv2', new THREE.BufferAttribute(uv.array.slice(), uv.itemSize));
}

/**
 * @param {THREE.Texture} tex
 * @param {number} repeatU
 * @param {number} repeatV
 */
function configurePadMaps(tex, repeatU, repeatV) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatU, repeatV);
}

/**
 * @param {string | null | undefined} url
 * @returns {Promise<THREE.Texture | null>}
 */
function loadTextureOptional(url, label = '') {
  if (!url?.trim()) return Promise.resolve(null);
  return new Promise(resolve => {
    loader.load(
      url,
      tex => resolve(tex),
      undefined,
      () => {
        console.warn(`platformTextures: failed to load ${label || url}`);
        resolve(null);
      },
    );
  });
}

function setupDataMap(t, repeatU, repeatV) {
  if (!t) return;
  t.colorSpace = THREE.NoColorSpace;
  configurePadMaps(t, repeatU, repeatV);
}

/** @type {Promise<PlatformMapsBundle | null> | null} */
let loadPromise = null;

/**
 * @typedef {{
 *   color: THREE.Texture,
 *   normal: THREE.Texture | null,
 *   roughness: THREE.Texture | null,
 *   metalness: THREE.Texture | null,
 *   ao: THREE.Texture | null,
 *   displacement: THREE.Texture | null,
 *   repeatU: number,
 *   repeatV: number,
 * }} PlatformMapsBundle
 */

/**
 * Loads maps once; returns null if base color fails.
 * @returns {Promise<PlatformMapsBundle | null>}
 */
export function ensurePlatformTexturesLoaded() {
  if (loadPromise) return loadPromise;
  const m = PLATFORM_TEXTURE_MAPS;
  loadPromise = (async () => {
    const [colorMap, normalMap, roughnessMap, metalnessMap, aoMap, displacementMap] =
      await Promise.all([
        loadTextureOptional(m.color),
        loadTextureOptional(m.normal),
        loadTextureOptional(m.roughness),
        loadTextureOptional(m.metalness),
        loadTextureOptional(m.ao),
        loadTextureOptional(m.displacement),
      ]);

    if (!colorMap) {
      console.warn(
        'platformTextures: could not load base color — check path and that the file exists in public/',
        m.color,
      );
      return null;
    }

    if (import.meta.env.DEV) {
      console.info('platformTextures: applied steel maps from', m.color);
    }

    const padW = 2.0;
    const padD = 0.7;
    const repeatU = Math.max(0.5, padW / PAD_TEX_TILE_U);
    const repeatV = Math.max(0.5, padD / PAD_TEX_TILE_V);

    colorMap.colorSpace = THREE.SRGBColorSpace;
    configurePadMaps(colorMap, repeatU, repeatV);

    if (normalMap) {
      normalMap.colorSpace = THREE.NoColorSpace;
      normalMap.flipY = true;
      configurePadMaps(normalMap, repeatU, repeatV);
    }
    setupDataMap(roughnessMap, repeatU, repeatV);
    setupDataMap(metalnessMap, repeatU, repeatV);
    setupDataMap(aoMap, repeatU, repeatV);
    setupDataMap(displacementMap, repeatU, repeatV);

    return {
      color: colorMap,
      normal: normalMap,
      roughness: roughnessMap,
      metalness: metalnessMap,
      ao: aoMap,
      displacement: displacementMap,
      repeatU,
      repeatV,
    };
  })();
  return loadPromise;
}

/**
 * Replace pad mesh material with PBR textured material; keeps current tint `color`.
 * Idempotent: skips if `map` is already set (shared textures across pads).
 * @param {THREE.Mesh} padMesh
 * @param {PlatformMapsBundle} maps
 */
export function applyPlatformMapsToPadMesh(padMesh, maps) {
  const old = padMesh.material;
  if (!old || !maps?.color) return;
  if (old.map) return;

  const colorHex = old.color.getHex();
  old.dispose();

  const mat = new THREE.MeshStandardMaterial({
    color:             colorHex,
    map:               maps.color,
    emissive:          new THREE.Color(0),
    emissiveIntensity: 1,
    roughness:         maps.roughness ? 1 : 0.32,
    metalness:         maps.metalness ? 1 : 0.08,
  });
  if (maps.normal) {
    mat.normalMap = maps.normal;
    mat.normalScale = new THREE.Vector2(1, 1);
  }
  if (maps.roughness) mat.roughnessMap = maps.roughness;
  if (maps.metalness) mat.metalnessMap = maps.metalness;
  if (maps.ao) mat.aoMap = maps.ao;
  if (maps.displacement) {
    mat.displacementMap = maps.displacement;
    mat.displacementScale = DISPLACEMENT_SCALE;
    mat.displacementBias = DISPLACEMENT_BIAS;
  }

  padMesh.material = mat;
  applyPadBaseEmissive(mat);
}

/**
 * @param {THREE.Group[]} pool
 */
export async function applyPlatformTexturesToPool(pool) {
  const maps = await ensurePlatformTexturesLoaded();
  if (!maps) return;
  for (const group of pool) {
    const pad = group.children[0];
    if (pad && pad.isMesh) applyPlatformMapsToPadMesh(pad, maps);
  }
}
