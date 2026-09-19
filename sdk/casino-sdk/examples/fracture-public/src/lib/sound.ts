import type { Reality } from './fracture';

/**
 * SoundManager — every cue is synthesised with WebAudio at play time.
 *
 * No audio files: the whole sound design ships as a few hundred bytes of
 * oscillator scheduling instead of megabytes of samples. That matters here
 * because the jam scores "loads near-instantly" and the game runs in an
 * iframe on mobile connections.
 *
 * The context is created lazily on the first user gesture, because browsers
 * suspend audio contexts that are constructed before one.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let ambientStop: (() => void) | null = null;
let muted = false;

function ensure(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  return muted;
}

/** Small random detune so a cue played every round doesn't sound identical. */
function jitter(hz: number, pct = 0.03): number {
  return hz * (1 - pct + Math.random() * pct * 2);
}

export function setMuted(next: boolean) {
  muted = next;
  if (master) master.gain.value = next ? 0 : 0.9;
}

/** Call from a click handler so the context is allowed to start. */
export function unlockAudio() {
  ensure();
}

type ToneOptions = {
  type?: OscillatorType;
  from: number;
  to?: number;
  duration: number;
  gain?: number;
  delay?: number;
  /** -1 = hard left, 1 = hard right. */
  pan?: number;
  panTo?: number;
};

function tone(opts: ToneOptions) {
  const audio = ensure();
  if (!audio || !master) return;

  const t0 = audio.currentTime + (opts.delay ?? 0);
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const peak = opts.gain ?? 0.2;

  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.from, t0);
  if (opts.to !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(opts.to, 0.0001), t0 + opts.duration);
  }

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.06, opts.duration * 0.25));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);

  let tail: AudioNode = gain;
  if (opts.pan !== undefined && audio.createStereoPanner) {
    const panner = audio.createStereoPanner();
    panner.pan.setValueAtTime(opts.pan, t0);
    if (opts.panTo !== undefined) {
      panner.pan.linearRampToValueAtTime(opts.panTo, t0 + opts.duration);
    }
    gain.connect(panner);
    tail = panner;
  }

  osc.connect(gain);
  tail.connect(master);
  osc.start(t0);
  osc.stop(t0 + opts.duration + 0.05);
}

function noise(duration: number, gain = 0.15, delay = 0, filterHz = 1400) {
  const audio = ensure();
  if (!audio || !master) return;

  const t0 = audio.currentTime + delay;
  const frames = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, frames, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const src = audio.createBufferSource();
  src.buffer = buffer;

  const filter = audio.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterHz;

  const g = audio.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(t0);
}

/** A low ambient bed that runs while the world is idle. */
export function startAmbient() {
  const audio = ensure();
  if (!audio || !master || ambientStop) return;

  const osc = audio.createOscillator();
  const lfo = audio.createOscillator();
  const lfoGain = audio.createGain();
  const gain = audio.createGain();

  osc.type = 'sine';
  osc.frequency.value = 55;
  lfo.type = 'sine';
  lfo.frequency.value = 0.08;
  lfoGain.gain.value = 5;

  gain.gain.value = 0.045;

  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  osc.connect(gain);
  gain.connect(master);

  osc.start();
  lfo.start();

  ambientStop = () => {
    try {
      gain.gain.setTargetAtTime(0.0001, audio.currentTime, 0.2);
      osc.stop(audio.currentTime + 0.6);
      lfo.stop(audio.currentTime + 0.6);
    } catch {
      /* already stopped */
    }
    ambientStop = null;
  };
}

export function stopAmbient() {
  ambientStop?.();
}

/** Rising tension while the VRF request is in flight. */
export function playAnticipation() {
  tone({ type: 'sawtooth', from: 90, to: 320, duration: 1.6, gain: 0.05 });
  tone({ type: 'sine', from: 180, to: 640, duration: 1.6, gain: 0.03, delay: 0.08 });
}

