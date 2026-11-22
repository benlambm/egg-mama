import { chapterIndex } from "./chapters.mjs";

// Each arrangement shares the groove and changes harmony and melody at a bar boundary.
const arrangements = [
  {
    chords: [[48, 4, 7, 11], [45, 3, 7, 10], [41, 4, 7, 11], [43, 5, 7, 10]],
    motifs: [[76, 79, 81, 79, 74, 76], [72, 76, 79, 81, 79, 76]],
  },
  {
    chords: [[45, 3, 7, 10], [41, 4, 7, 11], [48, 4, 7, 11], [43, 4, 7, 10]],
    motifs: [[81, 79, 76, 72, 74, 76], [76, 74, 72, 69, 72, 74]],
  },
  {
    chords: [[50, 3, 7, 10], [46, 4, 7, 11], [53, 4, 7, 11], [48, 4, 7, 10]],
    motifs: [[77, 81, 84, 81, 79, 77], [74, 77, 79, 81, 84, 81]],
  },
];
const leadSteps = [0, 3, 6, 10, 12, 15];
const bassSteps = [0, 3, 6, 8, 11, 14];
const chordSteps = [2, 7, 10, 14];
const tempo = 108;
const frequency = (note) => 440 * 2 ** ((note - 69) / 12);

export class ArcadeSound {
  constructor(enabled) {
    this.enabled = enabled;
    this.beat = 0;
    this.nextBeat = 0;
    this.arrangement = 0;
    this.musicPlaying = false;
  }

  ready() {
    if (!this.enabled) return;
    try {
      if (!this.context) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return;
        this.context = new Context();
        this.master = this.context.createGain();
        this.master.gain.value = 0.42;
        this.master.connect(this.context.destination);
        this.musicBus = this.context.createGain();
        this.musicBus.gain.value = 0;
        this.musicBus.connect(this.master);
        const sampleRate = this.context.sampleRate;
        this.percussion = this.context.createBuffer(1, Math.floor(sampleRate * 0.2), sampleRate);
        const samples = this.percussion.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      }
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
    } catch {}
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) this.ready();
    else this.pauseMusic();
    if (this.master) this.master.gain.setTargetAtTime(enabled ? 0.42 : 0, this.context.currentTime, 0.023);
  }

  tone(from, end, duration, volume, wave = "square", delay = 0, bus = this.master) {
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
    output.connect(bus);
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

  pauseMusic() {
    this.musicPlaying = false;
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(0, this.context.currentTime, 0.02);
  }

  reset() {
    this.pauseMusic();
    this.beat = 0;
    this.nextBeat = 0;
  }

  noise(at, duration, loudness, filterType, hz) {
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    source.buffer = this.percussion;
    filter.type = filterType;
    filter.frequency.value = hz;
    envelope.gain.setValueAtTime(0.001, at);
    envelope.gain.exponentialRampToValueAtTime(loudness, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.001, at + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.musicBus);
    source.start(at);
    source.stop(at + duration + 0.01);
  }

  music(stage) {
    if (!this.enabled || !this.context || this.context.state !== "running") return;
    const now = this.context.currentTime;
    const chapter = chapterIndex(stage);
    const desired = chapter < 4 ? 0 : chapter < 9 ? 1 : 2;
    if (!this.musicPlaying) {
      this.musicPlaying = true;
      this.musicBus.gain.setTargetAtTime(0.74, now, 0.04);
      this.nextBeat = now + 0.045;
      this.arrangement = desired;
    }
    // Leave silence over a stalled frame rather than replaying a backlog.
    if (this.nextBeat < now) this.nextBeat = now + 0.035;
    while (this.nextBeat < now + 0.12) {
      const step = this.beat % 16;
      const bar = Math.floor(this.beat / 16);
      if (step === 0) this.arrangement = desired;
      const when = this.nextBeat - now;
      this.playStep(arrangements[this.arrangement], bar, step, when);
      this.beat++;
      this.nextBeat += (60 / tempo / 4) * (step % 2 === 0 ? 1.12 : 0.88);
    }
  }

  playStep(arrangement, bar, step, when) {
    const at = this.context.currentTime + when;
    const music = this.musicBus;
    const pitch = (note, duration, gain, wave, delay = when) => {
      const hz = frequency(note);
      this.tone(hz, hz, duration, gain, wave, delay, music);
    };
    const [root, third, fifth, seventh] = arrangement.chords[bar % arrangement.chords.length];
    if (step % 4 === 0) this.tone(125, 44, 0.17, 0.34, "sine", when, music);
    if (step === 4 || step === 12) {
      this.noise(at, 0.10, 0.15, "bandpass", 1380);
      this.tone(183, 101, 0.08, 0.07, "triangle", when, music);
    }
    if (step % 4 === 2) this.noise(at, 0.055, 0.087, "highpass", 6500);
    if (step === 7 || step === 15) this.noise(at, 0.035, 0.066, "highpass", 8300);

    if (bassSteps.includes(step)) {
      const octave = step === 6 || step === 14 ? 12 : 0;
      const note = root - 12 + octave;
      const length = step % 4 === 0 ? 0.19 : 0.11;
      pitch(note, length, 0.16, "triangle");
      pitch(note + 12, length * 0.72, 0.038, "square");
    }
    if (chordSteps.includes(step)) {
      for (const interval of [third, fifth, seventh]) pitch(root + 12 + interval, 0.21, 0.022, "triangle");
    }
    const leadIndex = leadSteps.indexOf(step);
    if (leadIndex !== -1 && (bar % 4 !== 3 || step < 10)) {
      const phrase = arrangement.motifs[bar % 2];
      const note = phrase[leadIndex];
      pitch(note, 0.145, 0.053, "triangle");
      pitch(note, 0.12, 0.017, "sine", when + 0.22);
    }
  }
}
