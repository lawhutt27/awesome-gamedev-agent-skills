// The Dimensional Fold: one camera rig that runs from a flat, orthographic-feeling map view
// down to a first-person walk across the diorama.
//
// `fold` (0..1) is the single axis that pinch and the wheel drive:
//   0    top-down map, fov 15°
//   0.4  the default tabletop view, fov 35°
//   1    standing on the terrain, fov 65°
// The field of view widens linearly with the fold while the camera rig lowers onto the
// walker's position over the last part of the range, so the flat ink map turns into a
// walkable diorama in one continuous gesture.

export const FOV_MIN = 15;
export const FOV_MAX = 65;
export const FOLD_DEFAULT = 0.4;
export const POV_START = 0.6; // fold where the descent to ground level begins
export const EYE_HEIGHT = 0.34; // world units above the terrain (trees are ~1.5 tall)
export const WALK_SPEED = 1.5; // world units per second
export const PAGE_LIMIT = 4.75; // walker stays inside the sheet
export const SPAWN_BACK = 3.9; // how far toward the viewer the walk starts

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function fovForFold(f) {
  return FOV_MIN + (FOV_MAX - FOV_MIN) * clamp(f, 0, 1);
}

/** 0 = fully map camera, 1 = fully ground-level camera. */
export function povWeight(f) {
  return smooth(POV_START, 1, f);
}

/** Camera distance that keeps the whole page in frame for a vertical fov and aspect. */
export function fitDistance(fovDeg, aspect) {
  const v = Math.tan(((fovDeg * Math.PI) / 180) * 0.5);
  const h = v * aspect;
  return Math.max(4.9 / v, 5.8 / h);
}

export class CameraRig {
  constructor(camera, { fold = FOLD_DEFAULT, yaw = 0, pitch = 1.05 } = {}) {
    this.camera = camera;
    this.aspect = camera.aspect || 1;
    this.yaw = yaw;
    this.pitch = pitch;
    this.zoomK = 1; // extra map-view dolly multiplier
    this.fold = fold;
    this.goal = { yaw, pitch, fold, zoomK: 1 };
    this.limits = { pitchMin: 0.32, pitchMax: 1.5, zoomMin: 0.55, zoomMax: 1.6 };
    this.target = { x: 0, y: 0, z: 0.55 };
    this.walker = { x: 0, z: 0.55, y: 0, yaw, pitch: -0.08, goalYaw: yaw, goalPitch: -0.08, bob: 0 };
    this.move = { x: 0, y: 0 }; // walking input, x = strafe right, y = forward (-1..1)
    this.fov = fovForFold(fold);
    this.distance = 0;
    this._pos = { x: 0, y: 0, z: 0 };
    this._look = { x: 0, y: 0, z: 0 };
  }

  /** True once the camera has (almost) reached the ground. Input switches to walk/look. */
  get pov() {
    return this.fold > 0.96;
  }

  setFold(f) {
    this.goal.fold = clamp(f, 0, 1);
  }

  /** Pinch / wheel: factor > 1 means "further away" (fold toward the map). */
  zoom(factor) {
    if (!(factor > 0)) return;
    this.goal.fold = clamp(this.goal.fold - Math.log(factor) * 0.55, 0, 1);
  }

  orbit(dYaw, dPitch) {
    if (this.pov || this.goal.fold > 0.96) {
      this.look(dYaw, dPitch);
      return;
    }
    this.goal.yaw += dYaw;
    this.goal.pitch = clamp(this.goal.pitch + dPitch, this.limits.pitchMin, this.limits.pitchMax);
  }

  /** First-person look (radians). */
  look(dYaw, dPitch) {
    this.walker.goalYaw += dYaw;
    this.walker.goalPitch = clamp(this.walker.goalPitch + dPitch, -1.1, 0.9);
  }

  fit(aspect) {
    this.aspect = aspect;
    this.target.z = aspect < 1 ? 0.3 : 0.55;
  }

  /** Forward / right unit vectors on the ground for the current walker yaw. */
  basis(yaw = this.walker.yaw) {
    return { fx: -Math.sin(yaw), fz: -Math.cos(yaw), rx: Math.cos(yaw), rz: -Math.sin(yaw) };
  }

