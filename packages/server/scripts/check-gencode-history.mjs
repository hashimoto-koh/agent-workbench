/**
 * Chequeo de capacidades mínimas, aislamiento de historial e invariantes
 * de GenCode en la Fase 5.
 *
 *   npx tsx scripts/check-gencode-history.mjs
 *
 * Verifica:
 *   1. Capacidades mínimas de la Fase 5 (todo false/null excepto lectura de historial).
 *   2. Configuración de entrada (GENCODE_INPUT): imageReference null, transcriptReference 'quoted-path'.
 *   3. Bloqueo estricto de locate() y launch() en Fase 5 (historyOnly: true).
 *   4. startupHistoryNote con base existente, ausente, sqlite unavailable y note personalizada.
 *   5. protectedDirs apunta a las carpetas propias de gencode y no de opencode.
 *   6. Lectura aislada de historial con fixture sintético de GenCode (scan y follow).
 *   7. Coexistencia de OpenCode y GenCode con bases separadas sin interferencia.
 */

import assert from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGenCodeAdapter,
  createOpenCodeAdapter,
  createOpenCodeFamilyAdapter,
  GENCODE_FAMILY_CONFIG,
  GENCODE_CAPABILITIES,
  GENCODE_INPUT,
} from '../src/agents/opencode/index.ts';
import { createOpenCodeFixture, FIXTURE_PROJECT_ID, sessionRow } from './fixtures/opencode-db.mjs';
import { buildProjects, placeSessions, SessionIndex } from '../src/session-index.ts';
import { createAgentRegistry } from '../src/agents/registry.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (obj) => JSON.stringify(obj);

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aw-gencode-history-'));