/**
 * A soft heartbeat during a wait that outlasts the initial tension sweep.
 * Synced to the same 1.4s cycle as the CSS "tension" pulse on the world.
 * Deliberately quiet and short so a slow VRF round-trip doesn't turn into an
 * annoying loop on repeated plays.
 */
export function playTensionPulse() {
  tone({ type: 'sine', from: jitter(96), to: jitter(58), duration: 0.16, gain: 0.045 });
}

/**
 * The machine's mechanical vocabulary. These three are deliberately dry,
 * short and un-musical: a casino machine's controls make contact noises, not
 * notes. Everything melodic in this game is reserved for the five laws.
 */

/** Lock: a heavy contactor closing. The commit, felt through the panel. */
export function playLock() {
  // The clack of the key bottoming out...
  noise(0.045, 0.3, 0, 2600);
  // ...then the weight of the mechanism behind it.
  tone({ type: 'sine', from: 150, to: 58, duration: 0.14, gain: 0.3 });
  tone({ type: 'square', from: 92, to: 62, duration: 0.09, gain: 0.07, delay: 0.012 });
}

/** Select: a single crisp key press. Short enough to press repeatedly. */
export function playSelect() {
  noise(0.022, 0.16, 0, 5200);
  tone({ type: 'square', from: jitter(1150), duration: 0.016, gain: 0.05 });
  tone({ type: 'sine', from: jitter(330), to: jitter(250), duration: 0.05, gain: 0.07, delay: 0.008 });
}

/** Wager detent: the lightest sound on the machine, one notch of a dial. */
export function playTick() {
  noise(0.012, 0.1, 0, 6500);
  tone({ type: 'square', from: jitter(1650), duration: 0.01, gain: 0.035 });
}

/**
 * The five outcome cues, matching the design notes:
 *   Gravity — deep bass drop        Orbit — rotating spatial pan
 *   Time    — reversed ticking      Void  — silence, then sub-bass
 *   Scale   — heavy impact
 */
export function playOutcome(outcome: Reality) {
  switch (outcome) {
    case 0: // GRAVITY — bass drop, then the rise as everything floats up
      tone({ type: 'sine', from: 220, to: 28, duration: 1.0, gain: 0.34 });
      tone({ type: 'triangle', from: 110, to: 660, duration: 1.2, gain: 0.07, delay: 0.17 });
      break;

    case 1: // TIME — reversed ticking: clicks accelerating as it rewinds
      for (let i = 0; i < 14; i++) {
        const t = i / 14;
        noise(0.035, 0.16 * (1 - t * 0.5), t * t * 1.0, 2600);
        tone({ type: 'square', from: 900 - i * 34, duration: 0.02, gain: 0.05, delay: t * t * 1.0 });
      }
      tone({ type: 'sawtooth', from: 420, to: 130, duration: 1.27, gain: 0.05 });
      break;

    case 2: // SCALE — heavy impact
      noise(0.5, 0.42, 0, 900);
      tone({ type: 'sine', from: 150, to: 36, duration: 0.7, gain: 0.4 });
      tone({ type: 'square', from: 70, to: 40, duration: 0.9, gain: 0.12, delay: 0.04 });
      // second, smaller impact as the shrunken objects land
      noise(0.3, 0.2, 0.42, 1500);
      break;

    case 3: // ORBIT — a tone sweeping hard across the stereo field
      tone({ type: 'sine', from: 320, to: 210, duration: 1.53, gain: 0.22, pan: -1, panTo: 1 });
      tone({ type: 'triangle', from: 160, to: 105, duration: 1.53, gain: 0.16, pan: 1, panTo: -1 });
      tone({ type: 'sine', from: 640, to: 420, duration: 1.53, gain: 0.06, pan: -0.6, panTo: 0.6 });
      break;

    case 4: // VOID — silence first, then sub-bass out of nothing
      stopAmbient();
      tone({ type: 'sine', from: 480, to: 90, duration: 0.55, gain: 0.1 });
      // ~0.5s of nothing, then the floor drops out
      tone({ type: 'sine', from: 46, to: 18, duration: 1.9, gain: 0.5, delay: 1.06 });
      tone({ type: 'sine', from: 92, to: 36, duration: 1.61, gain: 0.16, delay: 1.06 });
      break;
  }
}

