import * as fs from 'fs';
import Mocha from 'mocha';
import * as path from 'path';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000, color: true });
  fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .sort() // suites build on each other's repository state, so run them in name order
    .forEach((f) => mocha.addFile(path.join(__dirname, f)));
  return new Promise((resolve, reject) =>
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve())),
  );
}
