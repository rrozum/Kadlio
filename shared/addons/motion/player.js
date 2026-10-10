// Плеер управляет только изолированной сценой во фрейме. Код слайда не запускается
// в DOM редактора или просмотрщика; команды сцены не дают доступ к хранилищу.
export function playRuntime(
  section,
  { url, html, sceneId = section.id, onError = () => {}, onNavigate = () => {} } = {},
) {
  stopRuntime(section);
  const frame = document.createElement('iframe');
  frame.className = 'slide-runtime-frame';
  frame.title = 'Интерактивный слайд';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute(
    'allow',
    "autoplay *; camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
  );
  let readyFrame;
  const receive = (event) => {
    if (event.source !== frame.contentWindow || event.data?.sceneId !== sceneId) return;
    if (event.data.type === 'presentation-runtime') {
      if (event.data.ready) {
        clearTimeout(timer);
        if (!readyFrame && !section.classList.contains('runtime-ready'))
          readyFrame = requestAnimationFrame(() => {
            readyFrame = requestAnimationFrame(() => {
              readyFrame = null;
              if (frame.isConnected && frame.parentElement === section)
                section.classList.add('runtime-ready');
            });
          });
      }
      if (Array.isArray(event.data.errors) && event.data.errors.length)
        onError(String(event.data.errors[0]).slice(0, 1000));
    }
    if (
      event.data.type === 'presentation-runtime-navigation' &&
      ['next', 'previous'].includes(event.data.command)
    )
      onNavigate(event.data.command);
  };
  const timer = setTimeout(
    () => onError('JS-сцена не ответила. Перезапустите предпросмотр.'),
    10000,
  );
  // Событие ready означает готовность DOM, но первый кадр ещё не нарисован.
  // Статичный слайд скрываем только после paint; Stop или перезапуск отменяют ожидание.
  addEventListener('message', receive);
  section.__runtimeCleanup = () => {
    clearTimeout(timer);
    cancelAnimationFrame(readyFrame);
    removeEventListener('message', receive);
    try {
      frame.contentWindow.postMessage(
        { type: 'presentation-runtime-control', sceneId, command: 'stop' },
        '*',
      );
    } catch {}
    frame.remove();
    section.classList.remove('runtime-ready');
  };
  if (html !== undefined) frame.srcdoc = html;
  else frame.src = url;
  section.append(frame);
  return frame;
}
export function stopRuntime(section) {
  section.__runtimeCleanup?.();
  delete section.__runtimeCleanup;
}
