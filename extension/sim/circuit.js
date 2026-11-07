// The live circuit: turns a saved drawing into solvable electrical groups, tracks the board's
// pins, runs timed part behaviour and reports what each part should look like.
import { BOARD_PINS, BOARD_TYPE, SUPPLY_LIMITS, controlSlots, definition } from '../shared/catalog.js';
import { buildNets, pinKey } from '../shared/nets.js';
import { MODELS } from './models.js';
import { Solver } from './solver.js';

export const VCC = 3.3;
const LOGIC_THRESHOLD = 1.5;
const PIN_DRIVER_OHMS = 50;
const PIN_PULL_OHMS = 40000;
const DAC_OHMS = 1000;
const PIN_MAX_AMPS = 0.01;
const PIN_MAX_VOLTS = 3.6;
const RAIL_MAX_AMPS = 0.5;
const REVERSED_SUPPLY_VOLTS = 1;
const FRAME_MS = 33;

export const PIN_MODE = { OFF: 0, INPUT: 1, OUTPUT: 2, ANALOG_IN: 3, ANALOG_OUT: 4, PWM: 5 };
const PULL_UP = 1;
const PULL_DOWN = 2;

// One independent group of nodes, solved on its own.
class Group {
  constructor(solver) {
    this.solver = solver;
    this.dirty = true;
    this.watchers = [];
  }
}

// Gives a part model access to the circuit, addressed by the part's own pin names.
export class PartContext {
  constructor(circuit, part) {
    this.circuit = circuit;
    this.part = part;
    this.id = part.id;
    this.props = part.props ?? {};
    this.controls = {};
    for (const control of definition(part.type).controls ?? []) this.controls[control.id] = control.default ?? 0;
    this.outputs = [];
  }

  node(pin) {
    return typeof pin === 'number' ? pin : this.circuit.nodeOf(this.id, pin);
  }

  newNode() {
    return this.circuit.newNode();
  }

  now() {
    return this.circuit.now();
  }

  volts(pin) {
    return this.circuit.volts(this.node(pin));
  }

  difference(a, b) {
    return this.volts(a) - this.volts(b);
  }

  level(pin) {
    return this.volts(pin) > LOGIC_THRESHOLD;
  }

  powered(vcc = 'VCC', gnd = 'GND', minimum = 2.5) {
    return this.difference(vcc, gnd) >= minimum;
  }

  resistor(a, b, ohms) {
    return this.circuit.addElement('resistor', this.node(a), this.node(b), ohms);
  }

  switch(a, b, closed = false, ohms = 0.05) {
    return this.circuit.addElement('switch', this.node(a), this.node(b), closed, ohms);
  }

  diode(anode, cathode, forwardVolts, ohms) {
    return this.circuit.addElement('diode', this.node(anode), this.node(cathode), forwardVolts, ohms);
  }

  npn(base, collector, emitter) {
    this.link(collector, base);
    return this.circuit.addElement('npn', this.node(base), this.node(collector), this.node(emitter));
  }

  nmos(gate, drain, source) {
    this.link(drain, gate);
    return this.circuit.addElement('nmos', this.node(gate), this.node(drain), this.node(source));
  }

  source(positive, negative, volts, ohms) {
    return this.circuit.addElement('source', this.node(positive), this.node(negative), volts, ohms);
  }

  // A logic or analog output. set(volts) drives it, set(null) lets it float.
  output(pin, { gnd = 'GND', ohms = 100 } = {}) {
    const element = this.source(pin, gnd, 0, ohms);
    element.off = true;
    return {
      element,
      set: (volts) => {
        const off = volts === null;
        if (element.off === off && (off || element.volts === volts)) return;
        element.off = off;
        if (!off) element.volts = volts;
        this.circuit.markDirty(element);
      },
    };
  }

  // Opens or closes a switch and re-solves.
  setSwitch(element, closed) {
    if (element.closed === closed) return;
    element.closed = closed;
    this.circuit.markDirty(element);
  }

