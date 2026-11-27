// Virtual thumbstick for walking at ground level, plus WASD / arrow keys on desktop.
// Writes into a shared `{x, y}` vector: x = strafe right, y = forward, each -1..1.

/** Map a finger offset (px) from the stick centre to a walk vector with a dead zone. */
export function stickVector(dx, dy, radius = 48, dead = 0.12) {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  const m = Math.min(1, len / radius);
  if (m < dead) return { x: 0, y: 0 };
  const k = (m - dead) / (1 - dead) / len; // rescale past the dead zone, keep direction
  return { x: dx * k, y: -dy * k };
}

export class Thumbstick {
  constructor(root, out) {
    this.out = out;
    this.root = root;
    this.knob = root.querySelector('.knob');
    this.pointerId = null;
    this.radius = 48;
    this.stick = { x: 0, y: 0 };
    this.keys = new Set();

    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.pointerId = e.pointerId;
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointers in tests */
      }
      this._track(e);
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointerId) this._track(e);
    });
    const end = (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.stick.x = this.stick.y = 0;
      this.knob.style.transform = 'translate(-50%, -50%)';
      this._combine();
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    const KEYS = { w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r' };
    window.addEventListener('keydown', (e) => {
      const k = KEYS[e.key.toLowerCase()];
      if (!k || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target?.closest?.('input, select, textarea')) return; // sliders own their arrow keys
      this.keys.add(k);
      this._combine();
    });
    window.addEventListener('keyup', (e) => {
      const k = KEYS[e.key.toLowerCase()];
      if (!k) return;
      this.keys.delete(k);
      this._combine();
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this._combine();
    });
  }

  set visible(v) {
    this.root.classList.toggle('show', v);
    if (!v) {
      this.stick.x = this.stick.y = 0;
      this.pointerId = null;
      this.knob.style.transform = 'translate(-50%, -50%)';
      this._combine();
    }
  }

  _track(e) {
    const r = this.root.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const v = stickVector(dx, dy, this.radius);
    this.stick.x = v.x;
    this.stick.y = v.y;
    const len = Math.hypot(dx, dy) || 1;
    const c = Math.min(len, this.radius) / len;
    this.knob.style.transform = `translate(calc(-50% + ${dx * c}px), calc(-50% + ${dy * c}px))`;
    this._combine();
  }

  _combine() {
    let x = this.stick.x;
    let y = this.stick.y;
    if (this.keys.has('f')) y += 1;
    if (this.keys.has('b')) y -= 1;
    if (this.keys.has('r')) x += 1;
    if (this.keys.has('l')) x -= 1;
    this.out.x = Math.max(-1, Math.min(1, x));
    this.out.y = Math.max(-1, Math.min(1, y));
  }
}