  /**
   * Advance the rig. `heightAt(x, z)` returns the terrain's world Y and `isWater(x, z)` slows
   * wading. Allocation-free.
   */
  update(dt, heightAt = () => 0, isWater = null) {
    const k = 1 - Math.exp(-dt * 10);
    const g = this.goal;
    this.yaw += (g.yaw - this.yaw) * k;
    this.pitch += (g.pitch - this.pitch) * k;
    this.zoomK += (g.zoomK - this.zoomK) * k;
    this.fold += (g.fold - this.fold) * (1 - Math.exp(-dt * 6));
    if (Math.abs(g.fold - this.fold) < 1e-4) this.fold = g.fold;

    const w = povWeight(this.fold);
    const wk = this.walker;

    if (w === 0) {
      // Not yet descending: the walker waits at the near edge of the page, facing in the same
      // direction as the map camera, so stepping down shows the whole diorama ahead.
      const b0 = this.basis(this.yaw);
      wk.x = clamp(this.target.x - b0.fx * SPAWN_BACK, -PAGE_LIMIT, PAGE_LIMIT);
      wk.z = clamp(this.target.z - b0.fz * SPAWN_BACK, -PAGE_LIMIT, PAGE_LIMIT);
      wk.yaw = wk.goalYaw = this.yaw;
      wk.pitch = wk.goalPitch = -0.08;
    } else {
      wk.yaw += (wk.goalYaw - wk.yaw) * (1 - Math.exp(-dt * 14));
      wk.pitch += (wk.goalPitch - wk.pitch) * (1 - Math.exp(-dt * 14));
      if (this.pov) {
        const mx = clamp(this.move.x, -1, 1);
        const my = clamp(this.move.y, -1, 1);
        const mag = Math.min(1, Math.hypot(mx, my));
        if (mag > 0.01) {
          const b = this.basis(wk.yaw);
          const slow = isWater && isWater(wk.x, wk.z) ? 0.5 : 1;
          const s = WALK_SPEED * slow * dt;
          wk.x = clamp(wk.x + (b.fx * my + b.rx * mx) * s, -PAGE_LIMIT, PAGE_LIMIT);
          wk.z = clamp(wk.z + (b.fz * my + b.rz * mx) * s, -PAGE_LIMIT, PAGE_LIMIT);
          wk.bob += dt * 9 * mag;
        }
      }
      // Keep the map view facing the way you walked, so folding back up feels continuous.
      g.yaw = this.yaw = wk.yaw;
    }
    const ground = heightAt(wk.x, wk.z);
    wk.y += (ground - wk.y) * (w === 0 ? 1 : 1 - Math.exp(-dt * 12));

    // Map pose.
    this.fov = fovForFold(this.fold);
    const tilt = this.pitch + (1.5 - this.pitch) * (1 - smooth(0, FOLD_DEFAULT, this.fold));
    const d = fitDistance(this.fov, this.aspect) * this.zoomK;
    const cp = Math.cos(tilt);
    const mapX = this.target.x + Math.sin(this.yaw) * cp * d;
    const mapY = this.target.y + Math.sin(tilt) * d;
    const mapZ = this.target.z + Math.cos(this.yaw) * cp * d;

    // Ground pose.
    const eyeY = wk.y + EYE_HEIGHT + Math.sin(wk.bob) * 0.012;
    const b = this.basis(wk.yaw);
    const cpp = Math.cos(wk.pitch);
    const lookX = wk.x + b.fx * cpp * 4;
    const lookY = eyeY + Math.sin(wk.pitch) * 4;
    const lookZ = wk.z + b.fz * cpp * 4;

    const p = this._pos;
    const l = this._look;
    p.x = mapX + (wk.x - mapX) * w;
    p.y = mapY + (eyeY - mapY) * w;
    p.z = mapZ + (wk.z - mapZ) * w;
    l.x = this.target.x + (lookX - this.target.x) * w;
    l.y = this.target.y + (lookY - this.target.y) * w;
    l.z = this.target.z + (lookZ - this.target.z) * w;
    this.distance = Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);

    const c = this.camera;
    c.position.set(p.x, p.y, p.z);
    c.lookAt(l.x, l.y, l.z);
    if (c.fov !== undefined && Math.abs(c.fov - this.fov) > 1e-3) {
      c.fov = this.fov;
      c.updateProjectionMatrix?.();
    }
  }
}
