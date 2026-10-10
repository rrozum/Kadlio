// Навигация доступна контроллерам без зависимости от точки сборки приложения.
let handler;
export function installNavigation(navigate) {
  handler = navigate;
}
export function navigate(url) {
  if (handler) return handler(url);
  // Встроенный редактор темы и публичный просмотрщик могут жить отдельно от SPA.
  location.assign(url);
}