  setResistance(element, ohms) {
    if (element.ohms === ohms) return;
    element.ohms = ohms;
    this.circuit.markDirty(element);
  }

  watch(pin, callback) {
    this.circuit.watch(this.node(pin), callback);
  }

  // Marks two nodes as related, so a PWM pin driving a transistor base is found from its load.
  link(a, b) {
    this.circuit.link(this.node(a), this.node(b));
  }

  after(delayMs, callback) {
    this.circuit.schedule(this.now() + delayMs, callback);
  }

  at(timeMs, callback) {
    this.circuit.schedule(timeMs, callback);
  }

  // The PWM signal reaching a pin, if any: { frequency, duty } with duty from 0 to 1.
  pwm(pin) {
    return this.circuit.pwmReaching(this.node(pin));
  }

  // Fraction of time the nearest fast-toggling board pin is high, or null if none is toggling.
  duty(pin) {
    return this.circuit.dutyReaching(this.node(pin));
  }

  problem(severity, message, pin) {
    this.circuit.problem(severity, this.id, message, pin);
  }
}

export class Circuit {
  constructor(doc, { now = () => performance.now(), post = () => {}, random = Math.random } = {}) {
    this.doc = doc;
    this.now = now;
    this.post = post;
    this.random = random;
    this.events = [];
    this.settleQueue = new Set();
    this.boardMicros = 0;
    this.oneWireDevices = [];
    this.problems = new Map();
    this.pending = [];
    this.links = new Map();
    this.lastFrame = 0;
    this.lastViews = new Map();
    this.pwmPins = new Map();
    this.onboard = { led: 0, neopixel: null };
    this.nets = buildNets(doc);
    this.mapNodes();
    this.createPins();
    this.createParts();
    this.finalize();
    for (const part of this.parts.values()) part.model.start?.(part.context);
    this.settleAll();
  }

  // Rails become fixed negative nodes. Each other net gets its own node number.
  mapNodes() {
    const board = this.doc.parts.find((part) => part.type === BOARD_TYPE);
    if (!board) throw new Error('The circuit has no board.');
    this.boardId = board.id;
    const netOfPin = (pin) => this.nets.netOf.get(pinKey(board.id, pin));
    const railNets = new Map([
      [netOfPin('GND1'), { node: 0, name: 'GND' }],
      [netOfPin('3V'), { node: -1, name: '3V' }],
      [netOfPin('5V'), { node: -2, name: '5V' }],
      [netOfPin('IOREF'), { node: -1, name: '3V' }],
    ]);
    const shorted = [netOfPin('GND1'), netOfPin('3V'), netOfPin('5V')];
    this.shorted = new Set(shorted).size < shorted.length;
    if (netOfPin('IOREF') === netOfPin('GND1') || netOfPin('IOREF') === netOfPin('5V')) this.shorted = true;
    this.rails = [VCC, 5];
    this.netNode = new Map();
    this.nextNode = 1;
    for (let net = 0; net < this.nets.netCount; net++) {
      this.netNode.set(net, railNets.has(net) ? railNets.get(net).node : this.nextNode++);
    }
    this.elements = [];
  }

  nodeOf(partId, pin) {
    const net = this.nets.netOf.get(pinKey(partId, pin));
    if (net === undefined) throw new Error(`Unknown pin ${partId}:${pin}`);
    return this.netNode.get(net);
  }

  newNode() {
    return this.nextNode++;
  }

  addElement(kind, ...args) {
    const [a, b, c, d] = args;
    let element;
    if (kind === 'resistor') element = { kind, a, b, ohms: c };
    else if (kind === 'switch') element = { kind, a, b, closed: c, ohms: d };
    else if (kind === 'diode') element = { kind, a, b, forwardVolts: c, ohms: d, on: false, amps: 0 };
    else if (kind === 'source') element = { kind, a, b, volts: c, ohms: d ?? 0.01, off: false };
    else if (kind === 'npn') element = { kind, base: a, collector: b, emitter: c, gain: 150, state: 'off', baseAmps: 0, collectorAmps: 0 };
    else if (kind === 'nmos') element = { kind, gate: a, drain: b, source: c, thresholdVolts: 2, onOhms: 0.5, on: false };
    this.elements.push(element);
    return element;
  }

