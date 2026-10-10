import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Короткий отдельный процесс держит аудио только во временном каталоге.
// Пока диктовка не используется, модель распознавания не занимает память.
export function createTranscriber({
  command = process.env.WHISPER_COMMAND,
  model = process.env.WHISPER_MODEL,
  temporaryDir = os.tmpdir(),
  timeoutMs = 90_000,
} = {}) {
  let busy = false,
    active = null;
  const status = async () => {
    let available = false;
    if (command && model && path.isAbsolute(command) && path.isAbsolute(model))
      try {
        await access(command, constants.X_OK);
        await access(model, constants.R_OK);
        available = true;
      } catch {}
    return { available, mode: 'local', maxSeconds: 60 };
  };
  return {
    status,
    async transcribe(payload, { signal } = {}) {
      if (busy) throw fail('Распознавание уже выполняется. Дождитесь завершения.', 429);
      const audio = validateAudio(payload);
      busy = true;
      let directory;
      try {
        if (!(await status()).available)
          throw fail('Распознавание речи на сервере пока недоступно.', 503);
        signal?.throwIfAborted();
        directory = await mkdtemp(path.join(temporaryDir, 'presentation-voice-'));
        const input = path.join(directory, 'audio.wav'),
          output = path.join(directory, 'transcript');
        await writeFile(input, audio, { mode: 0o600 });
        await execute(
          command,
          [
            '--model',
            model,
            '--file',
            input,
            '--language',
            payload.language || 'ru',
            '--threads',
            '2',
            '--output-txt',
            '--output-file',
            output,
            '--no-prints',
          ],
          {
            signal,
            timeoutMs,
            onChild: (child) => {
              active = child;
            },
          },
        );
        const text = (await readFile(output + '.txt', 'utf8')).trim();
        if (text.length > 50_000) throw fail('Результат распознавания слишком большой.', 502);
        return { text };
      } finally {
        active = null;
        busy = false;
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
    close() {
      active?.kill('SIGKILL');
    },
  };
}

export function validateAudio(payload) {
  if (
    !payload ||
    payload.mime !== 'audio/wav' ||
    typeof payload.data !== 'string' ||
    payload.data.length > 2_700_000 ||
    payload.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data) ||
    !['ru', 'en', undefined].includes(payload.language)
  )
    throw fail('Ожидается короткая WAV-запись речи.');
  const bytes = Buffer.from(payload.data, 'base64');
  // Браузер записывает строго этот PCM WAV. Другие контейнеры и кодеки
  // отклоняем до запуска нативного декодера.
  if (
    bytes.length < 44 ||
    bytes.length > 2_000_000 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.toString('ascii', 12, 16) !== 'fmt ' ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 16000 ||
    bytes.readUInt32LE(28) !== 32000 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString('ascii', 36, 40) !== 'data' ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.readUInt32LE(40) !== bytes.length - 44
  )
    throw fail('Неверный формат WAV: требуется PCM 16 кГц, моно, 16 бит.');
  const seconds = (bytes.length - 44) / 32000;
  if (seconds < 0.1 || seconds > 60.1 || (bytes.length - 44) % 2 !== 0)
    throw fail('Запишите от 0,1 до 60 секунд речи.');
  return bytes;
}

function execute(command, args, { signal, timeoutMs, onChild }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    onChild(child);
    let timedOut = false;
    const abort = () => child.kill('SIGKILL');
    const timer = setTimeout(
      () => {
        timedOut = true;
        abort();
      },
      Math.min(timeoutMs, 90_000),
    );
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    child.once('error', () => finish(fail('Не удалось запустить распознавание речи.', 503)));
    child.once('close', (code) =>
      finish(
        timedOut
          ? fail('Распознавание заняло слишком много времени. Запишите фразу короче.', 504)
          : signal?.aborted
            ? signal.reason
            : code !== 0
              ? fail('Не удалось распознать запись. Попробуйте ещё раз.', 502)
              : null,
      ),
    );
  });
}
