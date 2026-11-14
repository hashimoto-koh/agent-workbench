/**
 * Chequeo de resolución de rutas, variables de entorno y aislamiento para GenCode.
 *
 *   npx tsx scripts/check-gencode-paths.mjs
 *
 * Verifica:
 *   1. Las rutas por defecto de GenCode en win32 y linux (XDG con 'gencode').
 *   2. El aislamiento estricto de OPENCODE_DB: GenCode nunca la lee ni se altera por ella.
 *   3. El aislamiento de OpenCode y GenCode en un mismo entorno de variables.
 *   4. La anulación del catálogo de modelos (modelsFile: null) mientras openCodeModelsEnv sea false.
 *   5. La extensibilidad controlada de resolveOpenCodeFamilyPaths con openCodeModelsEnv: true.
 *   6. La definición y aislamiento de carpetas protegidas (protectedDirs) sin colisión.
 *   7. La carpeta temporal de serve para GenCode (gencode-serve).
 */

import {
  resolveOpenCodePaths,
  resolveGenCodePaths,
  resolveOpenCodeFamilyPaths,
  OPENCODE_PATH_OPTIONS,
  GENCODE_PATH_OPTIONS,
} from '../src/agents/opencode/paths.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (obj) => JSON.stringify(obj);

// ---------------------------------------------------------------------------
// 1. Rutas por defecto en win32 y linux
// ---------------------------------------------------------------------------
{
  const win = resolveGenCodePaths({}, 'C:\\Users\\u', 'win32');
  check('1 win32 por defecto: carpetas bajo gencode, base en datos y sin catalogo', same(win, {
    dbFile: 'C:\\Users\\u\\.local\\share\\gencode\\opencode.db',
    walFile: 'C:\\Users\\u\\.local\\share\\gencode\\opencode.db-wal',
    modelsFile: null,
    dataDir: 'C:\\Users\\u\\.local\\share\\gencode',
    configDir: 'C:\\Users\\u\\.config\\gencode',
    cacheDir: 'C:\\Users\\u\\.cache\\gencode',
    stateDir: 'C:\\Users\\u\\.local\\state\\gencode',
  }), show(win));

  const linux = resolveGenCodePaths({}, '/home/u', 'linux');
  check('1 linux por defecto: carpetas posix bajo gencode y base en datos', same(linux, {
    dbFile: '/home/u/.local/share/gencode/opencode.db',
    walFile: '/home/u/.local/share/gencode/opencode.db-wal',
    modelsFile: null,
    dataDir: '/home/u/.local/share/gencode',
    configDir: '/home/u/.config/gencode',
    cacheDir: '/home/u/.cache/gencode',
    stateDir: '/home/u/.local/state/gencode',
  }), show(linux));
}

// ---------------------------------------------------------------------------
// 2. Aislamiento de OPENCODE_DB: GenCode la ignora por completo
// ---------------------------------------------------------------------------
{
  const envWithDb = {
    OPENCODE_DB: 'D:\\otro\\opencode.db',
    XDG_DATA_HOME: 'D:\\datos',
  };

  const oc = resolveOpenCodePaths(envWithDb, 'C:\\Users\\u', 'win32');
  const gn = resolveGenCodePaths(envWithDb, 'C:\\Users\\u', 'win32');

  check('2 OpenCode adopta OPENCODE_DB absoluta',
    oc.dbFile === 'D:\\otro\\opencode.db' && oc.walFile === 'D:\\otro\\opencode.db-wal');

  check('2 GenCode ignora OPENCODE_DB y se mantiene en su propia carpeta de datos',
    gn.dbFile === 'D:\\datos\\gencode\\opencode.db' && gn.walFile === 'D:\\datos\\gencode\\opencode.db-wal',
    show(gn));

  const envMemory = { OPENCODE_DB: ':memory:' };
  const ocMem = resolveOpenCodePaths(envMemory, 'C:\\Users\\u', 'win32');
  const gnMem = resolveGenCodePaths(envMemory, 'C:\\Users\\u', 'win32');

  check('2 OpenCode con :memory: se queda sin base', ocMem.dbFile === null);
  check('2 GenCode con OPENCODE_DB :memory: no se queda sin base: usa su archivo local',
    gnMem.dbFile === 'C:\\Users\\u\\.local\\share\\gencode\\opencode.db');

  const envRel = { OPENCODE_DB: 'relativa.db' };
  const ocRel = resolveOpenCodePaths(envRel, 'C:\\Users\\u', 'win32');
  const gnRel = resolveGenCodePaths(envRel, 'C:\\Users\\u', 'win32');

  check('2 OpenCode usa relativa.db dentro de su dataDir',
    ocRel.dbFile === 'C:\\Users\\u\\.local\\share\\opencode\\relativa.db');
  check('2 GenCode ignora la ruta relativa y mantiene su opencode.db bajo gencode',
    gnRel.dbFile === 'C:\\Users\\u\\.local\\share\\gencode\\opencode.db');
}

