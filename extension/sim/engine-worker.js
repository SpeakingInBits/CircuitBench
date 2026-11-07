// Runs CircuitPython and the circuit together in one thread. Pin reads and writes reach the
// circuit synchronously, which is what lets parts behave like real hardware.
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { controlSlots } from '../shared/catalog.js';
import { Circuit } from './circuit.js';
import { CTRL, controlsView, ctrlView, rxView } from './shared-state.js';

// A real Metro has no clock battery, so it powers up in the year 2000.
const POWER_ON_SECONDS = 946684800;
// print() can run far faster than the panel can draw, so output leaves in batches. A program that
// fills a batch waits for the next one, the way it would on a busy USB link.
const SERIAL_BATCH_BYTES = 16 * 1024;
const SERIAL_BATCH_MS = 33;

const { shared, files, firmware, portHeapBytes, circuit: circuitDoc } = workerData;
const ctrl = ctrlView(shared);
const rx = rxView(shared);
const controls = controlsView(shared);
const slots = controlSlots(circuitDoc);
const post = (message) => parentPort.postMessage(message);

const circuit = new Circuit(circuitDoc, { post });
const lastControls = new Float64Array(slots.length);
// Controls can change before this thread starts, so begin from the part defaults.
slots.forEach((slot, i) => { lastControls[i] = slot.value; });
Atomics.store(ctrl, CTRL.CONTROLS_CHANGED, 1);

const nvm = new Uint8Array(256).fill(0xff);
if (workerData.nvm) nvm.set(workerData.nvm);
let clockOffsetMs = POWER_ON_SECONDS * 1000 - Date.now();
const uartQueues = new Map();
const usbIn = { cdc: [], midi: [] };
const serialBatch = new Uint8Array(SERIAL_BATCH_BYTES);
let serialLength = 0;
let lastSerialFlush = -Infinity;

const msUntilSerialFlush = () => SERIAL_BATCH_MS - (circuit.now() - lastSerialFlush);

function flushSerial() {
  if (serialLength > 0) post({ type: 'serial', data: serialBatch.slice(0, serialLength) });
  serialLength = 0;
  lastSerialFlush = circuit.now();
}

function serialWrite(data) {
  let offset = 0;
  while (offset < data.length) {
    while (serialLength === SERIAL_BATCH_BYTES) waitMs(Math.max(1, msUntilSerialFlush()));
    const count = Math.min(data.length - offset, SERIAL_BATCH_BYTES - serialLength);
    serialBatch.set(data.subarray(offset, offset + count), serialLength);
    serialLength += count;
    offset += count;
  }
  if (msUntilSerialFlush() <= 0) flushSerial();
}

// Passes on any controls the student moved.
function applyControls() {
  if (Atomics.exchange(ctrl, CTRL.CONTROLS_CHANGED, 0) !== 1) return;
  for (let i = 0; i < slots.length; i++) {
    const value = controls[i];
    if (value === lastControls[i]) continue;
    lastControls[i] = value;
    circuit.setControl(slots[i].part, slots[i].control, value);
  }
}

// Checks for controls the student moved, and runs anything due.
function service() {
  if (serialLength > 0 && msUntilSerialFlush() <= 0) flushSerial();
  applyControls();
  circuit.tick();
}

function rxCount() {
  return (Atomics.load(ctrl, CTRL.RX_HEAD) - Atomics.load(ctrl, CTRL.RX_TAIL) + rx.length) % rx.length;
}

function waitMs(ms) {
  service();
  const wait = Math.max(0, Math.min(ms, circuit.nextEventIn()));
  if (wait > 0) Atomics.wait(ctrl, CTRL.WAKE, Atomics.load(ctrl, CTRL.WAKE), wait);
  service();
}

// Tracks how much queued sound is left, which the firmware uses to pace itself.
class SoundStream {
  constructor() {
    this.sampleRate = 8000;
    this.channels = 1;
    this.endsAt = 0;
    this.pausedLeft = null;
  }

  start(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.endsAt = circuit.now();
    this.pausedLeft = null;
    post({ type: 'audioStart', sampleRate, channels });
  }

  write(samples) {
    post({ type: 'audio', samples });
    const lengthMs = (samples.length / this.channels / this.sampleRate) * 1000;
    if (this.pausedLeft !== null) this.pausedLeft += lengthMs;
    else this.endsAt = Math.max(this.endsAt, circuit.now()) + lengthMs;
  }

