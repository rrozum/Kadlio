export function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
export function notFound(message = 'Презентация не найдена') {
  const error = new Error(message);
  error.status = 404;
  return error;
}
export function conflict(message = 'Слайд уже изменён. Обновите его и согласуйте правки.') {
  const error = new Error(message);
  error.status = 409;
  return error;
}
