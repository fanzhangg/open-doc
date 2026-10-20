import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIndent } from '../web/plugins/plain/indent.js';

test('detectIndent: tabs, the usual step of spaces, or nothing', () => {
  assert.deepEqual(detectIndent('a\n\tb\n\t\tc\n'), { tabs: true });
  assert.deepEqual(detectIndent('a\n  b\n    c\n  d\ne\n'), { tabs: false, size: 2 });
  assert.deepEqual(detectIndent('a\n    b\n        c\n    d\n'), { tabs: false, size: 4 });
  assert.deepEqual(detectIndent('a\n\n  b\n\n\n  c\n'), { tabs: false, size: 2 }, 'blank lines do not count');
  assert.equal(detectIndent('a\nb\n'), null);
  assert.equal(detectIndent(''), null);
});
