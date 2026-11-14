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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createGenCodeAdapter,
  createOpenCodeAdapter,
  createOpenCodeFamilyAdapter,
  GENCODE_FAMILY_CONFIG,
  GENCODE_CAPABILITIES_PHASE5,
  GENCODE_INPUT,
} from '../src/agents/opencode/index.ts';
import { createOpenCodeFixture, FIXTURE_PROJECT_ID, sessionRow } from './fixtures/opencode-db.mjs';

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

    check('1.5 capabilities de Fase 5 todas false/null', same(adapter.capabilities, {
      sessionIdAtLaunch: false,
      resume: false,
      statusSource: false,
      readySignal: false,
      permissionCycle: null,
      codexPermissions: false,
      models: null,
      efforts: null,
      questionCards: false,
      imagesByPath: null,
      fileMentions: null,
      rewind: false,
      contextWindowSource: null,
      plans: false,
      waitingBlocksSubmit: false,
      forceSend: false,
      editQueue: false,
      scheduledSend: false,
      codexNativeQueue: false,
      moveToWorktree: false,
      readOnlyLaunch: null,
    }), show(adapter.capabilities));

    check('1.6 input con imageReference null y quoted-path', same(adapter.input, {
      imageReference: null,
      pieceGapMs: 400,
      pasteMarkers: true,
      enterSeparately: true,
      interruptPresses: 2,
      transcriptReference: 'quoted-path',
    }), show(adapter.input));

    check('1.7 promptQueue desde session', same(adapter.promptQueue, { source: 'session', forceSend: null }));
    check('1.8 sessionMove no definida en Fase 5', adapter.sessionMove === undefined);
    check('1.9 scheduled no definido en Fase 5', adapter.scheduled === undefined);

    await adapter.dispose();
  }

  // ---------------------------------------------------------------------------
  // 2. Bloqueo estricto de locate() y launch() en Fase 5 (historyOnly: true)
  // ---------------------------------------------------------------------------
  {
    const adapter = createGenCodeAdapter({ home: tempDir, platform: 'linux' });

    const located = await adapter.locate();
    check('2.1 locate devuelve null en Fase 5', located === null);

    let rejected = false;
    try {
      await adapter.launch({
        location: { resolvedPath: '/usr/bin/gencode', file: 'gencode', prefixArgs: [], version: '1.19.3' },
        cwd: tempDir,
        resumeSessionId: null,
        proposedSessionId: '00000000-0000-4000-8000-000000000001',
        launchToken: 'tok1',
      });
    } catch (e) {
      rejected = e instanceof Error && e.message.includes('GenCode launch is disabled in Phase 5');
    }
    check('2.2 launch rechaza con error explícito de Fase 5', rejected);

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

} finally {
  await rm(tempDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} FALLO(S)`);
  process.exit(1);
} else {
  console.log('\nTODO OK');
}
