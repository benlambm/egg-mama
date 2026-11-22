const tune = [
  76, 0, 79, 0, 81, 79, 76, 0, 74, 0, 76, 0, 79, 0, 74, 0,
  72, 0, 76, 0, 79, 76, 72, 0, 74, 0, 77, 0, 76, 74, 72, 0,
];
const bass = [48, 55, 45, 52, 41, 48, 43, 50];
const frequency = (note) => 440 * 2 ** ((note - 69) / 12);

export class ArcadeSound {
  constructor(enabled) {
    this.enabled = enabled;
    this.beat = 0;
    this.nextBeat = 0;
  }

  ready() {
    if (!this.enabled) return;
    try {
      if (!this.context) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return;
        this.context = new Context();
        this.master = this.context.createGain();
        this.master.gain.value = 0.29;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
    } catch {}
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) this.ready();
    if (this.master) this.master.gain.setTargetAtTime(enabled ? 0.29 : 0, this.context.currentTime, 0.023);
  }

  tone(from, end, duration, volume, wave = "square", delay = 0) {
    if (!this.enabled || !this.context || this.context.state !== "running") return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const output = this.context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(end, start + duration);
    output.gain.setValueAtTime(0.001, start);
    output.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    output.gain.exponentialRampToValueAtTime(0.001, start + duration);
    oscillator.connect(output);
    output.connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }

  effect(event) {
    switch (event.kind) {
      case "start":
        this.tone(262, 420, 0.12, 0.15, "triangle");
        this.tone(523, 784, 0.15, 0.16, "triangle", 0.1);
        break;
      case "jump":
        this.tone(320, 535, 0.13, 0.082, "triangle");
        break;
      case "spring":
        this.tone(260, 850, 0.25, 0.19, "triangle");
        break;
      case "egg": {
        const note = frequency([72, 76, 79, 84, 88, 91][(event.combo - 1) % 6]);
        this.tone(note, note * 1.02, 0.10, 0.16, "triangle");
        break;
      }
      case "gold":
      case "shield":
      case "magnet":
      case "gate":
      case "beacon":
      case "checkpoint":
        this.tone(523, 590, 0.11, 0.16, "triangle");
        this.tone(659, 660, 0.11, 0.16, "triangle", 0.075);
        this.tone(784, 788, 0.18, 0.17, "triangle", 0.14);
        break;
      case "stomp":
        this.tone(190, 90, 0.12, 0.17);
        break;
      case "duckling-used":
      case "hit":
      case "shield-break":
        this.tone(208, 78, 0.22, 0.12, "sawtooth");
        break;
      case "over":
        this.tone(392, 330, 0.17, 0.12, "triangle", 0.05);
        this.tone(294, 262, 0.23, 0.12, "triangle", 0.20);
        break;
    }
  }

  reset() {
    this.beat = 0;
    this.nextBeat = 0;
  }

  music() {
    if (!this.enabled || !this.context || this.context.state !== "running") return;
    const time = this.context.currentTime;
    if (time < this.nextBeat) return;
    const beat = this.beat++ % tune.length;
    this.nextBeat = time + 0.153;
    if (tune[beat]) this.tone(frequency(tune[beat]), frequency(tune[beat]), 0.115, 0.032, "square");
    if (beat % 4 === 0) {
      const low = frequency(bass[Math.floor(beat / 4)]);
      this.tone(low, low, 0.21, 0.079, "triangle");
    } else if (beat % 4 === 2) {
      this.tone(94, 47, 0.053, 0.043, "triangle");
    }
  }
}