  createPins() {
    this.pins = new Map();
    for (const [name, number] of Object.entries(BOARD_PINS)) {
      const node = this.nodeOf(this.boardId, name);
      const pin = {
        number, name, node, mode: PIN_MODE.OFF, pull: 0, openDrain: false, value: 0,
        driver: this.addElement('source', node, 0, 0, PIN_DRIVER_OHMS),
        pullUp: this.addElement('source', node, 0, VCC, PIN_PULL_OHMS),
        pullDown: this.addElement('source', node, 0, 0, PIN_PULL_OHMS),
        pwm: null, highMs: 0, changedAt: this.now(), transitions: 0, duty: null,
      };
      pin.driver.off = pin.pullUp.off = pin.pullDown.off = true;
      this.pins.set(number, pin);
    }
    // The D13 LED and its resistor are soldered to the board.
    const pin13 = this.pins.get(BOARD_PINS.D13);
    const middle = this.newNode();
    this.addElement('resistor', pin13.node, middle, 470);
    this.onboardLed = this.addElement('diode', middle, 0, 1.8, 5);
  }

  createParts() {
    this.parts = new Map();
    for (const part of this.doc.parts) {
      const model = MODELS[part.type];
      if (!model) continue;
      const context = new PartContext(this, part);
      this.parts.set(part.id, { part, context, model });
      model.setup?.(context);
    }
  }

  // Splits the circuit into groups that share no unknown nodes, then builds a solver for each.
  finalize() {
    const parent = new Int32Array(this.nextNode).map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const nodesOf = (e) => (e.kind === 'npn' ? [e.base, e.collector, e.emitter]
      : e.kind === 'nmos' ? [e.gate, e.drain, e.source] : [e.a, e.b]);
    for (const e of this.elements) {
      const unknown = nodesOf(e).filter((node) => node > 0);
      for (let i = 1; i < unknown.length; i++) parent[find(unknown[0])] = find(unknown[i]);
    }

    this.neighbors = new Map();
    const connect = (a, b, e) => {
      if (!this.neighbors.has(a)) this.neighbors.set(a, []);
      if (!this.neighbors.has(b)) this.neighbors.set(b, []);
      this.neighbors.get(a).push({ to: b, element: e });
      this.neighbors.get(b).push({ to: a, element: e });
    };
    for (const e of this.elements) {
      if (e.a !== undefined) {
        connect(e.a, e.b, e);
      } else if (e.kind === 'npn') {
        connect(e.collector, e.emitter, e);
        connect(e.base, e.emitter, e);
      } else if (e.kind === 'nmos') {
        connect(e.drain, e.source, e);
      }
    }

    const groupOfRoot = new Map();
    const localOf = new Map();
    this.groupOfNode = new Map();
    const rootsNodes = new Map();
    for (let node = 1; node < this.nextNode; node++) {
      const root = find(node);
      if (!rootsNodes.has(root)) rootsNodes.set(root, []);
      rootsNodes.get(root).push(node);
    }
    for (const [root, nodes] of rootsNodes) {
      const group = new Group(new Solver(nodes.length + 1, this.rails));
      groupOfRoot.set(root, group);
      nodes.forEach((node, index) => {
        localOf.set(node, index + 1);
        this.groupOfNode.set(node, group);
      });
    }
    this.localOf = localOf;
    const local = (node) => (node > 0 ? localOf.get(node) : node);
    // Elements wired only between rails, such as an LED across 3V and GND, have no unknowns
    // but still need solving.
    const railGroup = new Group(new Solver(1, this.rails));
    for (const e of this.elements) {
      const unknown = nodesOf(e).find((node) => node > 0);
      for (const field of ['a', 'b', 'base', 'collector', 'emitter', 'gate', 'drain', 'source']) {
        if (typeof e[field] === 'number') e[field] = local(e[field]);
      }
      e.group = unknown === undefined ? railGroup : groupOfRoot.get(find(unknown));
      e.group.solver.add(e);
    }
    this.groups = [railGroup, ...groupOfRoot.values()];
    this.railElements = this.elements.filter((e) => nodesOf(e).some((node) => node < 0));
    for (const { node, callback } of this.pending) this.addWatcher(node, callback);
    this.pending = [];
  }

