import { onPageCleanup, pageTimeout } from './page-lifecycle.js';
const speechErrors = {
  'not-allowed': 'Разрешите доступ к микрофону в настройках браузера.',
  'audio-capture': 'Не удалось открыть микрофон. Проверьте его подключение.',
  'no-speech': 'Речь не обнаружена. Попробуйте ещё раз.',
  network: 'Сервис распознавания браузера недоступен.',
  'service-not-allowed': 'Распознавание речи в этом браузере недоступно.',
  'language-not-supported': 'Браузер не поддерживает распознавание русской речи.',
};

// Диктовка заполняет черновик сообщения. Отправка остаётся отдельным действием пользователя.
export function mountDictation({
  button,
  input,
  status,
  onError = () => {},
  environment = globalThis,
  fetchImpl = fetch,
}) {
  let state = 'idle',
    session = null,
    destroyed = false,
    serverAvailable = false,
    generation = 0;
  const Recognition = environment.SpeechRecognition || environment.webkitSpeechRecognition;
  const setState = (next, message = '') => {
    state = next;
    button.dataset.state = next;
    button.setAttribute('aria-pressed', String(next === 'recording'));
    button.title = next === 'recording' ? 'Остановить диктовку' : 'Продиктовать сообщение';
    button.setAttribute('aria-label', button.title);
    button.disabled = ['starting', 'processing'].includes(next);
    if (status) {
      status.textContent = message;
      status.dataset.state = next;
    }
  };
  const fail = (error) => {
    if (destroyed) return;
    setState('error', error.message);
    onError(error);
  };
  const ready = fetchImpl('/api/transcription/status', { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((value) => {
      serverAvailable = Boolean(value?.available);
    })
    .catch(() => {});
  async function finish(current) {
    if (current.finished) return current.promise;
    current.finished = true;
    clearTimeout(current.timer);
    setState('processing', 'Распознаю запись…');
    try {
      current.recognition?.stop();
    } catch {}
    current.stream?.getTracks().forEach((track) => track.stop());
    try {
      if (current.recorder) {
        await current.stopped;
      } else if (current.recognition) {
        let timer;
        try {
          await Promise.race([
            current.speechEnded,
            new Promise((resolve) => {
              timer = pageTimeout(resolve, 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      let text = current.finalText.join(' ').trim();
      if ((current.speechError || !text) && current.recorder && serverAvailable) {
        const blob = new Blob(current.chunks, { type: current.recorder.mimeType });
        if (!blob.size) throw new Error('Запись пуста. Попробуйте ещё раз.');
        const Context = environment.AudioContext || environment.webkitAudioContext,
          context = new Context();
        let wav;
        try {
          wav = encodeWav(await context.decodeAudioData(await blob.arrayBuffer()));
        } finally {
          await context.close();
        }
        const response = await fetchImpl('/api/transcription', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: bytesToBase64(wav), mime: 'audio/wav', language: 'ru' }),
          signal: current.controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Не удалось распознать запись.');
        text = String(result.text || '').trim();
      }
      if (!text)
        throw new Error(
          speechErrors[current.speechError] || 'Речь не обнаружена. Попробуйте ещё раз.',
        );
      if (!destroyed) {
        insertDictation(input, text);
        setState('idle', 'Текст добавлен. Его можно поправить перед отправкой.');
      }
      current.resolve(text);
      return text;
    } catch (error) {
      if (!current.controller.signal.aborted) fail(error);
      current.resolve('');
      return '';
    } finally {
      current.chunks = [];
      if (session === current) session = null;
    }
  }
  async function start() {
    const started = ++generation;
    setState('starting', 'Открываю микрофон…');
    await ready;
    if (destroyed || generation !== started) return;
    if (!Recognition && !serverAvailable) {
      fail(
        new Error('В этом браузере распознавание недоступно, а серверный сервис ещё не подключён.'),
      );
      return;
    }
    const current = {
      finalText: [],
      finalIndexes: new Set(),
      chunks: [],
      controller: new AbortController(),
      finished: false,
      speechError: null,
    };
    current.promise = new Promise((resolve) => {
      current.resolve = resolve;
    });
    session = current;
    try {
      const Recorder = environment.MediaRecorder;
      if (serverAvailable && Recorder && environment.navigator?.mediaDevices?.getUserMedia) {
        current.stream = await environment.navigator.mediaDevices.getUserMedia({ audio: true });
        if (destroyed || current.finished || session !== current) {
          current.stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) =>
          Recorder.isTypeSupported(type),
        );
        current.recorder = new Recorder(current.stream, mime ? { mimeType: mime } : {});
        current.stopped = new Promise((resolve) => {
          current.recorder.onstop = resolve;
        });
        current.recorder.ondataavailable = (event) => {
          if (event.data.size) current.chunks.push(event.data);
        };
        current.recorder.onerror = () => {
          current.speechError = 'audio-capture';
          stop();
        };
        current.recorder.start(250);
      }
      if (Recognition) {
        const recognition = new Recognition();
        current.recognition = recognition;
        recognition.lang = 'ru-RU';
        recognition.continuous = true;
        recognition.interimResults = true;
        current.speechEnded = new Promise((resolve) => {
          current.resolveSpeech = resolve;
        });
        recognition.onresult = (event) => {
          for (let index = event.resultIndex; index < event.results.length; index++) {
            const result = event.results[index],
              text = result[0].transcript;
            if (result.isFinal && !current.finalIndexes.has(index)) {
              current.finalIndexes.add(index);
              current.finalText.push(text);
            } else if (!result.isFinal && !current.finished)
              setState('recording', 'Слушаю… ' + text.slice(-90));
          }
        };
        recognition.onerror = (event) => {
          if (current.finished) return;
          current.speechError = event.error;
          if (current.recorder && !['not-allowed', 'audio-capture'].includes(event.error))
            setState('recording', 'Продолжайте говорить. Распознаю запись после остановки.');
          else stop();
        };
        recognition.onend = () => {
          current.resolveSpeech();
          if (!current.finished && (!current.speechError || !current.recorder)) stop();
        };
        try {
          recognition.start();
        } catch (error) {
          if (!current.recorder) throw error;
          current.speechError = 'service-not-allowed';
        }
      } else if (!current.recorder) throw new Error('Браузер не поддерживает запись с микрофона.');
      setState('recording', 'Слушаю… Нажмите микрофон ещё раз, чтобы закончить.');
      current.timer = pageTimeout(() => stop(), 59_000);
    } catch (error) {
      current.stream?.getTracks().forEach((track) => track.stop());
      session = null;
      current.resolve('');
      fail(
        new Error(error.name === 'NotAllowedError' ? speechErrors['not-allowed'] : error.message),
      );
    }
  }
  function stop() {
    const current = session;
    if (!current) {
      generation++;
      if (state === 'starting') setState('idle');
      return Promise.resolve('');
    }
    if (current.recorder?.state === 'recording') current.recorder.stop();
    return finish(current);
  }
  const click = () => {
    if (state === 'recording') stop();
    else if (!['starting', 'processing'].includes(state)) start();
  };
  button.addEventListener('click', click);
  setState('idle');
  const controls = {
    ready,
    stop,
    get state() {
      return state;
    },
    destroy() {
      destroyed = true;
      button.removeEventListener('click', click);
      if (session) {
        clearTimeout(session.timer);
        session.controller.abort();
        session.recognition?.abort();
        if (session.recorder?.state === 'recording') session.recorder.stop();
        session.stream?.getTracks().forEach((track) => track.stop());
        session.resolve('');
        session = null;
      }
    },
  };
  onPageCleanup(() => controls.destroy());
  return controls;
}

export function insertDictation(input, text) {
  const start = input.selectionStart ?? input.value.length,
    end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start),
    after = input.value.slice(end),
    suffix = after && !/^\s/.test(after) ? ' ' : '';
  input.setRangeText((before && !/\s$/.test(before) ? ' ' : '') + text + suffix, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

export function encodeWav(audio) {
  const count = Math.min(Math.floor((audio.length * 16000) / audio.sampleRate), 60 * 16000),
    bytes = new Uint8Array(44 + count * 2),
    view = new DataView(bytes.buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, count * 2, true);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  for (let i = 0; i < count; i++) {
    const source = (i * audio.sampleRate) / 16000,
      left = Math.floor(source),
      right = Math.min(left + 1, audio.length - 1),
      fraction = source - left;
    let sample = 0;
    for (const channel of channels)
      sample += (channel[left] * (1 - fraction) + channel[right] * fraction) / channels.length;
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return bytes;
}
function bytesToBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}