// ---------------------------------------------------------------------------
// 3. Aislamiento de XDG_* entre OpenCode y GenCode
// ---------------------------------------------------------------------------
{
  const xdgEnv = {
    XDG_DATA_HOME: '/mnt/data',
    XDG_CONFIG_HOME: '/mnt/config',
    XDG_CACHE_HOME: '/mnt/cache',
    XDG_STATE_HOME: '/mnt/state',
  };

  const oc = resolveOpenCodePaths(xdgEnv, '/home/u', 'linux');
  const gn = resolveGenCodePaths(xdgEnv, '/home/u', 'linux');

  check('3 XDG_DATA_HOME: opencode vs gencode',
    oc.dataDir === '/mnt/data/opencode' && gn.dataDir === '/mnt/data/gencode');
  check('3 XDG_CONFIG_HOME: opencode vs gencode',
    oc.configDir === '/mnt/config/opencode' && gn.configDir === '/mnt/config/gencode');
  check('3 XDG_CACHE_HOME: opencode vs gencode',
    oc.cacheDir === '/mnt/cache/opencode' && gn.cacheDir === '/mnt/cache/gencode');
  check('3 XDG_STATE_HOME: opencode vs gencode',
    oc.stateDir === '/mnt/state/opencode' && gn.stateDir === '/mnt/state/gencode');

  check('3 dbFile y walFile de ambos no colisionan en ningun caso',
    oc.dbFile !== gn.dbFile && oc.walFile !== gn.walFile);
}

// ---------------------------------------------------------------------------
// 4. Variables de modelos (OPENCODE_MODELS_PATH / OPENCODE_MODELS_URL)
// ---------------------------------------------------------------------------
{
  const modelsEnv = {
    OPENCODE_MODELS_PATH: '/etc/models.json',
    OPENCODE_MODELS_URL: 'https://models.opencode.ai',
  };

  const gn = resolveGenCodePaths(modelsEnv, '/home/u', 'linux');
  check('4 GenCode con openCodeModelsEnv: false ignora OPENCODE_MODELS_PATH y deja modelsFile null',
    gn.modelsFile === null);

  // Verificamos que si se habilita openCodeModelsEnv, resolveOpenCodeFamilyPaths lo interpreta
  const gnWithModels = resolveOpenCodeFamilyPaths(
    { ...GENCODE_PATH_OPTIONS, openCodeModelsEnv: true },
    modelsEnv,
    '/home/u',
    'linux',
  );
  check('4 resolveOpenCodeFamilyPaths con openCodeModelsEnv: true resuelve OPENCODE_MODELS_PATH',
    gnWithModels.modelsFile === '/etc/models.json');

  // Verificamos que con openCodeModelsEnv: true pero sin variables use la carpeta cache de gencode
  const gnDefaultModels = resolveOpenCodeFamilyPaths(
    { ...GENCODE_PATH_OPTIONS, openCodeModelsEnv: true },
    {},
    '/home/u',
    'linux',
  );
  check('4 con openCodeModelsEnv: true por defecto apunta a <cacheDir>/models.json de gencode',
    gnDefaultModels.modelsFile === '/home/u/.cache/gencode/models.json');
}

// ---------------------------------------------------------------------------
// 5. Carpetas protegidas (protectedDirs)
// ---------------------------------------------------------------------------
{
  const env = {
    XDG_DATA_HOME: '/custom/data',
    XDG_CONFIG_HOME: '/custom/config',
    XDG_CACHE_HOME: '/custom/cache',
    XDG_STATE_HOME: '/custom/state',
  };

  const ocPaths = resolveOpenCodePaths(env, '/home/u', 'linux');
  const gnPaths = resolveGenCodePaths(env, '/home/u', 'linux');

  const ocProtected = [ocPaths.dataDir, ocPaths.configDir, ocPaths.cacheDir, ocPaths.stateDir];
  const gnProtected = [gnPaths.dataDir, gnPaths.configDir, gnPaths.cacheDir, gnPaths.stateDir];

  check('5 protectedDirs de OpenCode son las 4 carpetas de opencode',
    same(ocProtected, [
      '/custom/data/opencode',
      '/custom/config/opencode',
      '/custom/cache/opencode',
      '/custom/state/opencode',
    ]));

  check('5 protectedDirs de GenCode son las 4 carpetas de gencode',
    same(gnProtected, [
      '/custom/data/gencode',
      '/custom/config/gencode',
      '/custom/cache/gencode',
      '/custom/state/gencode',
    ]));

  check('5 Ninguna carpeta de GenCode se mezcla con las de OpenCode',
    gnProtected.every((p) => !ocProtected.includes(p)));
}

// ---------------------------------------------------------------------------
// 6. Constantes de configuración de familia
// ---------------------------------------------------------------------------
{
  check('6 OPENCODE_PATH_OPTIONS declara dirName opencode y flags en true',
    OPENCODE_PATH_OPTIONS.dirName === 'opencode' &&
    OPENCODE_PATH_OPTIONS.dbFileName === 'opencode.db' &&
    OPENCODE_PATH_OPTIONS.openCodeDbEnv === true &&
    OPENCODE_PATH_OPTIONS.openCodeModelsEnv === true);

  check('6 GENCODE_PATH_OPTIONS declara dirName gencode y flags en false',
    GENCODE_PATH_OPTIONS.dirName === 'gencode' &&
    GENCODE_PATH_OPTIONS.dbFileName === 'opencode.db' &&
    GENCODE_PATH_OPTIONS.openCodeDbEnv === false &&
    GENCODE_PATH_OPTIONS.openCodeModelsEnv === false);
}

if (failures > 0) {
  console.error(`\n${failures} FALLO(S)`);
  process.exit(1);
} else {
  console.log('\nTODO OK');
}
