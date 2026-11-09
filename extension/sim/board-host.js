// Host-side handle for one running simulation.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { controlSlots, emptyCircuit } from '../shared/catalog.js';
import { CTRL, controlsView, createShared, ctrlView, rxView } from './shared-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Stands in for the M0's 32KB of SRAM minus .data, .bss and the stack.
const METRO_M0_PORT_HEAP_BYTES = 24 * 1024;
// A program can print for hours, so only recent output is kept for waitForOutput().
const MAX_OUTPUT_CHARS = 1024 * 1024;

export class Board extends EventEmitter {
  constructor({
    files, circuit = emptyCircuit(), firmware = path.join(HERE, '..', 'firmware', 'firmware.cjs'),
    portHeapBytes = METRO_M0_PORT_HEAP_BYTES, nvm, controls = {},
  }) {
    super();
    this.output = '';
    // A batch can end part way through a multi-byte character.
    this.decoder = new StringDecoder('utf8');
    this.slots = controlSlots(circuit);
    this.slotIndex = new Map(this.slots.map((slot, i) => [`${slot.part}:${slot.control}`, i]));
    this.shared = createShared(this.slots.length);
    this.ctrl = ctrlView(this.shared);
    this.rx = rxView(this.shared);
    this.controls = controlsView(this.shared);
    // Keyed as "part:control". These are in place before the program starts, which setControl()
    // can't promise because the worker is already running by the time it can be called.
    this.slots.forEach((slot, i) => { this.controls[i] = controls[`${slot.part}:${slot.control}`] ?? slot.value; });
    const encoded = Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      data: typeof content === 'string' ? new TextEncoder().encode(content) : content,
    }));
    this.worker = new Worker(path.join(HERE, 'engine-worker.js'), {
      workerData: { shared: this.shared, files: encoded, firmware, portHeapBytes, circuit, nvm },
    });
    this.worker.on('message', (message) => this.handle(message));
    this.worker.on('error', (error) => this.emit('crash', String(error?.stack ?? error)));
    // A running board never ends by itself, so this means it failed or was stopped.
    this.worker.on('exit', () => this.emit('exit'));
  }

  handle(message) {
    if (message.type === 'serial') {
      const text = this.decoder.write(Buffer.from(message.data));
      this.output = (this.output + text).slice(-MAX_OUTPUT_CHARS);
      this.emit('serial', text);
    } else if (message.type === 'crash') {
      this.emit('crash', message.message);
    } else {
      this.emit(message.type, message);
    }
  }

  wake() {
    Atomics.add(this.ctrl, CTRL.WAKE, 1);
    Atomics.notify(this.ctrl, CTRL.WAKE);
  }

  // Sends text to the serial console, as if typed. "\x03" is Ctrl-C, which is how Stop works.
  write(text) {
    for (const byte of Buffer.from(text, 'utf8')) {
      const head = Atomics.load(this.ctrl, CTRL.RX_HEAD);
      this.rx[head] = byte;
      Atomics.store(this.ctrl, CTRL.RX_HEAD, (head + 1) % this.rx.length);
    }
    this.wake();
  }

  setControl(part, control, value) {
    const index = this.slotIndex.get(`${part}:${control}`);
    if (index === undefined) return;
    this.controls[index] = value;
    Atomics.store(this.ctrl, CTRL.CONTROLS_CHANGED, 1);
    this.wake();
  }

  waitForOutput(text, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.output.includes(text)) {
          clearTimeout(timer);
          this.off('serial', check);
          resolve(this.output);
        }
      };
      const timer = setTimeout(() => {
        this.off('serial', check);
        reject(new Error(`Timed out waiting for ${JSON.stringify(text)}. Output so far:\n${this.output}`));
      }, timeoutMs);
      this.on('serial', check);
      check();
    });
  }

  stop() {
    return this.worker.terminate();
  }
}
