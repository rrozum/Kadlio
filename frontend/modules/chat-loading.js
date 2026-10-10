// Empty state означает подтверждённую пустую историю, а не отсутствие ответа API.
// До этого сохраняем нейтральный loader и не показываем ложное «Подключите ИИ».
export function finishChatLoading(view, error) {
  const loading = view.getElementById('chat-loading');
  if (!loading) return;
  if (error) {
    loading.textContent = 'Не удалось загрузить чат';
    loading.setAttribute('role', 'alert');
    const provider = view.getElementById('provider-label');
    if (provider) provider.textContent = 'Чат не загружен';
  } else loading.hidden = true;
  view.getElementById('chat-panel')?.setAttribute('aria-busy', 'false');
  const messages = view.getElementById('chat-messages');
  if (messages) messages.hidden = false;
  const form = view.getElementById('chat-form');
  if (form) form.inert = false;
}