/**
 * Win and loss are deliberately *small*. The spectacle already happened —
 * a law of physics just broke and the world is still settling. A four-note
 * jackpot fanfare on top of that is the exact "generic casino jingle" the
 * brief rules out, and it would also step on the outcome's own sound.
 *
 * So: the win is the machine acknowledging a payout (a payout relay, a warm
 * confirming interval), and the loss is the machine simply powering back
 * down. Neither competes with the fracture that preceded it.
 */
export function playWin() {
  // The payout relay closing.
  noise(0.03, 0.14, 0, 3200);
  // A bare fifth — confirmation, not celebration.
  tone({ type: 'triangle', from: 392, duration: 0.5, gain: 0.1, delay: 0.03 });
  tone({ type: 'triangle', from: 588, duration: 0.42, gain: 0.07, delay: 0.06 });
  tone({ type: 'sine', from: 784, duration: 0.6, gain: 0.035, delay: 0.09 });
}

export function playLose() {
  // The machine settling back to idle: a soft mechanical release, then air.
  noise(0.05, 0.08, 0, 1100);
  tone({ type: 'sine', from: 196, to: 132, duration: 0.42, gain: 0.08 });
}

// --- Core drag feedback -----------------------------------------------------
//
// The drag-to-lock Core needs continuous feedback tied to proximity, which a
// one-shot `tone()` can't give — so this keeps a single persistent
// oscillator alive for the whole drag gesture and re-tunes it every pointer
// move, instead of spawning a new node per frame (which would be both wasteful
// and, at 60fps, audibly glitchy).

/** A faint per-anchor base pitch so five different targets don't hum identically. */
const CORE_HUM_BASE_HZ: Record<Reality, number> = {
  0: 70, // gravity — low, grounded
  1: 130, // time — mid, a little unstable
  2: 100, // scale — mid-low
  3: 160, // orbit — higher, circling
  4: 46, // void — lowest, ominous
};

let coreHum: { osc: OscillatorNode; gain: GainNode } | null = null;

/** Call once, on pointerdown. */
export function startCoreHum(outcome: Reality) {
  const audio = ensure();
  if (!audio || !master) return;
  stopCoreHum();

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'sine';
  osc.frequency.value = CORE_HUM_BASE_HZ[outcome];
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(master);
  osc.start();
  coreHum = { osc, gain };
}

/**
 * Call on every pointer move while dragging. `intensity` is 0..1 proximity to
 * the nearest anchor; `outcome` re-tunes the base pitch if the nearest anchor
 * changed since the hum started. Kept very quiet — this plays continuously
 * during a drag, so it must never compete with the tap-card `playSelect` or
 * become the thing a player mutes the game over.
 */
export function updateCoreHum(outcome: Reality, intensity: number) {
  if (!coreHum || !ctx) return;
  const t = ctx.currentTime;
  const base = CORE_HUM_BASE_HZ[outcome];
  coreHum.osc.frequency.setTargetAtTime(base + intensity * 40, t, 0.05);
  coreHum.gain.gain.setTargetAtTime(intensity * 0.05, t, 0.08);
}

/** Call on pointerup / drag cancel — always safe to call even if not humming. */
export function stopCoreHum() {
  if (!coreHum || !ctx) {
    coreHum = null;
    return;
  }
  const { osc, gain } = coreHum;
  const t = ctx.currentTime;
  gain.gain.setTargetAtTime(0.0001, t, 0.06);
  osc.stop(t + 0.25);
  coreHum = null;
}

/** Edge-triggered — call once exactly when the drag crosses into lock range. */
export function playCaptureReady() {
  tone({ type: 'sine', from: jitter(720), to: jitter(980), duration: 0.11, gain: 0.06 });
}

/** The release missed every anchor's lock range — a soft, non-punishing miss. */
export function playDragFizzle() {
  tone({ type: 'sine', from: jitter(260), to: jitter(140), duration: 0.16, gain: 0.05 });
}
