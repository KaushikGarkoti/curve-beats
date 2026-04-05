/**
 * Central tunables — wired to lil-gui in main. Trajectory fields require MIDI reload / regenerate.
 */

export const params = {
  trajectory: {
    bounceThreshold:    1.13,
    sustainDurationMin:   0.5,
    /** During sustained notes: vertical fall distance ≈ sustainFallSpeed × note span (seconds), capped. */
    sustainFallSpeed:   5.5,
    sustainMaxFall:     14,
    /**
     * Sustained notes: max sagitta (arc bulge) as a fraction of chord length. 0 = straight parabolic segment.
     */
    sustainArcBulge:    0.14,
    /**
     * After landing on the sustain pad, vertical drop (world Y) to the neon rail entry below the pad.
     */
    sustainPlatformDrop: 0.32,
    /** Time (s) for the ball to move from pad to rail entry; capped vs total sustain span. */
    sustainEntryDuration: 0.1,
    targetSpeed:        8,
    maxSpatialGap:      2.5,
    /**
     * ROLL segments: if true, horizontal step uses the full real time gap (speed ≈ targetSpeed),
     * so long silences between notes are not drawn as a slow, nearly flat crawl. If false, ROLL
     * uses `maxSpatialGap` like bounces (legacy, keeps path more compact).
     */
    rollSpatialGapUncapped: true,
    /**
     * Long ROLL gaps: follow a spiral around the chord instead of a straight line. Net lateral
     * movement uses min(gap, rollSpiralNetCapSeconds) × targetSpeed so the path stays compact
     * while extra time is spent in loops (see rollSpiralTurns / rollSpiralRadius).
     */
    rollSpiralEnabled: true,
    /** Minimum gap (s) before a ROLL can use spiral mode (must also be ≥ bounceThreshold). */
    rollSpiralMinGapSec: 1.2,
    /** Net “time” (s) for lateral chord length: min(gap, this) × targetSpeed. */
    rollSpiralNetCapSeconds: 2.5,
    /** Number of full loops in the spiral envelope (0 → 1). */
    rollSpiralTurns: 4,
    /** Cylinder cross-section radius (world units). */
    rollSpiralRadius: 5,
    /** Extra drop along world −Y at mid-envelope (sin²); keeps spiral biased downward. */
    rollSpiralDownDepth: 0.45,
    /** Never move the path behind the wall plane (world Z). */
    rollSpiralMinZ: 0.08,
    gravity:            40,
    /**
     * Max vertical drop per bounce landing (world units). Must be large enough to scale with
     * gap — if too low vs horizontal step (targetSpeed × spatialGap), the path looks flat and
     * “all horizontal” in the overlay. Raise for steeper drops; lower for flatter arcs.
     */
    yDropMax:           10,
    /**
     * Vertical drop = min(yDropMax, targetSpeed × spatialGap × dropScale). Horizontal step =
     * targetSpeed × spatialGap. Higher dropScale → steeper (more vertical / slant per bounce).
     */
    dropScale:          0.52,
    spawnX:             -6,
    spawnY:             5,
    ballZ:              0.55,
    /**
     * Linear air drag (1/s): dv/dt = g − k·v between bounces. 0 = pure kinematic arcs.
     * Landings stay fixed (Newton solve at build time).
     */
    linearDrag:         0.42,
    /**
     * If true (default), each gap flips horizontal direction → serpentine / S-like path.
     * If false, lateral steps keep the same sign (diagonal drift in X; no zigzag).
     */
    bounceAlternateSides: true,
    /**
     * Optional piecewise override by transport time (seconds). Each range is [tStart, tEnd) in
     * song time; the first range containing the **note onset** wins. If no range matches,
     * `bounceAlternateSides` applies. Use for e.g. serpentine intro then diagonal middle section.
     * @type {{ tStart: number, tEnd: number, bounceAlternateSides: boolean }[]}
     */
    bounceAlternateSideRanges: [],
  },
  camera: {
    /** If false (default), camera stays at world X=0; lookAt keeps the ball centered with minimal lateral rig motion. */
    followBallX:     false,
    cameraZ:         28,
    /** World-space lateral shift added to camera X (after follow/smooth X). */
    offsetX:         -0.53,
    offsetY:         2.3,
    lookBiasY:       -1.8,
    lerpY:           0.036,
    maxCameraYSpeed: 24,
  },
  main: {
    lookahead:            7,
    platformPastWindow:   0.5,
    trailInterval:        0.018,
    trailCullWindow:      2,
    pollWindow:           0.04,
    ballRadius:           0.32,
    squashDuration:       0.2,
  },
  audio: {
    minNoteDuration: 0.02,
    maxNoteDuration: 1.2,
  },
  scene: {
    backgroundColor: '#f2ece2',
    /** UnrealBloom — soft halo around emissive hits (pads, ball). Lower threshold = more bloom. */
    bloomStrength:   0.58,
    bloomRadius:     0.52,
    bloomThreshold:  0.22,
    /** Vertical FOV (deg). Lower = tighter zoom; raise if the ball clips the frame. */
    fov:             73,
    /** Linear fog — start / end distance (camera space). Set far ≤ 0 to disable. */
    fogNear:         55,
    fogFar:          240,
    ambientIntensity: 0.55,
    keyIntensity:    1.1,
    fillIntensity:   0.25,
    /** Vertical wall gradient: dark teal (bottom) → bright cyan (top), world +Y. */
    wallGradientBottom: '#0a3540',
    wallGradientTop:    '#2ec8d4',
    /** World half-extents of the Z=0 backdrop plane (full size = 2× each). Large = “infinite” feel. */
    wallHalfWidth:  400,
    wallHalfHeight: 5000,
    /** World Y of the wall quad center (plane is vertical in XZ). */
    wallCenterY:    -1500,
  },
  /**
   * Full-path overlay vs saved reference (Path compare in GUI).
   * Baked path: draws the full trajectory so the serpentine (lateral oscillation) is visible at a glance;
   * opacity is kept low so it reads as a guide. Turn off in Path compare for a minimal view.
   */
  pathCompare: {
    showReference:   true,
    showBakedPath:   true,
    referenceOpacity: 0.5,
    bakedOpacity:    0.22,
    sampleDt:        0.02,
  },
  fx: {
    /** Always-on pad emissive (multiplies pad color). Hit pulse adds on top, then returns here — never black. */
    platformEmissiveBase: 0.52,
    /** Platform pad glow on ball hit; fade length = this × beat (from MIDI tempo). */
    platformGlowBeats: 0.45,
    /** Peak emissive strength (multiplies pad color) at impact; should be ≥ platformEmissiveBase. */
    platformGlowPeak:  1.85,
    /** Share of glow window spent snapping on (0–1), like striking a filament. */
    platformGlowStrike: 0.065,
    /** Share of glow window held at full brightness before dimming. */
    platformGlowHoldFrac: 0.28,
    trailOpacity:      0.55,
    particleSize:      0.13,
    particleLifetime:  0.7,
    particleDamping:   0.92,
    burstScatterXY:    2.8,
    burstScatterY:     2.5,
    burstScatterZ:     1.5,
  },
  pitch: {
    midiMin: 36,
    midiMax: 96,
  },
  /**
   * Gap = time between consecutive note onsets (seconds).
   * beat = gap / secondsPerBeat (from MIDI tempo).
   * MEDIUM/LARGE + plain bounce → split: transition (ramp/tube placeholder) then free fall.
   */
  gap: {
    smallBeatMax:   0.25,
    mediumBeatMax:  1.0,
    transTimeRatio: 0.7,
    fallTimeRatio:  0.3,
    enableSplit:    true,
  },
};
