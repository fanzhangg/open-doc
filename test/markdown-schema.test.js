import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorParser, editorSerializer } from './milkdown.js';

test('editor: an image without a title survives parse and serialize', async () => {
  const parse = await editorParser();
  const serialize = await editorSerializer();
  for (const markdown of ['look ![alt text](a.png) here\n', '![](a.png)\n', 'look ![alt](a.png "A title") here\n']) {
    const doc = parse(markdown);
    let images = 0;
    doc.descendants((node) => { if (node.type.name === 'image') images += 1; });
    assert.equal(images, 1, markdown);
    assert.equal(serialize(doc), markdown);
  }
});

test('editor: a list made in the editor is tight; lists from the file keep their spacing', async () => {
  const parse = await editorParser();
  const serialize = await editorSerializer();
  // The bullet character is the page's stringify option, not the schema's.
  const write = (doc) => serialize(doc).replace(/^( *)\* /gm, '$1- ');
  const { schema } = parse('x\n').type;
  // What "- ", Tab, the toolbar and the "/" menu build: items with default
  // attrs. An item's spacing shows once it holds more than a paragraph.
  const item = (text, ...more) => schema.nodes.list_item.create(null, [schema.nodes.paragraph.create(null, schema.text(text)), ...more]);
  const list = (...items) => schema.nodes.bullet_list.create(null, items);
  const made = schema.nodes.doc.create(null, list(item('one', list(item('nested'))), item('two')));
  assert.equal(write(made), '- one\n  - nested\n- two\n');
  for (const markdown of ['- one\n  - nested\n- two\n', '- one\n\n  - nested\n\n- two\n', '- [ ] task\n- [x] done\n']) {
    assert.equal(write(parse(markdown)), markdown);
  }
});
