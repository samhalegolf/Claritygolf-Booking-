// Short tones for the live gate, synthesised with Web Audio so there are no
// sound files. Placeholders: which sound goes with which moment is still to be
// chosen, so each one is just a list of notes below.
//
// Phones only let a page make sound after a tap, so unlockSounds() must be
// called from one (opening the lab).

export type PuttingSound = "ballReady" | "ballLifted" | "inside" | "outside";

type Note = { frequency: number; start: number; duration: number; wave?: OscillatorType };

const SOUNDS: Record<PuttingSound, Note[]> = {
  // Ball settled in the box: a quick rising pair.
  ballReady: [
    { frequency: 880, start: 0, duration: 0.08 },
    { frequency: 1320, start: 0.09, duration: 0.1 },
  ],
  // Ball taken out of the box: one soft low blip.
  ballLifted: [{ frequency: 440, start: 0, duration: 0.08 }],
  // Through the gate: a bright rising triad.
  inside: [
    { frequency: 784, start: 0, duration: 0.1 },
    { frequency: 988, start: 0.1, duration: 0.1 },
    { frequency: 1319, start: 0.2, duration: 0.18 },
  ],
  // Outside the gate: a falling buzz.
  outside: [
    { frequency: 330, start: 0, duration: 0.16, wave: "square" },
    { frequency: 220, start: 0.17, duration: 0.24, wave: "square" },
  ],
};

let context: AudioContext | null = null;

/** Call from a tap. Safe to call more than once, and silent where Web Audio is missing. */
export function unlockSounds() {
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    context ??= new Context();
    void context.resume().catch(() => undefined);
  } catch {
    context = null;
  }
}

export function playSound(sound: PuttingSound) {
  const ctx = context;
  if (!ctx || ctx.state !== "running") return;
  const at = ctx.currentTime + 0.01;
  for (const note of SOUNDS[sound]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = note.wave ?? "sine";
    oscillator.frequency.value = note.frequency;
    // A short attack and decay, so the notes do not click.
    const start = at + note.start;
    const end = start + note.duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(note.wave === "square" ? 0.12 : 0.3, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }
}
