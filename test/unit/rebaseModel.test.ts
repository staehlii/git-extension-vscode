import * as assert from 'assert';
import { buildTodo, shellQuote, validateEntries } from '../../src/rebase/rebaseModel';

describe('rebaseModel', () => {
  it('builds todo lines, rewording via exec', () => {
    const todo = buildTodo(
      [
        { sha: 'a1', action: 'pick' },
        { sha: 'b2', action: 'reword', message: 'New' },
        { sha: 'c3', action: 'squash' },
        { sha: 'd4', action: 'drop' },
      ],
      (i) => `/tmp/msg ${i}`,
    );
    assert.strictEqual(
      todo,
      "pick a1\npick b2\nexec git commit --amend --only --no-verify --allow-empty -F '/tmp/msg 1'\nsquash c3\ndrop d4\n",
    );
  });

  it('quotes shell arguments', () => {
    assert.strictEqual(shellQuote("it's"), `'it'\\''s'`);
  });

  it('validates plans', () => {
    assert.match(validateEntries([{ sha: 'a', action: 'drop' }])!, /At least one/);
    assert.match(validateEntries([{ sha: 'a', action: 'drop' }, { sha: 'b', action: 'fixup' }])!, /cannot be squashed/);
    assert.match(validateEntries([{ sha: 'a', action: 'reword', message: ' ' }])!, /Enter a new message/);
    assert.strictEqual(validateEntries([{ sha: 'a', action: 'pick' }, { sha: 'b', action: 'squash' }]), undefined);
  });
});
