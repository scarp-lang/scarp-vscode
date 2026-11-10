undefined
test('published alpha.6 tuple types and text/input built-ins highlight without false matches', async () => {
  const grammar = await tokenizer();
  const type = tokens('bind pair: tuple<integer, tuple<string, boolean>> = (7, ("ok", true));', grammar);
  assert.ok(hasScope(type, 'tuple', 'support.type.scarp'));
  const identifier = tokens('bind tuple = 7;', grammar);
  assert.ok(!hasScope(identifier, 'tuple', 'support.type.scarp'),
    'tuple is contextual and can be an ordinary identifier');
  for (const name of [
    'read_line', 'integer_to_text', 'float_to_text',
    'text_to_integer', 'text_to_float', 'text_trim', 'text_replace'
  ]) {
    const call = tokens('bind output = ' + name + '(value);', grammar);
    assert.ok(hasScope(call, name, 'support.function.builtin.scarp'), name);
    const longer = tokens('bind output = ' + name + '_other(value);', grammar);
    assert.ok(!hasScope(longer, name + '_other', 'support.function.builtin.scarp'));
    assert.ok(!hasScope(tokens('// ' + name + '(value)', grammar), name, 'support.function.builtin.scarp'));
    assert.ok(!hasScope(tokens('print("' + name + '(value)");', grammar), name, 'support.function.builtin.scarp'));
    assert.ok(hasScope(tokens('funcra ' + name + '() {', grammar), name,
      'entity.name.function.definition.scarp'));
  }
});
