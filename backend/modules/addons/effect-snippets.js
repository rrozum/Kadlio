import { validateSlideScript, validateOptions } from '../../engine/html/runtime-validation.js';
export {
  validateSlideScript,
  validateElementEffects,
} from '../../engine/html/runtime-validation.js';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { badRequest } from '../../engine/errors.js';

const validId = /^[\w-]{1,100}$/;
const missing = () => Object.assign(new Error('Эффект не найден.'), { status: 404 });
async function atomic(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
const initial = [
  {
    id: 'none',
    name: 'Без анимации',
    description: 'Пустой исходник для собственного эффекта.',
    code: '// Добавьте эффект для element; завершение и отмена — через onCleanup.\n',
    defaults: {},
  },
  {
    id: 'fade',
    name: 'Растворение',
    description: 'Плавное появление выбранного элемента.',
    code: "return element.animate([{opacity:0},{opacity:1}],{duration:params.duration||600,fill:'forwards'});",
    defaults: { duration: 600 },
  },
  {
    id: 'zoom',
    name: 'Масштаб',
    description: 'Появление с увеличением до сохранённого размера.',
    code: "return element.animate([{scale:.88,opacity:0},{scale:1,opacity:1}],{duration:params.duration||600,easing:'ease-out',fill:'forwards'});",
    defaults: { duration: 600 },
  },
  {
    id: 'blur',
    name: 'Из размытия',
    description: 'Размытие сменяется чётким элементом.',
    code: "return element.animate([{filter:'blur(18px)',opacity:0},{filter:'blur(0)',opacity:1}],{duration:params.duration||600,fill:'forwards'});",
    defaults: { duration: 600 },
  },
  {
    id: 'pop',
    name: 'Упругое появление',
    description: 'Появление с небольшим отскоком.',
    code: "return element.animate([{scale:.7,opacity:0},{scale:1.06,opacity:1,offset:.75},{scale:1,opacity:1}],{duration:params.duration||650,easing:'ease-out',fill:'forwards'});",
    defaults: { duration: 650 },
  },
  {
    id: 'stagger',
    name: 'По очереди',
    description: 'Последовательное появление детей элемента; одиночный блок появляется целиком.',
    code: "const nodes=element.children.length?[...element.children]:[element];const animations=nodes.map((node,index)=>node.animate([{translate:'0 30px',opacity:0},{translate:'0 0',opacity:1}],{duration:params.duration||500,delay:index*(params.delay||90),easing:'ease-out',fill:'both'}));onCleanup(()=>animations.forEach(animation=>animation.cancel()));",
    defaults: { duration: 500, delay: 90 },
  },
  {
    id: 'slide',
    name: 'Въезд слева',
    description: 'Блок появляется из-за левого края слайда.',
    code: "return element.animate([{translate:'-1400px 0',opacity:0},{translate:'0 0',opacity:1}],{duration:params.duration||800,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});",
    defaults: { duration: 800 },
  },
  {
    id: 'enter-right',
    name: 'Въезд справа',
    description: 'Блок появляется из-за правого края слайда.',
    code: "return element.animate([{translate:'1400px 0',opacity:0},{translate:'0 0',opacity:1}],{duration:params.duration||800,easing:'cubic-bezier(.22,1,.36,1)',fill:'forwards'});",
    defaults: { duration: 800 },
  },
  {
    id: 'rise',
    name: 'Появление снизу',
    description: 'Небольшой подъём с растворением.',
    code: "return element.animate([{translate:'0 80px',opacity:0},{translate:'0 0',opacity:1}],{duration:params.duration||650,easing:'ease-out',fill:'forwards'});",
    defaults: { duration: 650 },
  },
  {
    id: 'offcanvas-to-slide',
    name: 'На слайд из-за границы',
    description: 'Перемещает блок из его сохранённой позиции в заданную точку.',
    code: "const rect=element.getBoundingClientRect(); return element.animate([{translate:'0 0'},{translate:(Number(params.x)-rect.x)+'px '+(Number(params.y)-rect.y)+'px'}],{duration:params.duration||800,easing:'ease-out',fill:'forwards'});",
    defaults: { x: 100, y: 160, duration: 800 },
  },
];

export class EffectSnippetStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'effect-snippets');
    this.queue = Promise.resolve();
  }
  file(id) {
    if (typeof id !== 'string' || !validId.test(id)) throw missing();
    return path.join(this.root, id + '.json');
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await readdir(this.root)).some((name) => name.endsWith('.json')))
      for (const item of initial)
        await atomic(this.file(item.id), {
          ...item,
          version: 0,
          createdAt: new Date().toISOString(),
        });
    return this;
  }
  async get(id) {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw missing();
      throw error;
    }
  }
  async list() {
    return Promise.all(
      (await readdir(this.root))
        .filter((name) => /^[\w-]+\.json$/.test(name))
        .map((name) => this.get(name.slice(0, -5))),
    );
  }
  checked(payload) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).some((key) => !['name', 'description', 'code', 'defaults'].includes(key))
    )
      throw badRequest('Некорректные поля JS-эффекта.');
    const { name, description = '', code, defaults = {} } = payload;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      typeof description !== 'string' ||
      description.length > 500
    )
      throw badRequest('Укажите название эффекта до 100 символов.');
    if (typeof code !== 'string') throw badRequest('Укажите исходный JS эффекта.');
    validateSlideScript(code);
    // Кроме контекста слайда эффект получает свой element и параметры params.
    try {
      new Script(
        'async function elementEffect({element,slide,params,signal,onCleanup}){\n' + code + '\n}',
      );
    } catch (error) {
      throw badRequest('Ошибка синтаксиса JS: ' + error.message);
    }
    return { name: name.trim(), description, code, defaults: validateOptions(defaults) };
  }
  run(callback) {
    const operation = this.queue.catch(() => {}).then(callback);
    this.queue = operation.catch(() => {});
    return operation;
  }
  create(payload) {
    return this.run(async () => {
      if ((await this.list()).length >= 200)
        throw badRequest('В библиотеке максимум 200 JS-эффектов.');
      const value = {
        ...this.checked(payload),
        id: randomUUID(),
        version: 0,
        createdAt: new Date().toISOString(),
      };
      await atomic(this.file(value.id), value);
      return value;
    });
  }
  update(id, payload) {
    return this.run(async () => {
      if (
        !payload ||
        Object.keys(payload).some(
          (key) => !['name', 'description', 'code', 'defaults', 'version'].includes(key),
        ) ||
        !Number.isInteger(payload.version)
      )
        throw badRequest('Необходима версия эффекта.');
      const current = await this.get(id);
      if (current.version !== payload.version)
        throw Object.assign(new Error('Эффект изменился. Прочитайте его заново.'), { status: 409 });
      const { version, ...changes } = payload,
        { id: ignored, createdAt, updatedAt, version: previous, ...fields } = current;
      const saved = {
        ...this.checked({ ...fields, ...changes }),
        id,
        createdAt,
        updatedAt: new Date().toISOString(),
        version: version + 1,
      };
      await atomic(this.file(id), saved);
      return saved;
    });
  }
}
