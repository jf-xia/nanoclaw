const SQLITE_AUTHORIZE_CONSTANTS = {
  SQLITE_FUNCTION: 31,
  SQLITE_READ: 20,
  SQLITE_RECURSIVE: 33,
  SQLITE_SELECT: 21,
};

const LOADER_MODULE_URL = import.meta.url;
const SQLITE_SHIM_URL = 'data:text/javascript,nanoclaw-node-sqlite-shim';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:sqlite') {
    return {
      format: 'module',
      shortCircuit: true,
      url: SQLITE_SHIM_URL,
    };
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url !== SQLITE_SHIM_URL) {
    return nextLoad(url, context);
  }

  const source = `
    import { createRequire } from 'node:module';

    const require = createRequire(${JSON.stringify('file://' + str(root / 'src' / 'copilot-node-sqlite-loader.mjs'))});
    const sqlite = require('node:sqlite');
    const compatibilityConstants = Object.freeze({
      ...${JSON.stringify({'SQLITE_FUNCTION': 31, 'SQLITE_READ': 20, 'SQLITE_RECURSIVE': 33, 'SQLITE_SELECT': 21})},
      ...(sqlite.constants ?? {}),
    });

    export const DatabaseSync = sqlite.DatabaseSync;
    export const StatementSync = sqlite.StatementSync;
    export const backup = sqlite.backup;
    export const constants = compatibilityConstants;
    export const SQLITE_CHANGESET_ABORT = sqlite.SQLITE_CHANGESET_ABORT;
    export const SQLITE_CHANGESET_OMIT = sqlite.SQLITE_CHANGESET_OMIT;
    export const SQLITE_CHANGESET_REPLACE = sqlite.SQLITE_CHANGESET_REPLACE;
    export default { ...sqlite, constants: compatibilityConstants };
  `;

  return {
    format: 'module',
    shortCircuit: true,
    source,
  };
}