  watch(node, callback) {
    if (!this.groups) {
      this.pending.push({ node, callback });
      return;
    }
    // Added while running, so start from the present level or the first edge would be lost.
    this.addWatcher(node, callback, this.volts(node) > LOGIC_THRESHOLD);
  }

  addWatcher(node, callback, level = null) {
    const group = this.groupOfNode.get(node);
    if (group) group.watchers.push({ node, callback, level });
  }

  link(a, b) {
    if (!this.links.has(a)) this.links.set(a, []);
    if (!this.links.has(b)) this.links.set(b, []);
    this.links.get(a).push(b);
    this.links.get(b).push(a);
  }

  markDirty(element) {
    const group = element.group;
    if (!group) return;
    group.dirty = true;
    if (group.watchers.length > 0 && !this.sampling) this.settle(group);
  }

  // Solves a group and tells watchers about edges. Those can drive other groups, for example
  // chained shift registers, so groups queue up until everything is stable.
  settle(group) {
    this.settleQueue.add(group);
    if (this.settling) return;
    this.settling = true;
    try {
      for (let pass = 0; pass < 500 && this.settleQueue.size > 0; pass++) {
        const [next] = this.settleQueue;
        this.settleQueue.delete(next);
        if (!next.dirty) continue;
        next.dirty = false;
        next.solver.solve();
        for (const watcher of next.watchers) {
          const level = next.solver.v(this.localOf.get(watcher.node)) > LOGIC_THRESHOLD;
          if (level === watcher.level) continue;
          const first = watcher.level === null;
          watcher.level = level;
          if (!first) watcher.callback(level, this.eventTime ?? this.now());
        }
        if (next.dirty) this.settleQueue.add(next);
      }
    } finally {
      this.settling = false;
      this.settleQueue.clear();
    }
  }

  settleAll() {
    for (const group of this.groups) if (group.dirty) this.settle(group);
  }

  volts(node) {
    if (node <= 0) return node === 0 ? 0 : this.rails[-node - 1];
    const group = this.groupOfNode.get(node);
    if (group.dirty) {
      if (!this.sampling) this.settle(group);
      // During another group's settle this only queues, so solve now for a fresh reading.
      if (group.dirty) group.solver.solve();
    }
    return group.solver.v(this.localOf.get(node));
  }

  schedule(time, callback) {
    const event = { time, callback };
    let index = this.events.length;
    while (index > 0 && this.events[index - 1].time > time) index--;
    this.events.splice(index, 0, event);
  }

  nextEventIn() {
    return this.events.length === 0 ? Infinity : this.events[0].time - this.now();
  }

  // Runs everything that is due. Called often from the engine, so it must stay cheap.
  tick() {
    const now = this.now();
    while (this.events.length > 0 && this.events[0].time <= now) {
      const event = this.events.shift();
      this.eventTime = event.time;
      event.callback(event.time);
      // A timed pulse can start and end between frames.
      this.checkPinVolts();
    }
    this.eventTime = undefined;
    if (now - this.lastFrame >= FRAME_MS) this.frame(now);
  }

  // --- Board pins, called from CircuitPython ---

  pin(number) {
    return this.pins.get(number);
  }

  trackLevel(pin, high) {
    const now = this.now();
    if (pin.lastHigh) pin.highMs += now - pin.changedAt;
    pin.changedAt = now;
    if (high !== pin.lastHigh) pin.transitions++;
    pin.lastHigh = high;
  }

