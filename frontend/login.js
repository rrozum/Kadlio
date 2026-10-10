import { navigate } from './modules/navigation.js';
import { initTheme } from './modules/theme.js';
export async function mount(scope) {
  const document = scope.document;
  const form = document.querySelector('#login-form'),
    password = document.querySelector('#password'),
    show = document.querySelector('#show-password');
  show.addEventListener('click', () => {
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    show.setAttribute('aria-pressed', String(visible));
    show.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = document.querySelector('#submit'),
      error = document.querySelector('#login-error');
    submit.disabled = true;
    error.textContent = '';
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.value.trim(), password: password.value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось войти.');
      const next = new URLSearchParams(location.search).get('next');
      navigate(
        next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/',
      );
    } catch (cause) {
      error.textContent = cause.message;
      submit.disabled = false;
    }
  });

  initTheme(document.getElementById('theme-toggle'));
}
