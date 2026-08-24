/* マルチプレイチャット Enter 操作の回帰テスト
   実バグ: 空 Enter 後に open=true のまま入力欄へフォーカスが戻らず、
   以降 Enter でもチャットを開けなくなる */
import assert from 'node:assert/strict';

function makeKey(type, key, { repeat = false } = {}) {
  const e = {
    key,
    repeat,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
  return e;
}

function installDom() {
  const bodyClasses = new Set(['playing']);
  const capture = new Map();
  const listeners = new Map();

  const body = {
    classList: {
      contains: (c) => bodyClasses.has(c),
      add: (c) => bodyClasses.add(c),
      remove: (c) => bodyClasses.delete(c),
    },
  };

  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      id: '',
      innerHTML: '',
      children: [],
      style: {},
      value: '',
      classList: {
        _s: new Set(),
        add: function (c) { this._s.add(c); },
        remove: function (c) { this._s.delete(c); },
        contains: function (c) { return this._s.has(c); },
      },
      appendChild(child) { this.children.push(child); child.parentElement = this; },
      remove() {},
      querySelector(sel) {
        if (sel === '.chat-log') return this._chatLog;
        if (sel === 'input') return this._input;
        return null;
      },
      addEventListener(type, fn) {
        const list = listeners.get(el) || [];
        list.push({ type, fn });
        listeners.set(el, list);
      },
      focus() { document._active = el; },
      blur() { if (document._active === el) document._active = body; },
    };
    return el;
  }

  const head = { appendChild() {} };
  const hud = makeEl('div');
  hud.id = 'hud';

  const document = {
    body,
    _active: body,
    get activeElement() { return this._active; },
    pointerLockElement: null,
    exitPointerLock() { this.pointerLockElement = null; },
    head,
    createElement(tag) {
      const el = makeEl(tag);
      if (tag === 'div') {
        el._chatLog = makeEl('div');
        el._input = makeEl('input');
        el._chatLog.className = 'chat-log';
        el.appendChild(el._chatLog);
        const entry = makeEl('div');
        entry.className = 'chat-entry';
        entry.appendChild(el._input);
        el.appendChild(entry);
      }
      return el;
    },
    getElementById(id) { return id === 'hud' ? hud : null; },
  };

  const window = {
    addEventListener(type, fn, useCapture) {
      if (type === 'keydown' && useCapture) capture.set('keydown', fn);
    },
    removeEventListener() {},
  };

  globalThis.document = document;
  globalThis.window = window;
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };

  return {
    fireEnter(repeat = false) {
      const fn = capture.get('keydown');
      assert.ok(fn, 'capture keydown listener missing');
      fn(makeKey('keydown', 'Enter', { repeat }));
    },
    fireEscape() {
      capture.get('keydown')(makeKey('keydown', 'Escape'));
    },
    document,
  };
}

const dom = installDom();
const { RoomChat } = await import('../src/multiplayer/chat.js');

const sent = [];
const chat = new RoomChat({ sendChat: (text) => sent.push(text) });

function assertClosed(label) {
  assert.equal(chat.open, false, `${label}: chat should be closed`);
  assert.equal(chat.root.classList.contains('typing'), false, `${label}: typing class should be removed`);
  assert.equal(chat.input.value, '', `${label}: input should be cleared`);
}

function assertOpen(label) {
  assert.equal(chat.open, true, `${label}: chat should be open`);
  assert.equal(chat.root.classList.contains('typing'), true, `${label}: typing class should be present`);
  assert.equal(document.activeElement, chat.input, `${label}: input should be focused`);
}

/* open -> empty Enter -> closed */
dom.fireEnter();
assertOpen('after first Enter');
dom.fireEnter();
assertClosed('after empty Enter');

/* reopen after empty submit */
dom.fireEnter();
assertOpen('reopen after empty Enter');

/* send message -> closed -> reopen */
chat.input.value = 'hello';
dom.fireEnter();
assertClosed('after message Enter');
assert.deepEqual(sent, ['hello'], 'message should be sent once');
dom.fireEnter();
assertOpen('reopen after message');

/* open with focus elsewhere still closes on Enter (stuck-open regression) */
chat.input.blur();
assert.equal(chat.open, true, 'precondition: chat still marked open');
assert.notEqual(document.activeElement, chat.input, 'precondition: input not focused');
dom.fireEnter();
assertClosed('Enter while open but unfocused');

/* Escape closes even without input focus */
dom.fireEnter();
chat.input.blur();
dom.fireEscape();
assertClosed('Escape while open but unfocused');

console.log('OK multiplayer chat Enter/Escape open-close cycle');
