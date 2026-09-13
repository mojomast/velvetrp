import { VoiceService } from '../../src/voice/service.js';
// Isolated crash-recovery fixture: deliberately leave a real pending provider call.
const service = new VoiceService(process.argv[2]!, {
  authorize: () => {}, list: () => [],
  resolve: () => ({ kind: 'dm', id: 's', text: 'Original public.', sessionId: 'room', revision: '1' }),
  speakers: () => [{ id: 'narrator', label: 'Narrator' }],
}, { timeoutMs: 60_000, voices: [{ id: 'v', label: 'V', language: 'en', seed: 1, instruct: 'Synthetic', revision: '1', model: 'test' }] },
async () => new Promise<Buffer>(() => {}));
service.cast('c', 'narrator', 'v', 0);
const job = service.play('c', 'dm', 's');
process.send?.({ id: job.id });
setInterval(() => {}, 1000);
