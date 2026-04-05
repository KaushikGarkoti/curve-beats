/**
 * CAMERA SYSTEM
 * -------------
 * Wall-facing follow camera.
 *
 * Fixed Z (far from wall); smooth-follow in Y (and optionally X). lookAt keeps
 * the ball centered in the frustum; with followBallX off, the rig does not pan
 * in X—only yaw/pitch tracks the ball. FOV is static (params.scene.fov).
 *
 */

import { params } from './params.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let smoothX     = 0;
let smoothY     = 0;
let initialized = false;
/** @type {boolean | null} */
let lastFollowBallX = null;

/**
 * Update camera position and orientation.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {import('three').Vector3} ballPos - current visual ball position
 * @param {number} dt  - frame delta (seconds)
 */
export function updateCamera(camera, ballPos, dt) {
  const c = params.camera;

  if (lastFollowBallX !== c.followBallX) {
    if (c.followBallX) smoothX = ballPos.x;
    else smoothX = 0;
    lastFollowBallX = c.followBallX;
  }

  if (!initialized) {
    smoothX = c.followBallX ? ballPos.x : 0;
    smoothY = ballPos.y;
    initialized = true;
  }

  const maxStep = c.maxCameraYSpeed * dt;

  if (c.followBallX) {
    const errX = ballPos.x - smoothX;
    let stepX  = errX * c.lerpY;
    if (Math.abs(stepX) > maxStep) stepX = Math.sign(stepX) * maxStep;
    smoothX += stepX;
  } else {
    smoothX = 0;
  }

  const errY = ballPos.y - smoothY;
  let stepY  = errY * c.lerpY;
  if (Math.abs(stepY) > maxStep) stepY = Math.sign(stepY) * maxStep;
  smoothY += stepY;

  const baseX = (c.followBallX ? smoothX : 0) + c.offsetX;
  camera.position.set(baseX, smoothY + c.offsetY, c.cameraZ);

  camera.lookAt(ballPos.x, ballPos.y + c.lookBiasY, ballPos.z);
}

/** Move the key directional light to stay near the ball (keeps shadow valid) */
export function updateKeyLight(light, ballX, ballY) {
  light.position.set(ballX + 6, ballY + 12, 8);
  light.target.position.set(ballX, ballY, 0);
  light.target.updateMatrixWorld();
}

export function onResize(camera, renderer, composer) {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setSize(window.innerWidth, window.innerHeight);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }
}

/** Call when swapping trajectory so follow Y re-syncs to the new path */
export function resetCameraFollow() {
  initialized = false;
  lastFollowBallX = null;
  smoothX = 0;
  smoothY = 0;
}
