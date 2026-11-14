/**
 * Donde guarda OpenCode lo que esta app lee.
 *
 * Segun el binario de la 1.18.30 (cadenas de `opencode.exe`, sin lanzarlo):
 *
 *  - Carpetas con xdg-basedir, en todas las plataformas: datos en
 *    `XDG_DATA_HOME` o `~/.local/share`, configuracion en `XDG_CONFIG_HOME` o
 *    `~/.config`, estado en `XDG_STATE_HOME` o `~/.local/state`, cache en
 *    `XDG_CACHE_HOME` o `~/.cache`; a todas se les suma `opencode`.
 *  - La base: `OPENCODE_DB` absoluta, tal cual; relativa, dentro de la carpeta
 *    de datos; `:memory:`, en memoria (no hay nada que leer). Sin la variable,
 *    `<datos>/opencode.db`.
 *  - El catalogo de modelos: `OPENCODE_MODELS_PATH`, o `<cache>/models.json`.
 *    Con `OPENCODE_MODELS_URL` el archivo pasa a llamarse `models-<hash>.json`,
 *    y ese hash no se reproduce: ahi no hay catalogo.
 *
 * Una variable vacia cuenta como ausente.
 *
 * Deuda declarada: con un canal distinto de `latest`, `beta` o `prod` la CLI
 * usa `opencode-<canal>.db`, y eso no se busca.
 *
 * **Una carpeta relativa no se lee** (igual que `CODEX_HOME`, §10.9): OpenCode
 * la resuelve contra el `cwd` de su pty y esta app contra el del servidor, que
 * serian dos archivos distintos con el mismo nombre.
 */

import path from 'node:path';

export interface OpenCodePaths {
  /** null si `OPENCODE_DB` es `:memory:`, o si la ruta depende del `cwd` de alguien. */
  dbFile: string | null;
  /** `dbFile` + `-wal`. */
  walFile: string | null;
  /** null si `OPENCODE_MODELS_URL` esta y `OPENCODE_MODELS_PATH` no, o si el soporte de modelos esta deshabilitado. */
  modelsFile: string | null;
  dataDir: string;
  configDir: string;
  cacheDir: string;
  stateDir: string;
}

export interface OpenCodeFamilyPathOptions {
  dirName: string;
  dbFileName: string;
  modelsFileName: string;
  openCodeDbEnv: boolean;
  openCodeModelsEnv: boolean;
}

export const OPENCODE_PATH_OPTIONS: OpenCodeFamilyPathOptions = {
  dirName: 'opencode',
  dbFileName: 'opencode.db',
  modelsFileName: 'models.json',
  openCodeDbEnv: true,
  openCodeModelsEnv: true,
};

export const GENCODE_PATH_OPTIONS: OpenCodeFamilyPathOptions = {
  dirName: 'gencode',
  dbFileName: 'opencode.db',
  modelsFileName: 'models.json',
  openCodeDbEnv: false,
  openCodeModelsEnv: false,
};

/**
 * true si la ruta no depende del `cwd` de nadie. En Windows `\\x` es absoluta
 * pero cuelga de la unidad actual: se exige unidad o UNC.
 */
function isFullyQualified(candidate: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^([a-zA-Z]:[\\/]|[\\/]{2})/.test(candidate);
  return path.posix.isAbsolute(candidate);
}

export function resolveOpenCodeFamilyPaths(
  options: OpenCodeFamilyPathOptions,
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): OpenCodePaths {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  const variable = (name: string): string | null => {
    const value = env[name];
    return value === undefined || value.length === 0 ? null : value;
  };
  const folder = (name: string, ...fallback: string[]): string =>
    flavor.join(variable(name) ?? flavor.join(home, ...fallback), options.dirName);

  const dataDir = folder('XDG_DATA_HOME', '.local', 'share');
  const configDir = folder('XDG_CONFIG_HOME', '.config');
  const cacheDir = folder('XDG_CACHE_HOME', '.cache');
  const stateDir = folder('XDG_STATE_HOME', '.local', 'state');

  const inData = (name: string): string | null =>
    isFullyQualified(dataDir, platform) ? flavor.join(dataDir, name) : null;

  let dbFile: string | null;
  if (options.openCodeDbEnv) {
    const configuredDb = variable('OPENCODE_DB');
    if (configuredDb === null) dbFile = inData(options.dbFileName);
    else if (configuredDb === ':memory:') dbFile = null;
    else if (isFullyQualified(configuredDb, platform)) dbFile = configuredDb;
    else if (flavor.isAbsolute(configuredDb)) dbFile = null;
    else dbFile = inData(configuredDb);
  } else {
    dbFile = inData(options.dbFileName);
  }

  let modelsFile: string | null;
  if (options.openCodeModelsEnv) {
    const modelsPath = variable('OPENCODE_MODELS_PATH');
    if (modelsPath !== null) modelsFile = isFullyQualified(modelsPath, platform) ? modelsPath : null;
    else if (variable('OPENCODE_MODELS_URL') !== null) modelsFile = null;
    else modelsFile = isFullyQualified(cacheDir, platform) ? flavor.join(cacheDir, options.modelsFileName) : null;
  } else {
    modelsFile = null;
  }

  return {
    dbFile,
    walFile: dbFile === null ? null : `${dbFile}-wal`,
    modelsFile,
    dataDir,
    configDir,
    cacheDir,
    stateDir,
  };
}

export function resolveOpenCodePaths(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): OpenCodePaths {
  return resolveOpenCodeFamilyPaths(OPENCODE_PATH_OPTIONS, env, home, platform);
}

export function resolveGenCodePaths(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): OpenCodePaths {
  return resolveOpenCodeFamilyPaths(GENCODE_PATH_OPTIONS, env, home, platform);
}