  applyPin(pin) {
    const { driver, pullUp, pullDown } = pin;
    pullUp.off = !(pin.mode === PIN_MODE.INPUT && pin.pull === PULL_UP);
    pullDown.off = !(pin.mode === PIN_MODE.INPUT && pin.pull === PULL_DOWN);
    driver.ohms = PIN_DRIVER_OHMS;
    driver.off = true;
    if (pin.mode === PIN_MODE.OUTPUT) {
      driver.off = pin.openDrain && pin.value === 1;
      driver.volts = pin.value ? VCC : 0;
    } else if (pin.mode === PIN_MODE.PWM) {
      driver.off = false;
      driver.volts = pin.pwm && pin.pwm.duty > 0 ? VCC : 0;
    } else if (pin.mode === PIN_MODE.ANALOG_OUT) {
      driver.off = false;
      driver.ohms = DAC_OHMS;
      driver.volts = (pin.value / 1023) * VCC;
    }
    this.trackLevel(pin, pin.mode === PIN_MODE.OUTPUT && pin.value === 1);
    this.markDirty(driver);
  }

  pinMode(number, mode, pull, openDrain) {
    const pin = this.pin(number);
    if (!pin) return;
    pin.mode = mode;
    pin.pull = pull;
    pin.openDrain = openDrain;
    if (mode === PIN_MODE.INPUT) this.oneWireOn(pin, (entry) => entry.device.released(this.boardMicros));
    if (mode !== PIN_MODE.PWM) {
      pin.pwm = null;
      this.pwmPins.delete(number);
    }
    this.applyPin(pin);
  }

  pinWrite(number, value) {
    const pin = this.pin(number);
    if (!pin) return;
    pin.value = value;
    if (!value) this.oneWireOn(pin, (entry) => entry.device.pulled(this.boardMicros));
    this.applyPin(pin);
  }

  oneWireOn(pin, action) {
    for (const entry of this.oneWireDevices) {
      if (entry.node === pin.node && entry.ctx.powered('VDD', 'GND', 2.5)) action(entry);
    }
  }

  // The level at a pin right now, without running any timed events.
  pinLevel(number) {
    return this.volts(this.pin(number).node) > LOGIC_THRESHOLD ? 1 : 0;
  }

  pinRead(number) {
    this.tick();
    const pin = this.pin(number);
    if (!pin) return 0;
    let held = null;
    this.oneWireOn(pin, (entry) => {
      const reply = entry.device.takeReply();
      if (reply === 0) held = 0;
    });
    if (held === 0) return 0;
    // Read first: solving is what brings the diode and transistor states up to date.
    const level = this.volts(pin.node) > LOGIC_THRESHOLD ? 1 : 0;
    if (this.isFloating(pin.node)) {
      this.problem('warning', this.boardId, `${pin.name} is floating, so it reads randomly. Add a pull-up or pull-down.`);
      return this.random() < 0.5 ? 1 : 0;
    }
    return level;
  }

  adcRead(number) {
    this.tick();
    const pin = this.pin(number);
    if (!pin) return 0;
    const volts = this.volts(pin.node);
    if (this.isFloating(pin.node)) return Math.floor(this.random() * 4096);
    return Math.max(0, Math.min(4095, Math.round((volts / VCC) * 4095)));
  }

  dacWrite(number, value) {
    const pin = this.pin(number);
    if (!pin) return;
    pin.value = value;
    this.applyPin(pin);
  }

  pwmSet(number, frequency, duty) {
    const pin = this.pin(number);
    if (!pin) return;
    pin.pwm = { frequency, duty: duty / 65535 };
    this.pwmPins.set(number, pin);
    this.applyPin(pin);
  }