  stop() {
    this.endsAt = 0;
    this.pausedLeft = null;
    post({ type: 'audioStop' });
  }

  pause(paused) {
    if (paused && this.pausedLeft === null) {
      this.pausedLeft = this.bufferedMs();
    } else if (!paused && this.pausedLeft !== null) {
      this.endsAt = circuit.now() + this.pausedLeft;
      this.pausedLeft = null;
    }
  }

  bufferedMs() {
    if (this.pausedLeft !== null) return Math.round(this.pausedLeft);
    return Math.max(0, Math.round(this.endsAt - circuit.now()));
  }
}

const streams = { audio: new SoundStream(), i2s: new SoundStream() };

function boardPin(number) {
  return circuit.pin(number);
}

// --- pulseio ---
const pulseIns = new Map();
let nextPulseIn = 1;

function pulseEdge(state, time) {
  if (state.paused || state.closed) return;
  if (state.lastEdge !== null) state.queue.push(Math.min(65535, Math.round((time - state.lastEdge) * 1000)));
  state.lastEdge = time;
  if (state.queue.length > 1024) state.queue.shift();
}

// --- rotaryio ---
const encoders = new Map();
let nextEncoder = 1;
// Quarter steps for each pair of old and new pin states.
const QUADRATURE = [0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0];

function encoderEdge(state) {
  const a = circuit.pinLevel(state.a);
  const b = circuit.pinLevel(state.b);
  const now = (a << 1) | b;
  state.count += QUADRATURE[(state.last << 2) | now];
  state.last = now;
}

