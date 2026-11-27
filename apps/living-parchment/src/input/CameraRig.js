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
//
// On the map, zoom is one chain: zooming in first dollies closer (zoomK), then folds down to
// walk; zooming out folds back up to the tabletop, dollies away, then flattens to the map.
// The map can also be orbited all the way round, tilted from nearly edge-on to straight down,
// and panned across the table.

export const FOV_MIN = 15;
export const FOV_MAX = 65;
export const FOLD_DEFAULT = 0.4;
export const POV_START = 0.6; // fold where the descent to ground level begins
export const EYE_HEIGHT = 0.34; // world units above the terrain (trees are ~1.5 tall)
export const WALK_SPEED = 1.5; // world units per second
export const PAGE_LIMIT = 4.75; // walker stays inside the sheet
export const SPAWN_BACK = 3.9; // how far toward the viewer the walk starts
export const PAN_LIMIT = 6; // how far the map view can slide off-centre
export const FOLD_RATE = 0.55; // fold units per unit of ln(zoom)
export const VIEW_PRESETS = { top: 1.56, tilt: 1.05, low: 0.2 };

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
    this.limits = { pitchMin: 0.1, pitchMax: 1.56, zoomMin: 0.35, zoomMax: 1.9 };
    this.baseZ = 0.55; // framing offset for the screen shape (see fit)
    this.pan = { x: 0, z: 0 };
    this.goal.panX = 0;
    this.goal.panZ = 0;
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

  /**
   * Pinch / wheel: factor > 1 means "further away". Runs along one chain:
   * flat map <-> dolly out <-> tabletop <-> dolly in <-> walk.
   */
  zoom(factor) {
    if (!(factor > 0)) return;
    const g = this.goal;
    const L = this.limits;
    let a = -Math.log(factor);
    const take = (need) => {
      const used = Math.min(Math.abs(a), Math.max(0, need));
      a -= Math.sign(a) * used;
      return used;
    };
    if (a > 0) {
      if (g.fold < FOLD_DEFAULT) g.fold += take((FOLD_DEFAULT - g.fold) / FOLD_RATE) * FOLD_RATE;
      if (a > 0 && g.fold <= FOLD_DEFAULT + 1e-9) {
        g.zoomK = Math.max(L.zoomMin, g.zoomK / Math.exp(take(Math.log(g.zoomK / L.zoomMin))));
        if (a > 0) g.zoomK = L.zoomMin;
      }
      if (a > 0) g.fold = clamp(g.fold + a * FOLD_RATE, 0, 1);
    } else if (a < 0) {
      if (g.fold > FOLD_DEFAULT) g.fold -= take((g.fold - FOLD_DEFAULT) / FOLD_RATE) * FOLD_RATE;
      if (a < 0) {
        g.zoomK = Math.min(L.zoomMax, g.zoomK * Math.exp(take(Math.log(L.zoomMax / g.zoomK))));
        if (a < 0) g.zoomK = L.zoomMax;
      }
      if (a < 0) g.fold = clamp(g.fold + a * FOLD_RATE, 0, 1);
    }
  }

  /** Drag the map across the table by a screen-space delta in CSS pixels. */
  panBy(dxPx, dyPx) {
    if (this.pov) return;
    const k = Math.max(this.distance, 2) * 0.0011;
    const b = this.basis(this.yaw);
    this.panWorld(-dxPx * k, dyPx * k, b);
  }

  /** Move the map view: `right` and `forward` in world units relative to the view direction. */
  panWorld(right, forward, b = this.basis(this.yaw)) {
    const g = this.goal;
    g.panX = clamp(g.panX + b.rx * right + b.fx * forward, -PAN_LIMIT, PAN_LIMIT);
    g.panZ = clamp(g.panZ + b.rz * right + b.fz * forward, -PAN_LIMIT, PAN_LIMIT);
  }

  /** Spin the map (or turn the walker) by `d` radians. */
  turn(d) {
    this.orbit(d, 0);
  }

  /** Jump to a named tilt: 'top', 'tilt' or 'low'. Leaves walking first if needed. */
  view(name) {
    const p = VIEW_PRESETS[name];
    if (p === undefined) return;
    if (this.goal.fold > POV_START) this.goal.fold = FOLD_DEFAULT;
    if (this.goal.fold < FOLD_DEFAULT) this.goal.fold = FOLD_DEFAULT;
    this.goal.pitch = clamp(p, this.limits.pitchMin, this.limits.pitchMax);
  }

  /** Back to the starting tabletop view: centred, unrotated, default tilt and zoom. */
  resetView() {
    const g = this.goal;
    g.fold = FOLD_DEFAULT;
    g.pitch = 1.05;
    g.zoomK = 1;
    g.panX = 0;
    g.panZ = 0;
    // Take the short way round to yaw 0.
    g.yaw -= Math.round(g.yaw / (Math.PI * 2)) * Math.PI * 2;
    this.yaw -= Math.round(this.yaw / (Math.PI * 2)) * Math.PI * 2;
    g.yaw = 0;
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
    this.baseZ = aspect < 1 ? 0.3 : 0.55;
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
    this.pan.x += (g.panX - this.pan.x) * k;
    this.pan.z += (g.panZ - this.pan.z) * k;
    this.target.x = this.pan.x;
    this.target.z = this.baseZ + this.pan.z;
    this.fold += (g.fold - this.fold) * (1 - Math.exp(-dt * 6));
    if (Math.abs(g.fold - this.fold) < 1e-4) this.fold = g.fold;

    const w = povWeight(this.fold);
    const wk = this.walker;

    if (w === 0) {
      // On the map, W A S D / arrows slide the view across the table.
      const mx = clamp(this.move.x, -1, 1);
      const my = clamp(this.move.y, -1, 1);
      if (Math.abs(mx) + Math.abs(my) > 0.01) this.panWorld(mx * 3.2 * this.zoomK * dt, my * 3.2 * this.zoomK * dt);
      // Not yet descending: the walker waits toward the near edge of the page, facing in the
      // same direction as the map camera, so stepping down shows the diorama ahead. Zoomed in,
      // it waits closer to what you were looking at.
      const b0 = this.basis(this.yaw);
      const back = SPAWN_BACK * Math.min(1, this.zoomK);
      wk.x = clamp(this.target.x - b0.fx * back, -PAGE_LIMIT, PAGE_LIMIT);
      wk.z = clamp(this.target.z - b0.fz * back, -PAGE_LIMIT, PAGE_LIMIT);
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
