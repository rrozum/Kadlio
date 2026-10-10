import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { designElements, renderDesignElement } from '../shared/addons/design-elements/catalog.js';

test('element catalogue renders independent groups without executable or external SVG content', () => {
  assert.equal(designElements.length, 16);
  assert.equal(new Set(designElements.map(item => item.id)).size, designElements.length);
  for (const item of designElements) {
    const { document } = parseHTML(renderDesignElement(item.id, { blockId: `fixture-${item.id}` }));
    const root = document.querySelector('[data-block-type="element"]');
    assert.equal(root.dataset.elementId, item.id);
    assert.equal(root.dataset.blockId, `fixture-${item.id}`);
    const ids = [...document.querySelectorAll('[data-block-id]')].map(node => node.dataset.blockId);
    assert.equal(new Set(ids).size, ids.length, item.id);
    assert.equal(document.querySelectorAll('script,iframe,object,embed,foreignObject,use,defs').length, 0, item.id);
    for (const node of document.querySelectorAll('*')) {
      for (const attribute of node.attributes) {
        assert.ok(!/^on/i.test(attribute.name), item.id);
        assert.ok(!['href', 'xlink:href', 'src', 'id'].includes(attribute.name), item.id);
      }
    }
    for (const node of document.querySelectorAll('svg')) {
      assert.ok(node.getAttribute('viewBox'));
      assert.equal(node.getAttribute('width'), '100%');
      assert.equal(node.getAttribute('height'), '100%');
    }
  }
});

test('window and note text remains native, escaped and independently editable', () => {
  const payload = '</p><script>alert("x")</script><img src=x onerror=alert(1)> &';
  for (const id of ['browser-window', 'terminal-window', 'sticky-note']) {
    const { document } = parseHTML(renderDesignElement(id, { blockId: 'native-text', values: { title: payload, content: payload } }));
    assert.equal(document.querySelectorAll('script,img').length, 0);
    for (const key of ['title', 'content']) {
      const text = document.querySelector(`[data-block-id="native-text-${key}"]`);
      assert.equal(text.dataset.blockType, 'text');
      assert.equal(text.dataset.elementField, key);
      assert.equal(text.textContent, payload);
      assert.equal(text.closest('svg'), null);
    }
  }
});

test('renderer rejects CSS injection, executable identifiers and invalid scalar ranges', () => {
  assert.throws(() => renderDesignElement('unknown'), RangeError);
  assert.throws(() => renderDesignElement('arrow-right', { blockId: '" onclick="bad' }), TypeError);
  assert.throws(() => renderDesignElement('arrow-right', { values: [] }), TypeError);
  for (const color of ['red; background:url(https://example.com)', 'url(#arrow)', 'var(--injected)', '#fff', '<svg>']) {
    assert.throws(() => renderDesignElement('arrow-right', { values: { color } }), TypeError);
  }
  for (const stroke of [0, 13, Infinity, NaN, '4']) {
    assert.throws(() => renderDesignElement('arrow-right', { values: { stroke } }), RangeError);
  }
  for (const opacity of [0, 2, Infinity, '0.2']) {
    assert.throws(() => renderDesignElement('blob', { values: { opacity } }), RangeError);
  }
  assert.throws(() => renderDesignElement('sticky-note', { values: { fill: 'url(#external)' } }), TypeError);
  assert.throws(() => renderDesignElement('browser-window', { values: { title: {} } }), TypeError);
  assert.throws(() => renderDesignElement('terminal-window', { values: { content: 'x'.repeat(16001) } }), TypeError);
});

test('explicit colours and bounded stroke values are applied without shared SVG IDs', () => {
  const first = renderDesignElement('arrow-curved', { blockId: 'first-arrow', values: { color: '#aBc123', stroke: 7 } });
  const second = renderDesignElement('arrow-curved', { blockId: 'second-arrow' });
  const { document } = parseHTML(first + second);
  assert.ok(first.includes('color:#aBc123'));
  assert.equal(document.querySelector('svg').getAttribute('stroke-width'), '7');
  assert.equal(document.querySelectorAll('[id]').length, 0);
  assert.notEqual(document.querySelectorAll('[data-block-type="element"]')[0].dataset.blockId, document.querySelectorAll('[data-block-type="element"]')[1].dataset.blockId);
});
