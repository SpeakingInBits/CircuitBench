// Lets automated tests use the page the way a student does, through real DOM events.
const pointer = (type, target, position, extra = {}) => {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...position, ...extra,
  }));
};

// setPointerCapture needs a live pointer, which synthetic events do not have.
SVGElement.prototype.setPointerCapture = () => {};
HTMLCanvasElement.prototype.setPointerCapture = () => {};

const element = (id) => document.getElementById(id);
const until = async (condition, timeoutMs = 5000) => {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('Timed out waiting in the page');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Math.round(performance.now() - started);
};

export async function runTestStep(step, { state, toScreen, fit }) {
  const canvas = element('canvas');
  const at = (point) => {
    const position = toScreen(point);
    const target = document.elementFromPoint(position.clientX, position.clientY) ?? canvas;
    return { target, position };
  };
  const press = (point, extra) => {
    const { target, position } = at(point);
    pointer('pointerdown', target, position, extra);
    pointer('pointerup', target, position, extra);
  };

  switch (step.action) {
    case 'palette':
      document.querySelector(`[data-add="${step.type}"]`).click();
      return { id: state.selection[0]?.id };
    case 'move': {
      const part = state.doc.parts.find((p) => p.id === step.id);
      const from = { x: part.x + step.grab.x, y: part.y + step.grab.y };
      const start = at(from);
      pointer('pointerdown', start.target, start.position);
      const to = toScreen({ x: step.x + step.grab.x, y: step.y + step.grab.y });
      pointer('pointermove', canvas, to);
      pointer('pointerup', canvas, to);
      return { x: part.x, y: part.y };
    }
    case 'clickPoint':
      press(step.point, step.shift ? { shiftKey: true } : {});
      return { wires: state.doc.wires.length, wiring: !!state.wiring };
    case 'key':
      canvas.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, ctrlKey: !!step.ctrl, bubbles: true }));
      return { parts: state.doc.parts.length, wires: state.doc.wires.length };
    case 'click':
      document.querySelector(step.selector).click();
      return {};
    case 'select':
      element('details').querySelector(step.selector).value = step.value;
      element('details').querySelector(step.selector).dispatchEvent(new Event('change', { bubbles: true }));
      return {};
    case 'fit':
      fit();
      return {};
    case 'doc':
      return JSON.parse(JSON.stringify(state.doc));
    case 'pressPart': {
      const { target, position } = at(step.point);
      pointer('pointerdown', target, position);
      return { target: target.closest?.('[data-part]')?.dataset.part };
    }
    case 'press3d': {
      const surface = document.querySelector('#stage3d canvas');
      const box = surface.getBoundingClientRect();
      const position = step.id ? state.scene3d.screenPoint(step.id) : { clientX: box.left + 2, clientY: box.top + 2 };
      pointer('pointerdown', surface, position);
      return { selection: state.selection, held: state.held.size };
    }
    case 'release3d': {
      pointer('pointerup', document.querySelector('#stage3d canvas'), { clientX: 0, clientY: 0 });
      return { held: state.held.size };
    }
    case 'release': {
      pointer('pointerup', canvas, { clientX: 0, clientY: 0 });
      return {};
    }
    case 'slider': {
      const input = document.querySelector(`[data-slider="${step.key}"]`);
      input.value = String(step.value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return {};
    }
    case 'waitConsole': {
      const ms = await until(() => element('console').textContent.includes(step.text), step.timeoutMs ?? 8000);
      return { ms };
    }
    case 'waitView': {
      const ms = await until(() => {
        const view = state.views[step.id];
        return view && step.equals.every(([key, value]) => JSON.stringify(view[key]) === JSON.stringify(value));
      }, step.timeoutMs ?? 5000);
      return { ms, view: state.views[step.id] };
    }
    case 'waitBoard': {
      const ms = await until(() => (state.board?.led ?? 0) > 0 === step.led);
      return { ms };
    }
    case 'waitRunning': {
      await until(() => state.running === step.running);
      return {};
    }
    case 'read':
      return {
        console: element('console').textContent.slice(-600),
        consoleLinks: [...document.querySelectorAll('#console .trace-link')].map((link) => link.textContent),
        libraryHint: element('library-hint').hidden ? null : element('add-library').textContent,
        views: state.views,
        board: state.board,
        problems: state.problems,
        codeProblems: state.codeProblems,
        selection: state.selection,
        smoke: document.querySelectorAll('#layer-status .smoke').length,
        idle: [...document.querySelectorAll('.part.idle')].map((element) => element.dataset.part),
        running: state.running,
        loadError: state.loadError,
        controlValues: state.controlValues,
        view3d: state.scene3d?.info() ?? null,
        diagram: state.diagram?.info() ?? null,
        sliders: Object.fromEntries([...document.querySelectorAll('[data-slider]')].map((input) => [input.dataset.slider, input.value])),
        crossOriginIsolated: self.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer,
      };
    default:
      throw new Error(`Unknown test step ${step.action}`);
  }
}