try {
  // ---------------------------------------------------------------------------
  // 1. Capacidades mínimas y configuración de entrada (Fase 5)
  // ---------------------------------------------------------------------------
  {
    const adapter = createGenCodeAdapter({ home: tempDir, platform: 'linux' });

    check('1.1 id es gencode', adapter.id === 'gencode');
    check('1.2 label es GenCode', adapter.label === 'GenCode');
    check('1.3 command es gencode', adapter.command === 'gencode');
    check('1.4 installUrl apunta al sitio oficial', adapter.installUrl === 'https://www.genspark.ai');

    check('1.5 capabilities de Fase 6 con valores medidos', same(adapter.capabilities, {
      sessionIdAtLaunch: true,
      resume: true,
      statusSource: true,
      readySignal: false,
      permissionCycle: null,
      codexPermissions: false,
      models: null,
      efforts: null,
      questionCards: true,
      imagesByPath: 'bare-path-paste',
      fileMentions: null,
      rewind: false,
      contextWindowSource: null,
      plans: false,
      waitingBlocksSubmit: true,
      forceSend: false,
      editQueue: false,
      scheduledSend: true,
      codexNativeQueue: false,
      moveToWorktree: true,
      readOnlyLaunch: null,
    }), show(adapter.capabilities));

    check('1.6 input con imageReference bare-path-paste y quoted-path', same(adapter.input, {
      imageReference: 'bare-path-paste',
      pieceGapMs: 400,
      pasteMarkers: true,
      enterSeparately: true,
      interruptPresses: 2,
      transcriptReference: 'quoted-path',
    }), show(adapter.input));

    check('1.7 promptQueue desde session', same(adapter.promptQueue, { source: 'session', forceSend: null }));
    check('1.8 sessionMove definida en Fase 6', adapter.sessionMove !== undefined && typeof adapter.sessionMove.move === 'function');
    check('1.9 scheduled definida con kind api en Fase 6', adapter.scheduled !== undefined && adapter.scheduled.kind === 'api');

    await adapter.dispose();
  }

  // ---------------------------------------------------------------------------
  // 2. locate() y launch() activos en Fase 6 (historyOnly: false)
  // ---------------------------------------------------------------------------
  {
    const adapter = createGenCodeAdapter({ home: tempDir, platform: 'linux' });

    const located = await adapter.locate();
    check('2.1 locate encuentra gencode en PATH', located !== null && located.resolvedPath.endsWith('gencode'));

    const historyOnlyAdapter = createOpenCodeFamilyAdapter({
      ...GENCODE_FAMILY_CONFIG,
      historyOnly: true,
    }, { home: tempDir, platform: 'linux' });
    check('2.2 locate con historyOnly devuelve null', (await historyOnlyAdapter.locate()) === null);
    let rejected = false;
    try {
      await historyOnlyAdapter.launch({
        location: { resolvedPath: '/usr/bin/gencode', file: 'gencode', prefixArgs: [], version: '1.19.3' },
        cwd: tempDir,
        resumeSessionId: null,
        proposedSessionId: '00000000-0000-4000-8000-000000000001',
        launchToken: 'tok1',
      });
    } catch (e) {
      rejected = e instanceof Error && e.message.includes('GenCode launch is disabled in Phase 5');
    }
    check('2.3 launch con historyOnly rechaza con error explícito', rejected);

    await historyOnlyAdapter.dispose();

    // 2.4 launch activo con fake serve: arma attach con --username opencode y --session
    const fakeServePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-opencode-serve.mjs');
    const fakeLocation = {
      resolvedPath: process.execPath,
      file: process.execPath,
      prefixArgs: [fakeServePath],
      version: '1.19.3-gencode.6',
    };
    const activeAdapter = createGenCodeAdapter({
      home: tempDir,
      platform: 'linux',
      serveEnv: () => ({ ...process.env, FAKE_SERVE_COMMAND_NAME: 'gencode' }),
    });
    const validSessionId = 'ses_12345678901234567890123456';
    const launchPlan = await activeAdapter.launch({
      location: fakeLocation,
      cwd: tempDir,
      resumeSessionId: validSessionId,
      proposedSessionId: '00000000-0000-4000-8000-000000000002',
      launchToken: 'tok2',
    });
    check('2.4 launch devuelve args con attach, --session y --username opencode',
      launchPlan.args.includes('attach') &&
      launchPlan.args.includes('--session') &&
      launchPlan.args.includes(validSessionId) &&
      launchPlan.args.includes('--username') &&
      launchPlan.args.includes('opencode'),
      show(launchPlan.args));

    await activeAdapter.dispose();
    await adapter.dispose();
  }

  // ---------------------------------------------------------------------------
  // 3. startupHistoryNote
  // ---------------------------------------------------------------------------
  {
    const emptyHome = path.join(tempDir, 'home-empty');
    await mkdir(emptyHome, { recursive: true });
    const adapterEmpty = createGenCodeAdapter({ home: emptyHome, platform: 'linux' });
    check('3.1 base ausente: startupHistoryNote devuelve null', adapterEmpty.startupHistoryNote(false) === null);
    await adapterEmpty.dispose();

    const withDbHome = path.join(tempDir, 'home-with-db');
    const dbDir = path.join(withDbHome, '.local', 'share', 'gencode');
    await mkdir(dbDir, { recursive: true });
    const dbFile = path.join(dbDir, 'opencode.db');
    await writeFile(dbFile, '');

    const adapterWithDb = createGenCodeAdapter({ home: withDbHome, platform: 'linux' });
    check('3.2 base presente: startupHistoryNote devuelve ruta (read-only)',
      adapterWithDb.startupHistoryNote(false) === `${dbFile} (read-only)`,
      adapterWithDb.startupHistoryNote(false));
    await adapterWithDb.dispose();

    const adapterUnavailable = createGenCodeAdapter({
      home: withDbHome,
      platform: 'linux',
      sqlite: () => ({ unavailable: 'Node sin node:sqlite' }),
    });
    const unavNote = adapterUnavailable.startupHistoryNote(true);
    check('3.3 sqlite no disponible: menciona el aviso y la etiqueta GenCode',
      unavNote !== null && unavNote.includes('GenCode') && unavNote.includes('not read:'),
      unavNote);
    await adapterUnavailable.dispose();

    const customConfig = {
      ...GENCODE_FAMILY_CONFIG,
      startupHistoryNote: (cliAvailable) => `custom note: ${cliAvailable}`,
    };
    const adapterCustom = createOpenCodeFamilyAdapter(customConfig, { home: withDbHome, platform: 'linux' });
    check('3.4 config.startupHistoryNote tiene prioridad',
      adapterCustom.startupHistoryNote(true) === 'custom note: true');
    await adapterCustom.dispose();
  }

  // ---------------------------------------------------------------------------
  // 4. protectedDirs
  // ---------------------------------------------------------------------------
  {
    const dummyHome = '/home/testuser';
    const adapter = createGenCodeAdapter({ home: dummyHome, platform: 'linux' });
    const dirs = adapter.protectedDirs();
    check('4.1 protectedDirs devuelve 4 carpetas', dirs.length === 4);
    check('4.2 todas las carpetas están bajo gencode', dirs.every((d) => d.includes('gencode')));
    check('4.3 ninguna carpeta contiene opencode en su nombre', dirs.every((d) => !d.includes('/opencode')));
    await adapter.dispose();
  }

  // ---------------------------------------------------------------------------
  // 5. Lectura aislada de historial con fixture sintético de GenCode (scan y follow)
  // ---------------------------------------------------------------------------
  {
    const gcHome = path.join(tempDir, 'gc-home');
    const gcDataDir = path.join(gcHome, '.local', 'share', 'gencode');

    const fixture = await createOpenCodeFixture(gcDataDir, {
      sessions: [
        sessionRow({
          id: 'ses_gencode_101',
          directory: '/home/testuser/work/my-project',
          title: 'Sesión GenCode 101 de prueba',
          time_created: 1700000000000,
          time_updated: 1700000100000,
        }),
      ],
      messages: [
        {
          id: 'msg_gc_1',
          session_id: 'ses_gencode_101',
          time_created: 1700000010000,
          time_updated: 1700000010000,
          data: { role: 'user', time: { created: 1700000010000 } },
        },
        {
          id: 'msg_gc_2',
          session_id: 'ses_gencode_101',
          time_created: 1700000020000,
          time_updated: 1700000020000,
          data: { role: 'assistant', time: { created: 1700000020000 } },
        },
      ],
      parts: [
        {
          id: 'prt_gc_1',
          message_id: 'msg_gc_1',
          session_id: 'ses_gencode_101',
          time_created: 1700000011000,
          time_updated: 1700000011000,
          data: { type: 'text', text: 'Hola GenCode desde test' },
        },
        {
          id: 'prt_gc_2',
          message_id: 'msg_gc_2',
          session_id: 'ses_gencode_101',
          time_created: 1700000021000,
          time_updated: 1700000021000,
          data: { type: 'text', text: 'Respuesta generada por GenCode fixture' },
        },
      ],
    });

    const adapter = createGenCodeAdapter({ home: gcHome, platform: 'linux' });
    const items = await adapter.history.list();

    check('5.1 list encuentra 1 sesión', items?.length === 1);
    check('5.2 ref del item es ses_gencode_101', items?.[0]?.ref === 'ses_gencode_101');

    const scanned = await adapter.history.scan(items[0]);
    check('5.3 scan devuelve título y cwd esperados',
      scanned?.summary.title === 'Sesión GenCode 101 de prueba' &&
      scanned?.cwd === '/home/testuser/work/my-project');

    // follow
    const follower = adapter.history.follow({
      cwd: '/home/testuser/work/my-project',
      sessionId: 'ses_gencode_101',
    });

    await follower.start();
    const pollResult = await follower.poll();
    check('5.4 follower carga eventos con mensajes del fixture',
      pollResult.added.length === 2 &&
      pollResult.added[0]?.role === 'user' &&
      pollResult.added[0]?.parts[0]?.text === 'Hola GenCode desde test' &&
      pollResult.added[1]?.role === 'assistant' &&
      pollResult.added[1]?.parts[0]?.text === 'Respuesta generada por GenCode fixture');

    await adapter.dispose();
    fixture.close();
  }

  // ---------------------------------------------------------------------------
  // 6. Coexistencia e independencia con OpenCode
  // ---------------------------------------------------------------------------
  {
    const sharedHome = path.join(tempDir, 'shared-home');
    const ocDataDir = path.join(sharedHome, '.local', 'share', 'opencode');
    const gcDataDir = path.join(sharedHome, '.local', 'share', 'gencode');

    const ocFixture = await createOpenCodeFixture(ocDataDir, {
      sessions: [
        sessionRow({
          id: 'ses_opencode_only',
          directory: '/home/testuser/work/oc-project',
          title: 'Sesión exclusiva de OpenCode',
          time_created: 1600000000000,
          time_updated: 1600000000000,
        }),
      ],
    });

    const gcFixture = await createOpenCodeFixture(gcDataDir, {
      sessions: [
        sessionRow({
          id: 'ses_gencode_only',
          directory: '/home/testuser/work/gc-project',
          title: 'Sesión exclusiva de GenCode',
          time_created: 1700000000000,
          time_updated: 1700000000000,
        }),
      ],
    });

    const ocAdapter = createOpenCodeAdapter({ home: sharedHome, platform: 'linux' });
    const gcAdapter = createGenCodeAdapter({ home: sharedHome, platform: 'linux' });

    const ocItems = await ocAdapter.history.list();
    const gcItems = await gcAdapter.history.list();

    check('6.1 OpenCode list solo ve su sesión',
      ocItems?.length === 1 && ocItems[0]?.ref === 'ses_opencode_only');
    check('6.2 GenCode list solo ve su sesión',
      gcItems?.length === 1 && gcItems[0]?.ref === 'ses_gencode_only');
    check('6.3 Los historiales son completamente disjuntos',
      !ocItems?.some((s) => s.ref === 'ses_gencode_only') &&
      !gcItems?.some((s) => s.ref === 'ses_opencode_only'));

    const ocScanned = await ocAdapter.history.scan(ocItems[0]);
    const gcScanned = await gcAdapter.history.scan(gcItems[0]);

    check('6.4 scan independiente de cada CLI',
      ocScanned?.summary.title === 'Sesión exclusiva de OpenCode' &&
      gcScanned?.summary.title === 'Sesión exclusiva de GenCode');

    await ocAdapter.dispose();
    await gcAdapter.dispose();
    ocFixture.close();
    gcFixture.close();
  }

  // ---------------------------------------------------------------------------
  // 7. Agrupación de symlink y realpath en el mismo proyecto (review指摘 1)
  // ---------------------------------------------------------------------------
  {
    const realDir = path.join(tempDir, 'canonical-project');
    const linkDir = path.join(tempDir, 'symlink-project');
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir, 'dir');

    const sessions = [
      {
        agent: 'codex',
        group: 'g1',
        cwd: linkDir, // Codex u otra CLI usa ruta con symlink
        summary: {
          agent: 'codex',
          sessionId: 'ses_codex_link',
          cwd: linkDir,
          title: 'Sesión Codex con symlink',
          titleSource: 'user',
          updatedAt: 1000,
          sizeBytes: 100,
          archived: false,
          storage: 'native',
          partial: false,
          worktree: null,
        },
      },
      {
        agent: 'gencode',
        group: 'g2',
        cwd: realDir, // GenCode guarda ruta resuelta (realpath)
        summary: {
          agent: 'gencode',
          sessionId: 'ses_gencode_real',
          cwd: realDir,
          title: 'Sesión GenCode con realpath',
          titleSource: 'ai',
          updatedAt: 2000,
          sizeBytes: 200,
          archived: false,
          storage: 'native',
          partial: false,
          worktree: null,
        },
      },
    ];

    // canonicalOf simula lo que hace SessionIndex.learnSingleCwd (realpath de linkDir es realDir)
    const canonicalMap = (cwd) => (cwd === linkDir ? realDir : cwd);
    const projects = buildProjects(
      sessions,
      process.platform,
      () => null,
      () => null,
      canonicalMap,
    );

    check('7.1 symlink y realpath se agrupan en un único proyecto',
      projects.length === 1);
    check('7.2 el proyecto agrupado contiene ambas sesiones',
      projects[0]?.sessions.length === 2 &&
      projects[0]?.sessions.some((s) => s.sessionId === 'ses_codex_link') &&
      projects[0]?.sessions.some((s) => s.sessionId === 'ses_gencode_real'));

    const testRegistry = createAgentRegistry();
    const index = new SessionIndex(testRegistry);
    await index['learnCwd'](linkDir);
    check('7.3 SessionIndex aprende la ruta real del symlink',
      index['canonicalOf'](linkDir) === realDir,
      `canonicalOf(${linkDir}) = ${index['canonicalOf'](linkDir)}`);

    // 7.4 relocation con symlink y realpath unifica fromKey canónico en una sola entrada (review指摘 2)
    const relFromLink = path.join(tempDir, 'relocation-link');
    const relFromReal = path.join(tempDir, 'relocation-real');
    await mkdir(relFromReal, { recursive: true });
    await symlink(relFromReal, relFromLink, 'dir');
    const relTo = path.join(tempDir, 'relocation-target');
    await mkdir(relTo, { recursive: true });

    const relocatedSessions = [
      {
        agent: 'gencode',
        group: 'g3',
        cwd: relFromReal,
        summary: {
          agent: 'gencode',
          sessionId: 'ses_gc_rel_1',
          cwd: relFromReal,
          title: 'Relocated session 1 (real)',
          titleSource: 'ai',
          updatedAt: 3000,
          sizeBytes: 100,
          archived: false,
          storage: 'native',
          partial: false,
          worktree: null,
        },
      },
      {
        agent: 'codex',
        group: 'g4',
        cwd: relFromLink,
        summary: {
          agent: 'codex',
          sessionId: 'ses_cdx_rel_2',
          cwd: relFromLink,
          title: 'Relocated session 2 (symlink)',
          titleSource: 'user',
          updatedAt: 3100,
          sizeBytes: 120,
          archived: false,
          storage: 'native',
          partial: false,
          worktree: null,
        },
      },
    ];

    const relProjects = buildProjects(
      relocatedSessions,
      process.platform,
      () => null,
      (cwd) => {
        if (cwd === relFromReal) return { from: relFromReal, to: relTo, cwd: relTo, paused: false };
        if (cwd === relFromLink) return { from: relFromLink, to: relTo, cwd: relTo, paused: false };
        return null;
      },
      (cwd) => (cwd === relFromLink ? relFromReal : cwd),
    );
    check('7.4 relocation con symlink y realpath unifica fromKey canónico en una sola entrada con 2 sesiones',
      relProjects.length === 1 &&
      relProjects[0]?.sessions.length === 2 &&
      relProjects[0]?.relocations?.length === 1 &&
      relProjects[0]?.relocations?.[0]?.sessions === 2,
      show(relProjects[0]?.relocations));

    // 7.5 SessionIndex resuelve relocation registrada con symlink para carpetas en realpath (review指摘 3)
    const fakeStore = {
      resolve: (cwd) => {
        if (cwd === relFromLink) return { cwd: relTo, location: { from: relFromLink, to: relTo, createdAt: 1000 } };
        return null;
      },
    };
    const indexWithLocations = new SessionIndex(testRegistry, undefined, undefined, undefined, fakeStore);
    await indexWithLocations['learnCwd'](relFromLink);
    await indexWithLocations['learnCwd'](relFromReal);
    const resolvedForReal = indexWithLocations['resolveLocation'](relFromReal);
    const relocateForReal = indexWithLocations['relocateOf'](relFromReal);
    check('7.5 SessionIndex resuelve relocation para realpath aunque esté registrada con symlink',
      resolvedForReal !== null && resolvedForReal.cwd === relTo &&
      relocateForReal !== null && relocateForReal.from === relFromLink && relocateForReal.to === relTo,
      show({ resolvedForReal, relocateForReal }));

    // 7.5b SessionIndex resuelve relocation con orden inverso (real -> link): el cache nulo se invalida y relocateOf funciona
    const indexReverse = new SessionIndex(testRegistry, undefined, undefined, undefined, fakeStore);
    await indexReverse['learnCwd'](relFromReal);
    check('7.5b learnCwd(real) solo sin alias no resuelve relocation aún',
      indexReverse['relocateOf'](relFromReal) === null);
    await indexReverse['learnCwd'](relFromLink);
    const resolvedReverse = indexReverse['resolveLocation'](relFromReal);
    const relocateReverse = indexReverse['relocateOf'](relFromReal);
    check('7.5b SessionIndex resuelve relocation para realpath cuando se aprendió realpath primero (real -> link)',
      resolvedReverse !== null && resolvedReverse.cwd === relTo &&
      relocateReverse !== null && relocateReverse.from === relFromLink && relocateReverse.to === relTo,
      show({ resolvedReverse, relocateReverse }));
    indexReverse.dispose();

    for (const { adapter } of testRegistry.all()) {
      await adapter.dispose?.();
    }
    indexWithLocations.dispose();
  }

  // ---------------------------------------------------------------------------
  // 8. Aislamiento de entorno en registry: serveEnv, cleanTerminalEnv y missingMessage (review指摘 2, 3, 5)
  // ---------------------------------------------------------------------------
  {
    const contaminatedEnv = {
      ...process.env,
      OPENCODE_DB: '/tmp/injected-opencode.db',
      OPENCODE_MODELS_PATH: '/tmp/injected-models.json',
      OPENCODE_MODELS_URL: 'http://example.com/models',
      OPENCODE_SERVER_PASSWORD: 'super-secret-password',
      OPENCODE_SERVER_USERNAME: 'injected-user',
      OPENCODE_PASSWORD: 'another-secret',
    };

    const registry = createAgentRegistry();

    const gencode = registry.adapter('gencode');

    // 8.1 Verificamos missingMessage (review指摘 5)
    const missing = gencode.missingMessage();
    const expectedMissingText = 'GenCode CLI ("gencode") was not found in PATH. Please install "gencode" and ensure it is available in your PATH (official site: https://www.genspark.ai).';
    check('8.1 missingMessage devuelve mensaje claro para GenCode',
      missing.key === 'raw' &&
      missing.params?.['text'] === expectedMissingText,
      JSON.stringify(missing));

    // 8.2 Verificamos cleanTerminalEnv directamente desde GENCODE_FAMILY_CONFIG
    const testTerminalEnv = {
      OPENCODE_DB: '/tmp/opencode.db',
      OPENCODE_MODELS_PATH: '/tmp/models.json',
      OPENCODE_MODELS_URL: 'http://foo.bar',
      OPENCODE_SERVER_PASSWORD: 'pass',
      OPENCODE_SERVER_USERNAME: 'user',
      OPENCODE_PASSWORD: 'pwd',
      PATH: '/usr/bin',
    };
    GENCODE_FAMILY_CONFIG.cleanTerminalEnv?.(testTerminalEnv);
    check('8.2 cleanTerminalEnv elimina todas las variables OPENCODE_* de configuración',
      testTerminalEnv['PATH'] === '/usr/bin' &&
      testTerminalEnv['OPENCODE_DB'] === undefined &&
      testTerminalEnv['OPENCODE_MODELS_PATH'] === undefined &&
      testTerminalEnv['OPENCODE_MODELS_URL'] === undefined &&
      testTerminalEnv['OPENCODE_SERVER_PASSWORD'] === undefined &&
      testTerminalEnv['OPENCODE_SERVER_USERNAME'] === undefined &&
      testTerminalEnv['OPENCODE_PASSWORD'] === undefined);

    // 8.4 - 8.7 Verificamos que serveEnv de GenCode elimina OPENCODE_DB a través de registry (review指摘 2)
    const fakeServePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-opencode-serve.mjs');
    const fakeLoc = {
      resolvedPath: process.execPath,
      file: process.execPath,
      prefixArgs: [fakeServePath],
      version: '1.19.3-gencode.6',
    };

    const origEnv = process.env;
    try {
      process.env = {
        ...origEnv,
        OPENCODE_DB: '/tmp/leak-opencode.db',
        OPENCODE_MODELS_PATH: '/tmp/leak-models.json',
        OPENCODE_MODELS_URL: 'http://leak-models.test',
        SAFE_CUSTOM_VAR: 'safe-value',
      };
      const leakRegistry = createAgentRegistry();
      const leakGenCode = leakRegistry.adapter('gencode');
      const leakOpenCode = leakRegistry.adapter('opencode');

      // Obtenemos el serveEnv resuelto a través de registry.composedEnvironment
      const gcEnv = leakGenCode['_serveEnv']();

      check('8.4 GenCode serveEnv a través de registry elimina OPENCODE_DB',
        gcEnv['OPENCODE_DB'] === undefined, show(gcEnv['OPENCODE_DB']));
      check('8.5 GenCode serveEnv a través de registry elimina OPENCODE_MODELS_*',
        gcEnv['OPENCODE_MODELS_PATH'] === undefined && gcEnv['OPENCODE_MODELS_URL'] === undefined);
      check('8.6 GenCode serveEnv conserva variables seguras',
        gcEnv['SAFE_CUSTOM_VAR'] === 'safe-value');

      const ocEnv = leakOpenCode['_serveEnv']();
      check('8.7 OpenCode serveEnv conserva OPENCODE_DB (comportamiento original)',
        ocEnv['OPENCODE_DB'] === '/tmp/leak-opencode.db');

      for (const { adapter } of leakRegistry.all()) {
        await adapter.dispose?.();
      }
    } finally {
      process.env = origEnv;
    }

    // 8.8 - 8.9 Verificamos beforeLaunch con GenCode y OpenCode (review指摘 4)
    const fakeLaunchInput = {
      location: fakeLoc,
      cwd: tempDir,
      project: null,
      terminalId: 't1',
    };
    const gcTermEnv = {
      OPENCODE_DB: '/tmp/test.db',
      OPENCODE_MODELS_PATH: '/tmp/models.json',
      OPENCODE_SERVER_PASSWORD: 'secret-pass',
      OPENCODE_PASSWORD: 'secret-pass',
      TERM: 'xterm-256color',
    };
    await gencode.beforeLaunch(fakeLaunchInput, gcTermEnv);
    check('8.8 GenCode beforeLaunch elimina variables OPENCODE_* de terminalEnv',
      gcTermEnv['TERM'] === 'xterm-256color' &&
      gcTermEnv['OPENCODE_DB'] === undefined &&
      gcTermEnv['OPENCODE_MODELS_PATH'] === undefined &&
      gcTermEnv['OPENCODE_SERVER_PASSWORD'] === undefined &&
      gcTermEnv['OPENCODE_PASSWORD'] === undefined);

    const ocTermEnv = {
      OPENCODE_DB: '/tmp/test.db',
      TERM: 'xterm-256color',
    };
    const ocLaunchInput = {
      location: { ...fakeLoc, version: '1.0.0' },
      cwd: tempDir,
      project: null,
      terminalId: 't2',
    };
    const opencodeAdapter = registry.adapter('opencode');
    await opencodeAdapter.beforeLaunch(ocLaunchInput, ocTermEnv);
    check('8.9 OpenCode beforeLaunch mantiene OPENCODE_DB',
      ocTermEnv['OPENCODE_DB'] === '/tmp/test.db' && ocTermEnv['TERM'] === 'xterm-256color');

    for (const { adapter } of registry.all()) {
      await adapter.dispose?.();
    }
  }

} finally {
  await rm(tempDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} FALLO(S)`);
  process.exit(1);
} else {
  console.log('\nTODO OK');
}
