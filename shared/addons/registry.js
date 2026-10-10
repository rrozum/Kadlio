// Реестр содержит описание возможностей. Исполняемые адаптеры подключаются
// явно в backend/application и frontend/addons — данные слайда их не создают.
export function createAddonRegistry(definitions) {
  const entries = new Map();
  for (const definition of definitions) {
    if (!definition || !/^[a-z][a-z0-9-]*$/.test(definition.id))
      throw new Error('Некорректный id дополнения.');
    if (entries.has(definition.id)) throw new Error('Повторный id дополнения: ' + definition.id);
    entries.set(
      definition.id,
      Object.freeze({
        ...definition,
        targets: Object.freeze([...(definition.targets || [])]),
        capabilities: Object.freeze([...(definition.capabilities || [])]),
      }),
    );
  }
  return Object.freeze({
    get(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error('Дополнение не подключено: ' + id);
      return entry;
    },
    has: (id) => entries.has(id),
    list: () => [...entries.values()],
  });
}
