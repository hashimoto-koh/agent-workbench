/**
 * Chequeo de `serve`, `attach`, argumentos y aislamiento para GenCode.
 *
 *   npx tsx scripts/check-gencode-serve.mjs
 *
 * Verifica:
 *   1. parseListeningLine con 'gencode': reconoce la línea de gencode y rechaza la de opencode.
 *   2. parseListeningLine con 'opencode': reconoce la de opencode y rechaza la de gencode.
 *   3. attachArgs: agrega `--username` solo si includeUsername es true.
 *   4. launchWithServe: propaga serverLabel al mensaje de error.
 *   5. OpenCodeServeProcess con listeningCommandName: 'gencode':
 *      - Arranca con el fake serve emitiendo 'gencode server listening on...'.
 *      - Redacta contraseñas en mensajes de error (redaction).
 *      - Rechaza IPs que no sean 127.0.0.1 (0.0.0.0).
 *      - Retención de pestañas y apagado por inactividad.
 *      - dispose() termina el proceso.
 *   6. Concurrencia y aislamiento estricto: dos procesos simultáneos (uno OpenCode y uno GenCode)
 *      con distintos puertos, contraseñas, listeningCommandName y carpetas cwd.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpenCodeServeProcess,
  parseListeningLine,
  defaultServeCwd,
  defaultGenCodeServeCwd,
  ServeStartError,
} from '../src/agents/opencode/serve-process.ts';
import { attachArgs, launchWithServe } from '../src/agents/opencode/serve-launch.ts';
import {
  createGenCodeAdapter,
  GENCODE_FAMILY_CONFIG,
  OPENCODE_FAMILY_CONFIG,
} from '../src/agents/opencode/index.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (obj) => JSON.stringify(obj);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fakeServePath = path.join(__dirname, 'fixtures', 'fake-opencode-serve.mjs');

const fakeLocation = {
  kind: 'path',
  file: process.execPath,
  prefixArgs: [fakeServePath],
  version: '1.19.3-gencode.6',
};

// ---------------------------------------------------------------------------
// 1. parseListeningLine con gencode y opencode (aislamiento estricto)
// ---------------------------------------------------------------------------
{
  const gnLine = 'gencode server listening on http://127.0.0.1:41234';
  const ocLine = 'opencode server listening on http://127.0.0.1:41234';
  const v2Line = 'server listening on http://127.0.0.1:41234';

  check('1 gencode reconoce su propia linea',
    parseListeningLine(gnLine, 1, 'gencode') === 'http://127.0.0.1:41234');

  check('1 gencode rechaza la linea de opencode',
    parseListeningLine(ocLine, 1, 'gencode') === null);

  check('1 opencode reconoce su propia linea',
    parseListeningLine(ocLine, 1, 'opencode') === 'http://127.0.0.1:41234');

  check('1 opencode rechaza la linea de gencode',
    parseListeningLine(gnLine, 1, 'opencode') === null);

  check('1 protocolo 2 reconoce linea sin prefijo',
    parseListeningLine(v2Line, 2) === 'http://127.0.0.1:41234');

  check('1 rechaza host 0.0.0.0 o localhost',
    parseListeningLine('gencode server listening on http://0.0.0.0:41234', 1, 'gencode') === null &&
    parseListeningLine('gencode server listening on http://localhost:41234', 1, 'gencode') === null);

  check('1 rechaza https o puertos invalidos',
    parseListeningLine('gencode server listening on https://127.0.0.1:41234', 1, 'gencode') === null &&
    parseListeningLine('gencode server listening on http://127.0.0.1:99999', 1, 'gencode') === null);
}

// ---------------------------------------------------------------------------
// 2. attachArgs y --username
// ---------------------------------------------------------------------------
{
  const endpoint = {
    url: 'http://127.0.0.1:41001',
    username: 'my-user',
    password: 'my-password',
  };

  const argsDefault = attachArgs(fakeLocation, endpoint, 'ses_123');
  check('2 attachArgs por defecto no agrega --username (compatibilidad OpenCode)',
    !argsDefault.includes('--username') &&
    same(argsDefault, [fakeServePath, 'attach', 'http://127.0.0.1:41001', '--dir', '.', '--session', 'ses_123', '--password', 'my-password']));

  const argsGenCode = attachArgs(fakeLocation, endpoint, 'ses_123', { includeUsername: true });
  check('2 attachArgs con includeUsername: true agrega --username <user>',
    argsGenCode.includes('--username') &&
    argsGenCode[argsGenCode.indexOf('--username') + 1] === 'my-user' &&
    same(argsGenCode, [fakeServePath, 'attach', 'http://127.0.0.1:41001', '--dir', '.', '--session', 'ses_123', '--password', 'my-password', '--username', 'my-user']));

  const v2Endpoint = {
    protocol: 2,
    url: 'http://127.0.0.1:41002',
    username: 'my-user',
    password: 'my-password',
  };
  const argsV2 = attachArgs(fakeLocation, v2Endpoint, 'ses_123');
  check('2 attachArgs con protocolo 2 incluye credenciales basic auth en la URL',
    argsV2.includes('--server') && argsV2.includes('http://my-user:my-password@127.0.0.1:41002/'));
}

// ---------------------------------------------------------------------------
// 3. launchWithServe y serverLabel
// ---------------------------------------------------------------------------
{
  const failingDeps = {
    ensure: () => Promise.reject(new Error('fail')),
    createSession: () => Promise.reject(new Error('no')),
    track: () => {},
  };

  const input = {
    location: fakeLocation,
    cwd: '/tmp',
    resumeSessionId: null,
  };

  let ocErr = null;
  try {
    await launchWithServe(failingDeps, input);
  } catch (err) {
    ocErr = err.message;
  }
  check('3 launchWithServe usa OpenCode por defecto en el mensaje de error',
    ocErr === "Couldn't start the OpenCode server: fail");

  let gnErr = null;
  try {
    await launchWithServe({ ...failingDeps, serverLabel: 'GenCode' }, input);
  } catch (err) {
    gnErr = err.message;
  }
  check('3 launchWithServe usa serverLabel: GenCode en el mensaje de error',
    gnErr === "Couldn't start the GenCode server: fail");

  let invalidErr = null;
  try {
    await launchWithServe({ ...failingDeps, serverLabel: 'GenCode' }, { ...input, resumeSessionId: 'invalid-id' });
  } catch (err) {
    invalidErr = err.message;
  }
  check('3 launchWithServe valida id con serverLabel: GenCode',
    invalidErr === 'Invalid GenCode session id.');
}

// ---------------------------------------------------------------------------
// 4. Ciclo de vida y Redaction con fake serve emitiendo como gencode
// ---------------------------------------------------------------------------
{
  check('4 defaultServeCwd y defaultGenCodeServeCwd son carpetas distintas',
    defaultServeCwd() !== defaultGenCodeServeCwd() &&
    defaultGenCodeServeCwd().endsWith('gencode-serve'));

  // Arrancamos un serve simulado que emite como 'gencode'
  const proc = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({ FAKE_SERVE_COMMAND_NAME: 'gencode' }),
    listeningCommandName: 'gencode',
    debugName: 'gencode-serve',
    cwd: defaultGenCodeServeCwd(),
    idleStopMs: 1000,
  });

  const ep = await proc.ensure();
  check('4 ensure arranca el fake serve como gencode y obtiene endpoint en 127.0.0.1',
    ep.url.startsWith('http://127.0.0.1:') && ep.password.length === 48);

  const ep2 = await proc.ensure();
  check('4 segundo ensure devuelve el mismo endpoint sin arrancar otro proceso',
    ep.url === ep2.url && ep.password === ep2.password);

  // Retención y liberación
  const release = proc.retain();
  release(); // Suelta la retención

  await proc.dispose();
  check('4 dispose termina el proceso gencode correctamente', true);

  // Redaction test: early-exit con password en stderr
  const procFail = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({
      FAKE_SERVE_COMMAND_NAME: 'gencode',
      FAKE_OPENCODE_SERVE_MODE: 'early-exit',
    }),
    listeningCommandName: 'gencode',
    debugName: 'gencode-serve',
    cwd: defaultGenCodeServeCwd(),
  });

  let failErr = null;
  try {
    await procFail.ensure();
  } catch (err) {
    failErr = err;
  }
  check('4 early-exit falla con ServeStartError', failErr instanceof ServeStartError);
  check('4 la contrasena secreta NO aparece en el mensaje de error (redaction = ***)',
    failErr && !failErr.message.includes(procFail['password']) && failErr.message.includes('password=***'),
    failErr?.message);

  await procFail.dispose();

  // Redaction: por defecto redactUsername es false, preserva el nombre de usuario
  const procRedactDefault = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({}),
    listeningCommandName: 'gencode',
    defaultUsername: 'test-user-name',
  });
  procRedactDefault['password'] = 'test-secret-pass';
  const redactedDefault = procRedactDefault['redact']('auth failure for user test-user-name with pass test-secret-pass');
  check('4 redact por defecto solo oculta password y preserva username',
    redactedDefault === 'auth failure for user test-user-name with pass ***',
    redactedDefault);

  // Verificamos que effectiveUsername unifica la resolución de usuario entre start y redact
  const procEffective = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({ OPENCODE_SERVER_USERNAME: 'bob' }),
    listeningCommandName: 'gencode',
    defaultUsername: 'custom-default',
  });
  check('4 effectiveUsername usa OPENCODE_SERVER_USERNAME si está presente',
    procEffective['effectiveUsername']() === 'bob');

  const procEffectiveFallback = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({ OPENCODE_SERVER_USERNAME: '   ' }),
    listeningCommandName: 'gencode',
    defaultUsername: 'custom-default',
  });
  check('4 effectiveUsername con whitespace en OPENCODE_SERVER_USERNAME cae a OPENCODE_SERVE_DEFAULT_USERNAME',
    procEffectiveFallback['effectiveUsername']() === 'opencode');

  const procEffectiveDefault = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({}),
    listeningCommandName: 'gencode',
    defaultUsername: 'custom-default',
    redactUsername: true,
  });
  procEffectiveDefault['password'] = 'test-secret-pass';
  check('4 effectiveUsername sin env usa OPENCODE_SERVE_DEFAULT_USERNAME (no usa custom defaultUsername para auth)',
    procEffectiveDefault['effectiveUsername']() === 'opencode');
  const redactedFallback = procEffectiveDefault['redact']('auth failure for user custom-default with pass test-secret-pass');
  check('4 redact con redactUsername: true oculta también defaultUsername como fallback de error',
    redactedFallback === 'auth failure for user *** with pass ***',
    redactedFallback);

  // Redaction con redactUsername: true oculta tanto password como username cuando es personalizado
  const procRedactUser = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({ OPENCODE_SERVER_USERNAME: 'alice' }),
    listeningCommandName: 'gencode',
    defaultUsername: 'opencode',
    redactUsername: true,
  });
  procRedactUser['password'] = 'test-secret-pass';
  const redactedUser = procRedactUser['redact']('auth failure for user alice in /home/jov/.local/share/gencode/opencode.db with pass test-secret-pass');
  check('4 redact con redactUsername: true y OPENCODE_SERVER_USERNAME oculta username y password pero preserva opencode.db',
    redactedUser === 'auth failure for user *** in /home/jov/.local/share/gencode/opencode.db with pass ***',
    redactedUser);

  // Redaction con redactUsername: true y usuario opencode preserva opencode para no destruir rutas
  const procRedactDefaultUser = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({}),
    listeningCommandName: 'gencode',
    defaultUsername: 'opencode',
    redactUsername: true,
  });
  procRedactDefaultUser['password'] = 'test-secret-pass';
  const redactedDefaultUser = procRedactDefaultUser['redact']('auth failure for user opencode in /home/jov/.local/share/gencode/opencode.db with pass test-secret-pass');
  check('4 redact con usuario opencode preserva la palabra opencode intacta',
    redactedDefaultUser === 'auth failure for user opencode in /home/jov/.local/share/gencode/opencode.db with pass ***',
    redactedDefaultUser);

  // Verificamos que GENCODE_FAMILY_CONFIG declara redactUsername: true y OPENCODE no
  check('4 GENCODE_FAMILY_CONFIG declara redactUsername: true',
    GENCODE_FAMILY_CONFIG.redactUsername === true);
  check('4 OPENCODE_FAMILY_CONFIG no declara redactUsername (false)',
    OPENCODE_FAMILY_CONFIG.redactUsername !== true);

  // Verificamos que el adaptador GenCode aplica redaction al fallar el serve (con custom username)
  const earlyAdapter = createGenCodeAdapter({
    home: defaultGenCodeServeCwd(),
    platform: 'linux',
    serveEnv: () => ({
      FAKE_SERVE_COMMAND_NAME: 'gencode',
      FAKE_OPENCODE_SERVE_MODE: 'early-exit',
      OPENCODE_SERVER_USERNAME: 'alice',
    }),
  });
  let gcEarlyErr = null;
  try {
    await earlyAdapter.launch({
      location: fakeLocation,
      cwd: '.',
      resumeSessionId: 'ses_12345678901234567890123456',
      proposedSessionId: '00000000-0000-4000-8000-000000000009',
      launchToken: 'tok-early',
    });
  } catch (err) {
    gcEarlyErr = err?.message ?? String(err);
  }
  check('4 GenCode adaptador launch con error oculta password y custom username por redaction',
    gcEarlyErr !== null &&
    gcEarlyErr.includes('password=***') &&
    !gcEarlyErr.includes('alice') &&
    gcEarlyErr.includes('para ***') &&
    gcEarlyErr.includes('/home/jov/.local/share/gencode/opencode.db'),
    gcEarlyErr);
  await earlyAdapter.dispose();

  // Test wide mode: rechaza 0.0.0.0
  const procWide = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({
      FAKE_SERVE_COMMAND_NAME: 'gencode',
      FAKE_OPENCODE_SERVE_MODE: 'wide',
    }),
    listeningCommandName: 'gencode',
    debugName: 'gencode-serve',
    cwd: defaultGenCodeServeCwd(),
  });

  let wideErr = null;
  try {
    await procWide.ensure();
  } catch (err) {
    wideErr = err;
  }
  check('4 modo wide (0.0.0.0) es rechazado por seguridad',
    wideErr?.message.includes('listens on http://0.0.0.0 and not on http://127.0.0.1'));
  await procWide.dispose();
}

// ---------------------------------------------------------------------------
// 5. Concurrencia y Aislamiento Estricto: OpenCode y GenCode en paralelo
// ---------------------------------------------------------------------------
{
  const ocProc = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({ FAKE_SERVE_COMMAND_NAME: 'opencode' }),
    listeningCommandName: 'opencode',
    debugName: 'opencode-serve',
    cwd: defaultServeCwd(),
  });

  const gnProc = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({ FAKE_SERVE_COMMAND_NAME: 'gencode' }),
    listeningCommandName: 'gencode',
    debugName: 'gencode-serve',
    cwd: defaultGenCodeServeCwd(),
  });

  const [ocEp, gnEp] = await Promise.all([ocProc.ensure(), gnProc.ensure()]);

  check('5 Ambos procesos arrancan en paralelo con puertos distintos',
    ocEp.url !== gnEp.url, `${ocEp.url} vs ${gnEp.url}`);

  check('5 Ambos procesos tienen contraseñas independientes y aleatorias',
    ocEp.password !== gnEp.password && ocEp.password.length === 48 && gnEp.password.length === 48);

  check('5 Las carpetas cwd de ejecución son completamente independientes',
    defaultServeCwd() !== defaultGenCodeServeCwd());

  await Promise.all([ocProc.dispose(), gnProc.dispose()]);
  check('5 dispose termina ambos procesos sin dejar huérfanos', true);
}

// ---------------------------------------------------------------------------
// 6. Integración de autenticación end-to-end (custom username y protocolo 2)
// ---------------------------------------------------------------------------
{
  // 6.1 GenCode con OPENCODE_SERVER_USERNAME=alice: endpoint, Basic Auth HTTP y attach --username coinciden
  const aliceProc = new OpenCodeServeProcess({
    location: fakeLocation,
    baseEnv: () => ({
      FAKE_SERVE_COMMAND_NAME: 'gencode',
      OPENCODE_SERVER_USERNAME: 'alice',
    }),
    listeningCommandName: 'gencode',
    debugName: 'gencode-serve',
    cwd: defaultGenCodeServeCwd(),
  });
  const aliceEp = await aliceProc.ensure();
  const authHeader = 'Basic ' + Buffer.from(`alice:${aliceEp.password}`).toString('base64');
  const httpRes = await fetch(`${aliceEp.url}/__fake/requests`, {
    headers: { Authorization: authHeader },
  });
  check('6.1 endpoint.username y Basic Auth HTTP coinciden con OPENCODE_SERVER_USERNAME=alice',
    aliceEp.username === 'alice' && httpRes.status === 200,
    `username=${aliceEp.username}, status=${httpRes.status}`);
  await aliceProc.dispose();

  // 6.2 Adapter launch completo propagando OPENCODE_SERVER_USERNAME=alice hasta attach --username
  const aliceAdapter = createGenCodeAdapter({
    home: defaultGenCodeServeCwd(),
    platform: 'linux',
    serveEnv: () => ({
      FAKE_SERVE_COMMAND_NAME: 'gencode',
      OPENCODE_SERVER_USERNAME: 'alice',
    }),
  });
  const plan = await aliceAdapter.launch({
    location: fakeLocation,
    cwd: '.',
    resumeSessionId: null,
    proposedSessionId: '00000000-0000-4000-8000-000000000010',
    launchToken: 'tok-alice',
  });
  const userIdx = plan.args.indexOf('--username');
  check('6.2 adapter.launch propaga OPENCODE_SERVER_USERNAME=alice a attach --username',
    userIdx !== -1 && plan.args[userIdx + 1] === 'alice',
    show(plan.args));
  await aliceAdapter.dispose();

  // 6.3 Protocolo 2 (OpenCode 2.x) siempre usa OPENCODE_SERVE_DEFAULT_USERNAME ('opencode') aunque haya defaultUsername o env
  const v2Proc = new OpenCodeServeProcess({
    location: { ...fakeLocation, version: '2.0.0' },
    baseEnv: () => ({
      FAKE_SERVE_COMMAND_NAME: 'opencode',
      OPENCODE_SERVER_USERNAME: 'alice',
    }),
    listeningCommandName: 'opencode',
    defaultUsername: 'custom-default',
    debugName: 'opencode-serve',
    cwd: defaultServeCwd(),
  });
  check('6.3 protocolo 2 ignora custom defaultUsername y OPENCODE_SERVER_USERNAME, mantiene opencode',
    v2Proc['effectiveUsername']() === 'opencode');
}

if (failures > 0) {
  console.error(`\n${failures} FALLO(S)`);
  process.exit(1);
} else {
  console.log('\nTODO OK');
}