  // A node is floating when nothing connects it to a rail or a driven source.
  isFloating(start) {
    if (start <= 0) return false;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.pop();
      for (const { to, element } of this.neighbors.get(node) ?? []) {
        if (!this.conducts(element)) continue;
        if (element.kind === 'source' || to <= 0) return false;
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return true;
  }

  conducts(element) {
    switch (element.kind) {
      case 'resistor': return true;
      case 'switch': return element.closed;
      case 'source': return !element.off;
      case 'diode': return element.on;
      case 'npn': return element.state !== 'off';
      case 'nmos': return element.on;
      default: return false;
    }
  }

  // Walks wires and resistors from a node, and through links such as transistor bases.
  findPin(start, accept) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift();
      for (const pin of this.pins.values()) {
        if (pin.node === node && accept(pin)) return pin;
      }
      const next = [...(this.links.get(node) ?? [])];
      for (const { to, element } of this.neighbors.get(node) ?? []) {
        if (element.kind === 'resistor' || (element.kind === 'switch' && element.closed)) next.push(to);
      }
      for (const to of next) {
        if (to > 0 && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return null;
  }

  pwmReaching(node) {
    if (this.pwmPins.size === 0) return null;
    const pin = this.findPin(node, (candidate) => candidate.pwm !== null);
    return pin ? pin.pwm : null;
  }

  dutyReaching(node) {
    const pin = this.findPin(node, (candidate) => candidate.duty !== null);
    return pin ? pin.duty : null;
  }

  // `pin` says where on the part the trouble is, when that matters. A large part such as the board
  // would otherwise show it in the wrong place.
  problem(severity, part, message, pin) {
    this.problems.set(`${part}:${message}`, { severity, part, message, pin, at: this.now() });
  }

  // --- Runtime controls from the UI ---

  setControl(partId, control, value) {
    const entry = this.parts.get(partId);
    if (!entry || entry.context.controls[control] === value) return;
    entry.context.controls[control] = value;
    entry.model.onControl?.(entry.context, control, value);
  }

  // --- Publishing ---

  // Lets parts whose outputs track their inputs catch up, so measurements see the result. Solves
  // directly because while sampling these are trial levels that watchers must not react to.
  followInputs() {
    for (const part of this.parts.values()) part.model.follow?.(part.context);
    for (const group of this.groups) if (group.dirty) group.solver.solve();
  }

  // Solves with every fast-toggling pin high, then low, so parts can show a time-weighted average.
  sampleToggling(toggling) {
    const sample = (phase) => {
      this.followInputs();
      for (const part of this.parts.values()) part.model.sample?.(part.context, phase);
    };
    const set = (volts) => {
      for (const pin of toggling) {
        pin.driver.volts = volts;
        pin.driver.off = false;
        if (pin.driver.group) pin.driver.group.solver.solve();
      }
    };
    this.sampling = true;
    set(VCC);
    sample('high');
    set(0);
    sample('low');
    for (const pin of toggling) this.applyPin(pin);
    // Back to the real pin levels before any watcher can see a trial level.
    this.followInputs();
    this.sampling = false;
  }

  measureDuty(now) {
    const span = Math.max(1, now - this.lastFrame);
    const toggling = [];
    for (const pin of this.pins.values()) {
      pin.duty = null;
      if (pin.mode === PIN_MODE.PWM && pin.pwm && pin.pwm.duty > 0 && pin.pwm.duty < 1) {
        pin.duty = pin.pwm.duty;
      } else if (pin.mode === PIN_MODE.OUTPUT && pin.transitions >= 2) {
        const open = pin.lastHigh ? now - pin.changedAt : 0;
        pin.duty = Math.min(1, (pin.highMs + open) / span);
      }
      pin.highMs = 0;
      pin.transitions = 0;
      pin.changedAt = now;
      if (pin.duty !== null) toggling.push(pin);
    }
    return toggling;
  }

  checkPinVolts() {
    for (const pin of this.pins.values()) {
      const voltage = this.volts(pin.node);
      if (voltage > PIN_MAX_VOLTS) {
        this.problem('error', this.boardId, `${pin.name} sees ${voltage.toFixed(1)}V. Metro pins only tolerate 3.3V.`, pin.name);
      }
    }
  }

  checkPins() {
    this.checkPinVolts();
    for (const pin of this.pins.values()) {
      if (!pin.driver.off) {
        const amps = Math.abs(pin.driver.group.solver.currentThrough(pin.driver));
        if (amps > PIN_MAX_AMPS) {
          this.problem('error', this.boardId, `${pin.name} is supplying ${(amps * 1000).toFixed(0)}mA, above its 10mA limit. Add a resistor or a transistor.`, pin.name);
        }
      }
    }
    if (this.shorted) this.problem('error', this.boardId, 'Short circuit: two power rails are wired together.');
    for (const [name, node] of [['3V', -1], ['5V', -2]]) {
      const amps = this.railAmps(node);
      if (amps > RAIL_MAX_AMPS) {
        this.problem('error', this.boardId, `The ${name} supply is delivering ${(amps * 1000).toFixed(0)}mA, above its 500mA limit. Look for a short circuit.`, name);
      }
    }
  }

  // Current leaving a fixed rail, through everything wired straight to it.
  railAmps(node) {
    let total = 0;
    for (const e of this.railElements) {
      if (e.kind === 'npn') {
        if (e.collector === node) total += e.collectorAmps;
        if (e.base === node) total += e.baseAmps;
        if (e.emitter === node) total -= e.collectorAmps + e.baseAmps;
      } else if (e.kind === 'nmos') {
        const { solver } = e.group;
        const amps = e.on ? (solver.v(e.drain) - solver.v(e.source)) / e.onOhms : 0;
        if (e.drain === node) total += amps;
        if (e.source === node) total -= amps;
      } else {
        const amps = e.group.solver.currentThrough(e);
        if (e.a === node) total += amps;
        if (e.b === node) total -= amps;
      }
    }
    return total;
  }

  // Warns about parts used outside their ratings, which on a real bench would damage them.
  checkParts() {
    for (const { part, context, model } of this.parts.values()) {
      const limit = SUPPLY_LIMITS[part.type];
      if (limit) {
        const [positive, negative, maximum] = limit;
        const volts = context.difference(positive, negative);
        const { name } = definition(part.type);
        if (volts > maximum) {
          context.problem('error', `${name} has ${volts.toFixed(1)}V on ${positive}, above its ${maximum}V limit.`, positive);
        } else if (volts < -REVERSED_SUPPLY_VOLTS) {
          context.problem('error', `${name} is wired backwards: ${positive} and ${negative} are swapped.`, positive);
        }
      }
      model.check?.(context);
    }
  }

  frame(now) {
    const toggling = this.measureDuty(now);
    this.lastFrame = now;
    this.settleAll();
    if (toggling.length > 0) {
      this.sampleToggling(toggling);
      this.settleAll();
    } else {
      this.followInputs();
      this.settleAll();
      for (const part of this.parts.values()) {
        part.model.sample?.(part.context, 'high');
        part.model.sample?.(part.context, 'low');
      }
    }
    this.onboard.led = this.onboardLed.amps > 0.0001 ? 1 : 0;
    if (this.onboardDuty(toggling) !== null) this.onboard.led = this.onboardDuty(toggling);
    this.checkPins();
    this.checkParts();

    const views = {};
    for (const [id, entry] of this.parts) {
      const view = entry.model.view?.(entry.context);
      if (view === undefined) continue;
      const text = JSON.stringify(view);
      if (this.lastViews.get(id) !== text) {
        this.lastViews.set(id, text);
        views[id] = view;
      }
    }
    for (const [key, problem] of this.problems) {
      if (now - problem.at > 1000) this.problems.delete(key);
    }
    const problems = [...this.problems.values()].map(({ severity, part, message, pin }) => ({ severity, part, message, pin }));
    const boardText = JSON.stringify({ board: this.onboard, problems });
    if (Object.keys(views).length > 0 || boardText !== this.lastBoardText) {
      this.lastBoardText = boardText;
      this.post({ type: 'frame', views, board: this.onboard, problems });
    }
  }

  onboardDuty(toggling) {
    const pin = toggling.find((candidate) => candidate.number === BOARD_PINS.D13);
    return pin ? pin.duty : null;
  }

  // Parts on a bus, found by matching nets rather than by name.
  partsOnNets(pinA, nodeA, pinB, nodeB) {
    const found = [];
    for (const entry of this.parts.values()) {
      const { part } = entry;
      const pins = definition(part.type).pins;
      if (!pins.some((p) => p.id === pinA) || !pins.some((p) => p.id === pinB)) continue;
      if (this.nodeOf(part.id, pinA) === nodeA && this.nodeOf(part.id, pinB) === nodeB) found.push(entry);
    }
    return found;
  }

  i2cDevices() {
    const scl = this.pins.get(BOARD_PINS.SCL).node;
    const sda = this.pins.get(BOARD_PINS.SDA).node;
    return this.partsOnNets('SCL', scl, 'SDA', sda).filter((entry) => entry.model.i2c);
  }

  i2cDevice(address) {
    return this.i2cDevices().find((entry) => entry.model.i2c.address(entry.context) === address);
  }

  // The same test the real driver runs: pull both lines down weakly and see if they stay high.
  i2cPullups(sclNumber, sdaNumber) {
    const lines = [this.pin(sclNumber), this.pin(sdaNumber)].filter(Boolean);
    const saved = lines.map((pin) => ({ mode: pin.mode, pull: pin.pull }));
    for (const pin of lines) this.pinMode(pin.number, PIN_MODE.INPUT, PULL_DOWN, false);
    const high = lines.every((pin) => this.volts(pin.node) > LOGIC_THRESHOLD);
    lines.forEach((pin, i) => this.pinMode(pin.number, saved[i].mode, saved[i].pull, false));
    return high;
  }

  // Clocks bytes into every device on the bus. A data pin gets what MOSI sends, or what the device
  // before it in a chain shifts out. Anything else just sees the level already on the pin. No
  // part drives MISO yet, so reads get the idle high level.
  spiTransfer(clockNumber, data, mosiNumber) {
    const clock = this.pin(clockNumber);
    const reply = new Uint8Array(data.length).fill(0xff);
    if (!clock) return reply;
    const dataNode = ({ part, model }) => this.nodeOf(part.id, model.spi.dataPin);
    const waiting = [...this.parts.values()].filter(({ part, model }) => (
      model.spi && this.nodeOf(part.id, model.spi.clockPin) === clock.node));
    const feeds = new Map();
    const mosi = this.pin(mosiNumber);
    if (mosi) feeds.set(mosi.node, data);
    while (waiting.length > 0) {
      const fed = waiting.findIndex((entry) => feeds.has(dataNode(entry)));
      const [entry] = waiting.splice(Math.max(0, fed), 1);
      const { spi } = entry.model;
      const input = feeds.get(dataNode(entry))
        ?? new Uint8Array(data.length).fill(entry.context.level(spi.dataPin) ? 0xff : 0);
      const shiftedOut = spi.transfer(entry.context, input);
      if (spi.outPin) feeds.set(this.nodeOf(entry.part.id, spi.outPin), shiftedOut);
    }
    return reply;
  }

  neopixelWrite(number, data) {
    if (number === 30) {
      this.onboard.neopixel = [data[1] ?? 0, data[0] ?? 0, data[2] ?? 0];
      return;
    }
    const pin = this.pin(number);
    if (!pin) return;
    for (const entry of this.parts.values()) {
      if (entry.model.neopixel && this.nodeOf(entry.part.id, 'DIN') === pin.node) {
        entry.model.neopixel(entry.context, data);
      }
    }
  }

  touched(number) {
    const pin = this.pin(number);
    if (!pin) return false;
    for (const entry of this.parts.values()) {
      if (entry.part.type === 'touch-pad' && this.nodeOf(entry.part.id, 'PAD') === pin.node) {
        return !!entry.context.controls.pressed;
      }
    }
    return false;
  }
}

export { controlSlots };