const sim = {
  files,
  portHeapBytes,

  serialWrite,
  serialAvailable: rxCount,
  serialPeek() {
    service();
    return rxCount() === 0 ? -1 : rx[Atomics.load(ctrl, CTRL.RX_TAIL)];
  },
  serialRead() {
    if (rxCount() === 0) return -1;
    const tail = Atomics.load(ctrl, CTRL.RX_TAIL);
    const value = rx[tail];
    Atomics.store(ctrl, CTRL.RX_TAIL, (tail + 1) % rx.length);
    return value;
  },

  waitMs,
  reset(toBootloader) {
    flushSerial();
    post({ type: 'reset', toBootloader: !!toBootloader });
    Atomics.wait(ctrl, CTRL.PARKED, 0);
  },

  pinMode: (pin, mode, pull, openDrain) => circuit.pinMode(pin, mode, pull, !!openDrain),
  pinWrite: (pin, value) => circuit.pinWrite(pin, value),
  pinRead: (pin) => circuit.pinRead(pin),
  adcRead: (pin) => circuit.adcRead(pin),
  dacWrite: (pin, value) => circuit.dacWrite(pin, value),
  pwmSet: (pin, frequency, duty) => circuit.pwmSet(pin, frequency, duty),
  neopixelWrite: (pin, data) => circuit.neopixelWrite(pin, data),

  i2cPullups: (scl, sda) => (circuit.i2cPullups(scl, sda) ? 1 : 0),
  i2cProbe(address) {
    const device = circuit.i2cDevice(address);
    return device && device.context.powered() ? 1 : 0;
  },
  i2cWrite(address, data) {
    const device = circuit.i2cDevice(address);
    if (!device || !device.context.powered()) return 19; // ENODEV, as on the real board.
    device.model.i2c.write(device.context, data);
    return 0;
  },
  i2cRead(address, buffer) {
    const device = circuit.i2cDevice(address);
    if (!device || !device.context.powered()) return 19;
    device.model.i2c.read(device.context, buffer);
    return 0;
  },
  spiTransfer: (clock, data, mosi) => circuit.spiTransfer(clock, data, mosi),

  uartWrite(tx, data) {
    post({ type: 'uart', data });
    const node = boardPin(tx)?.node;
    if (node === undefined) return;
    if (!uartQueues.has(node)) uartQueues.set(node, []);
    uartQueues.get(node).push(...data);
  },
  uartAvailable: (rxPin) => uartQueues.get(boardPin(rxPin)?.node)?.length ?? 0,
  uartRead: (rxPin) => uartQueues.get(boardPin(rxPin)?.node)?.shift() ?? -1,

  touchRead: (pin) => (circuit.touched(pin) ? 65535 : 500),

  rtcGet: () => (Date.now() + clockOffsetMs) / 1000,
  rtcSet(seconds) {
    clockOffsetMs = seconds * 1000 - Date.now();
  },

  nvmRead: (offset, length) => nvm.slice(offset, offset + length),
  nvmWrite(offset, data) {
    nvm.set(data, offset);
    post({ type: 'nvm', data: nvm.slice() });
  },

  encoderOpen(a, b) {
    const state = { a, b, count: 0, last: 0, closed: false };
    for (const pin of [a, b]) {
      circuit.watch(boardPin(pin).node, () => {
        if (!state.closed) encoderEdge(state);
      });
    }
    state.last = (circuit.pinLevel(a) << 1) | circuit.pinLevel(b);
    const id = nextEncoder++;
    encoders.set(id, state);
    return id;
  },
  encoderRead(id) {
    service();
    return encoders.get(id)?.count ?? 0;
  },
  encoderWrite(id, count) {
    const state = encoders.get(id);
    if (state) state.count = count;
  },
  encoderClose(id) {
    const state = encoders.get(id);
    if (state) state.closed = true;
    encoders.delete(id);
  },

  pulseinOpen(pin, idleState) {
    const state = { pin, idleState: !!idleState, queue: [], paused: false, lastEdge: null, closed: false };
    circuit.watch(boardPin(pin).node, (_level, time) => pulseEdge(state, time));
    const id = nextPulseIn++;
    pulseIns.set(id, state);
    return id;
  },
  // Any trigger pulse has already been sent through ordinary pin calls by now.
  pulseinResume(id) {
    const state = pulseIns.get(id);
    if (!state) return;
    state.paused = false;
    state.lastEdge = null;
  },
  pulseinPause(id) {
    const state = pulseIns.get(id);
    if (state) state.paused = true;
  },
  pulseinClear(id) {
    const state = pulseIns.get(id);
    if (state) state.queue = [];
  },
  // The firmware asks this just before it resumes, too. An echo that a trigger pulse has only just
  // started must wait until then, because the edges seen while paused are dropped.
  pulseinCount(id) {
    const state = pulseIns.get(id);
    if (!state?.paused) service();
    return state?.queue.length ?? 0;
  },
  pulseinPop: (id) => pulseIns.get(id)?.queue.shift() ?? -1,
  pulseinClose(id) {
    const state = pulseIns.get(id);
    if (state) state.closed = true;
    pulseIns.delete(id);
  },
  // The firmware blocks for the signal's length itself, so Stop keeps working.
  pulseoutSend() {},

  audioStart: (pin, rate, channels) => streams.audio.start(rate, channels),
  audioWrite: (samples) => streams.audio.write(samples),
  audioStop: () => streams.audio.stop(),
  audioPause: (pin, paused) => streams.audio.pause(paused),
  audioBufferedMs: () => streams.audio.bufferedMs(),
  i2sStart: (pin, rate, channels) => streams.i2s.start(rate, channels),
  i2sWrite: (samples) => streams.i2s.write(samples),
  i2sStop: () => streams.i2s.stop(),
  i2sPause: (pin, paused) => streams.i2s.pause(paused),
  i2sBufferedMs: () => streams.i2s.bufferedMs(),
  pdmRead: (count) => new Int16Array(count),

  delayUs(us) {
    circuit.boardMicros += us;
  },
  parallelWrite() {},

  cdcWrite: (data) => post({ type: 'usb', kind: 'cdc', data }),
  cdcAvailable: () => usbIn.cdc.length,
  cdcRead: () => usbIn.cdc.shift() ?? -1,
  hidSend: (reportId, report) => post({ type: 'usb', kind: 'hid', reportId, data: report }),
  midiWrite: (data) => post({ type: 'usb', kind: 'midi', data }),
  midiAvailable: () => usbIn.midi.length,
  midiRead: () => usbIn.midi.shift() ?? -1,
};

// The firmware can get well into code.py before it first calls service().
applyControls();

const require = createRequire(import.meta.url);
const createCircuitPython = require(firmware);
createCircuitPython({
  sim,
  print: (text) => post({ type: 'log', text }),
  printErr: (text) => post({ type: 'log', text }),
}).catch((error) => {
  flushSerial();
  post({ type: 'crash', message: String(error?.stack ?? error) });
});
