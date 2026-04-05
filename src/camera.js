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
 * X-axis policy (when followBallX = false — the default):
 *   The camera position X stays fixed until the ball is within `xDeadZoneFrac`
 *   of the screen half-width from the edge.  Once the ball exits the dead zone
 *   the camera slides at `xEdgeLerp` speed to keep the ball just inside the
 *   safe region.  When the ball returns to the centre region the camera slowly
 *   drifts back toward X = 0 (`xCentreReturn`).
 *
 * @param {import('three').PerspectiveCamera} camera
 * @param {import('three').Vector3} ballPos - current visual ball position
 * @param {number} dt  - frame delta (seconds)
 */
export function updateCamera(camera, ballPos, dt) {
  const c = params.camera;

  if (lastFollowBallX !== c.followBallX) {
    smoothX = c.followBallX ? ballPos.x : smoothX;
    lastFollowBallX = c.followBallX;
  }

  if (!initialized) {
    smoothX = c.followBallX ? ballPos.x : 0;
    smoothY = ballPos.y;
    initialized = true;
  }

  const maxStep = c.maxCameraYSpeed * dt;

  // ── X axis ────────────────────────────────────────────────────────────────
  if (c.followBallX) {
    // Legacy: tight lerp, always follows
    const errX = ballPos.x - smoothX;
    let stepX  = errX * c.lerpY;
    if (Math.abs(stepX) > maxStep) stepX = Math.sign(stepX) * maxStep;
    smoothX += stepX;
  } else {
    // Dead-zone: camera X is lazy — only moves when ball nears screen edge.
    // Compute the world-space half-width of the frustum at the ball's Z depth.
    const distZ      = Math.abs(c.cameraZ - ballPos.z);
    const halfFrustW = distZ * Math.tan(camera.fov * (Math.PI / 360)) * camera.aspect;
    const safeHalfW  = halfFrustW * Math.max(0, Math.min(1, c.xDeadZoneFrac));

    // Ball position relative to camera centre X
    const relX = ballPos.x - smoothX;

    if (Math.abs(relX) > safeHalfW) {
      // Ball has escaped the safe zone — push camera so ball lands on the edge
      const targetX = ballPos.x - Math.sign(relX) * safeHalfW;
      const err     = targetX - smoothX;
      let stepX     = err * c.xEdgeLerp;
      // Never overshoot in one frame
      if (Math.abs(stepX) > Math.abs(err)) stepX = err;
      if (Math.abs(stepX) > maxStep) stepX = Math.sign(stepX) * maxStep;
      smoothX += stepX;
    } else {
      // Ball is comfortably on screen — drift camera X slowly back to centre
      smoothX += (0 - smoothX) * Math.min(c.xCentreReturn, 1);
    }
  }

  // ── Y axis ────────────────────────────────────────────────────────────────
  const errY = ballPos.y - smoothY;
  let stepY  = errY * c.lerpY;
  if (Math.abs(stepY) > maxStep) stepY = Math.sign(stepY) * maxStep;
  smoothY += stepY;

  camera.position.set(smoothX + c.offsetX, smoothY + c.offsetY, c.cameraZ);

  // Look at the camera's own smooth position, not the ball's raw X/Y.
  // This prevents the view from rotating left/right to chase the ball while
  // the camera position is inside the dead zone — the view only shifts when
  // the camera physically moves.
  camera.lookAt(smoothX, smoothY + c.lookBiasY, 0);
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
