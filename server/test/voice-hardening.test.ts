import Database from 'better-sqlite3';
import { once } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceService, type Source, type Synthesizer } from '../src/voice/service.js';

const config = { timeoutMs: 1000, voices: [{ id: 'v', label: 'V', language: 'en', seed: 1, instruct: 'Synthetic', revision: '1', model: 'test' }] };
function fixture(synthesize: Synthesizer = async () => Buffer.from('audio')) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-hardening-'));
  const path = join(dir, 'voice.sqlite');
  const source: Source = { kind: 'dm', id: 's', text: 'Original public.', sessionId: 'room', revision: '1' };
  const reader = { authorize: () => {}, list: () => [], resolve: () => source,
    speakers: () => [{ id: 'narrator', label: 'Narrator' }, { id: 'npc:a', label: 'A' }] };
  const service = new VoiceService(path, reader, config, synthesize);
  service.cast('c', 'narrator', 'v', 0);
  return { service, source, reader, path, cleanup: () => { service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('exclusive sidecar ownership (review 2)', () => {
  it('rejects a second connection without cancelling live work, including closing in-flight work', async () => {
    let finish!: (audio: Buffer) => void;
    let calls = 0;
    const f = fixture(async () => { calls++; return new Promise<Buffer>(resolve => { finish = resolve; }); });
    let second: VoiceService | undefined;
    try {
      const job = f.service.play('c', 'dm', 's');
      expect(() => { second = new VoiceService(f.path, f.reader, config, async () => { calls++; return Buffer.from('other'); }); }).toThrow(/owner|use/i);
      expect(f.service.job('c', job.id).state).toBe('pending');
      expect(calls).toBe(1);
      f.service.close();
      expect(() => { second = new VoiceService(f.path, f.reader, config, async () => Buffer.from('other')); }).toThrow(/owner|use/i);
      finish(Buffer.from('late')); await tick();
      second = new VoiceService(f.path, f.reader, config, async () => Buffer.from('other'));
      expect(second.job('c', job.id).state).toBe('cancelled');
    } finally { finish?.(Buffer.from('late')); await tick(); second?.close(); f.cleanup(); }
  });

  it('excludes a different process and recovers genuinely pending work after SIGKILL without replay', async () => {
    const { fork } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'voice-owner-crash-'));
    const path = join(dir, 'voice.sqlite');
    const child = fork(new URL('./fixtures/voiceOwnerProcess.ts', import.meta.url), [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let service: VoiceService | undefined;
    const reader = { authorize: () => {}, list: () => [], resolve: () => ({ kind: 'dm', id: 's', text: 'Original public.', sessionId: 'room', revision: '1' }), speakers: () => [{ id: 'narrator', label: 'Narrator' }] };
    try {
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) }) as [{ id: string }];
      expect(() => { service = new VoiceService(path, reader, config, async () => Buffer.from('duplicate')); }).toThrow(/owner|use/i);
      const observer = new Database(path);
      try { expect(observer.prepare('SELECT state FROM jobs WHERE id=?').get(message.id)).toEqual({ state: 'pending' }); } finally { observer.close(); }
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      let calls = 0;
      service = new VoiceService(path, reader, config, async () => { calls++; return Buffer.from('explicit'); });
      expect(service.job('c', message.id).state).toBe('cancelled');
      await tick(); expect(calls).toBe(0);
      const retry = service.play('c', 'dm', 's'); await tick();
      expect(service.job('c', retry.id).state).toBe('ready'); expect(calls).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
      service?.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('incoming quota reservations (review 3)', () => {
  for (const state of ['ready', 'pending']) {
    it(`makes room for incoming audio without deleting ${state} work incorrectly`, async () => {
      const f = fixture(async () => Buffer.alloc(2 * 1024 * 1024, 2));
      const db = (f.service as unknown as { db: Database.Database }).db;
      // Model a 127 MiB existing blob without a huge test allocation/file.
      db.function('length', (value: unknown) => value == null ? null : (value as Buffer)[0] === 1 ? 127 * 1024 * 1024 : (value as Buffer).length);
      try {
        db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)').run('occupied', 'c', '{}', 'old', 'old', state, Date.now(), -1);
        db.prepare('INSERT INTO segments VALUES(?,?,?,?,?,?,?)').run('occupied', 0, 'Old', 'narrator', '{}', 'ready', Buffer.from([1]));
        const job = f.service.play('c', 'dm', 's'); await tick();
        expect(f.service.job('c', job.id).state).toBe(state === 'ready' ? 'ready' : 'failed');
        expect(Boolean(db.prepare('SELECT id FROM jobs WHERE id=?').get('occupied'))).toBe(state === 'pending');
        if (state === 'pending') expect(db.prepare('SELECT audio FROM segments WHERE job=?').get('occupied')).toEqual({ audio: Buffer.from([1]) });
      } finally { f.cleanup(); }
    });
  }
  it('reserves exactly one incoming job and retains the full allowed count during synthesis', async () => {
    const f = fixture(); const db = (f.service as unknown as { db: Database.Database }).db;
    try {
      const insert = db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)');
      for (let i = 0; i < 128; i++) insert.run(`old-${i}`, 'c', '{}', 'old', 'old', 'ready', Date.now() - 1000 + i, 0);
      const job = f.service.play('c', 'dm', 's'); await tick();
      expect(f.service.job('c', job.id).state).toBe('ready');
      expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({ n: 128 });
      expect(db.prepare('SELECT id FROM jobs WHERE id=?').get('old-0')).toBeUndefined();
      expect(db.prepare('SELECT id FROM jobs WHERE id=?').get('old-1')).toEqual({ id: 'old-1' });
    } finally { f.cleanup(); }
  });
});

describe('voice failure isolation regressions (review 1)', () => {
  for (const failure of ['selection', 'prune', 'failed-state write'] as const) {
    it(`contains ${failure} database errors and requires restart instead of a hot retry`, async () => {
      let calls = 0;
      const f = fixture(async () => { calls++; if (failure === 'failed-state write') throw new Error('provider failed'); return Buffer.from('audio'); });
      const db = (f.service as unknown as { db: Database.Database }).db;
      const prepare = db.prepare.bind(db);
      let armed = failure === 'selection';
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if ((failure === 'selection' && sql.includes('SELECT j.*,s.position')) ||
            (failure === 'prune' && armed && sql.includes("state<>'pending' AND created")) ||
            (failure === 'failed-state write' && sql.includes("SET state='failed'"))) throw new Error('injected storage failure');
        return prepare(sql);
      });
      const unhandled: unknown[] = [];
      const listener = (error: unknown) => { unhandled.push(error); };
      process.on('unhandledRejection', listener);
      try {
        try { f.service.play('c', 'dm', 's'); } catch { /* Synchronous unavailable is also contained. */ }
        armed = true;
        await tick();
        expect(unhandled).toEqual([]);
        expect(() => f.service.play('c', 'dm', 's')).toThrow(/unavailable/i);
        expect(calls).toBe(failure === 'selection' ? 0 : 1);
        expect(f.source.text).toBe('Original public.');
      } finally { process.off('unhandledRejection', listener); spy.mockRestore(); f.cleanup(); }
    });
  }
});
