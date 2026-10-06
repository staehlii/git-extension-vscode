import * as assert from 'assert';
import { ChangelistModel, DEFAULT_CHANGELIST_NAME } from '../../src/commit/changelistModel';

describe('ChangelistModel', () => {
  it('starts with one active default list', () => {
    const m = new ChangelistModel();
    assert.strictEqual(m.all.length, 1);
    assert.strictEqual(m.active.name, DEFAULT_CHANGELIST_NAME);
  });

  it('assigns new paths to the active list and forgets clean paths', () => {
    const m = new ChangelistModel();
    const bug = m.create('Bugfix');
    assert.deepStrictEqual(m.reconcile(['a', 'b']), ['a', 'b']);
    m.setActive(bug.id);
    assert.deepStrictEqual(m.reconcile(['a', 'b', 'c']), ['c']);
    assert.strictEqual(m.listOf('a'), m.all[0].id);
    assert.strictEqual(m.listOf('c'), bug.id);
    m.reconcile(['b']);
    assert.deepStrictEqual(Object.keys(m.toJSON().assignment), ['b']);
  });

  it('moves files and re-homes them when a list is deleted', () => {
    const m = new ChangelistModel();
    const def = m.active;
    const other = m.create('Other');
    m.reconcile(['x', 'y']);
    m.move(['y'], other.id);
    assert.strictEqual(m.listOf('y'), other.id);
    m.remove(other.id);
    assert.strictEqual(m.listOf('y'), def.id);
  });

  it('activates another list when the active one is deleted, and keeps at least one', () => {
    const m = new ChangelistModel();
    const first = m.active;
    const second = m.create('Second');
    m.setActive(second.id);
    m.remove(second.id);
    assert.strictEqual(m.active.id, first.id);
    assert.throws(() => m.remove(first.id), /last changelist/);
  });

  it('rejects duplicate and empty names', () => {
    const m = new ChangelistModel();
    assert.throws(() => m.create('changes'), /already exists/);
    assert.throws(() => m.create('  '), /empty/);
    const l = m.create('Feature');
    m.rename(l.id, 'Feature'); // same name is fine
    assert.throws(() => m.rename(l.id, 'Changes'), /already exists/);
  });

  it('round-trips through JSON and drops assignments to unknown lists', () => {
    const m = new ChangelistModel();
    const l = m.create('L');
    m.reconcile(['p']);
    m.move(['p'], l.id);
    const data = m.toJSON();
    data.assignment['ghost'] = 'missing-id';
    const copy = new ChangelistModel(data);
    assert.strictEqual(copy.listOf('p'), l.id);
    assert.strictEqual(copy.toJSON().assignment['ghost'], undefined);
  });
});
